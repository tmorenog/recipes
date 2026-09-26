// The Pricer Agent's side of the coordinator, which keeps to its contract role:
// it serves the recipe to price, checks the cart the Pricer Agent built for
// it, works out the costs itself and stores the price. Searching Kroger and
// choosing products is the Pricer Agent's job: see lib/pricer.js.
import { z } from 'zod';
import { getStore } from './store/index.js';
import { priceShare } from './units.js';
import { photoAllowed, PHOTO_HOSTS } from './recipes.js';

const round2 = (x) => Math.round(x * 100) / 100;
const text = (max) => z.string().trim().min(1).max(max);
const mealId = text(100).describe('The meal_id of the recipe being priced');

export const recipeToPriceSchema = z.strictObject({ meal_id: mealId });

const productSchema = z.strictObject({
  id: text(80).describe('The Kroger product_id, or "estimate-<line>" for an estimate'),
  description: text(200),
  brand: z.string().max(100).nullish(),
  size: text(60).describe('The package size as Kroger gives it, e.g. "15.5 oz"'),
  price_usd: z.number().positive().max(500).describe('One package: the sale price when there is one'),
  on_sale: z.boolean().optional(),
  image_url: z.string().max(500).nullish(),
  estimated: z.boolean().optional(),
});
const pricedLineSchema = z.strictObject({
  line: z.number().int().min(1).max(60).describe('The ingredient line, from get_recipe_to_price'),
  status: z.enum(['bought', 'estimated', 'skipped']).describe('bought: a Kroger product; estimated: Kroger had none, so a typical price; skipped: not bought (e.g. water, or “to taste”)'),
  product: productSchema.optional().describe('For bought and estimated lines'),
  amount_used: z.number().positive().optional().describe('How much of the product the recipe uses, cooked for people'),
  unit_used: z.string().trim().max(20).optional().describe('g, kg, oz, lb, ml, l, tsp, tbsp, cup, fl oz or each'),
  grams: z.number().positive().nullish().describe('The weight in grams, when the unit is a count or volume and the package is sold by weight'),
  note: z.string().max(500).nullish(),
  reason: z.string().trim().max(300).optional().describe('Why it was estimated or skipped'),
  substitute_for: z.string().trim().max(300).nullish().describe('The recipe’s ingredient, when the product replaces it'),
});
export const pricingSchema = z.strictObject({
  meal_id: mealId,
  pricing_id: z.string().trim().min(1).max(100).describe('The pricing_id from get_recipe_to_price: it shows this run is still the one pricing the recipe'),
  people: z.number().int().min(1).max(10000).optional().describe('How many people the cart feeds'),
  summary: z.string().trim().max(1000).optional().describe('A short note on the cart, for the class'),
  lines: z.array(pricedLineSchema).max(60).optional().describe('One entry for every ingredient line'),
  could_not_price: z.string().trim().min(3).max(500).optional().describe('Instead of lines: why the recipe can’t be priced'),
});

const reasons = (error) => error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);

// Whole-recipe totals, computed from the basket. Packages are counted per
// product, so two lines using the same bag of onions buy it once.
export function totals(basket) {
  const bought = basket.filter((e) => e?.status === 'bought' || e?.status === 'estimated');
  const total = round2(bought.reduce((s, e) => s + e.cost_used_usd, 0));
  const byProduct = new Map();
  for (const e of bought) {
    const p = byProduct.get(e.product.id) ?? { fraction: 0, price: e.product.price_usd };
    p.fraction += e.fraction;
    byProduct.set(e.product.id, p);
  }
  const toBuy = round2([...byProduct.values()].reduce((s, p) => s + Math.max(1, Math.ceil(p.fraction - 1e-9)) * p.price, 0));
  return { total, toBuy, estimated: basket.filter((e) => e?.status === 'estimated').length };
}

// The recipe a Pricer run was given: its ingredient lines, numbered.
export async function recipeToPrice(input) {
  const parsed = recipeToPriceSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error) };
  const p = await getStore().pricingClaim(parsed.data.meal_id);
  if (!p?.recipe) return { ok: false, status: 404, errors: [`no recipe has meal_id ${parsed.data.meal_id}`] };
  if (p.status !== 'pricing' || !p.claim_token) return { ok: false, status: 409, errors: ['this recipe isn’t waiting for a price: the coordinator hands recipes to the Pricer Agent one at a time'] };
  const r = p.recipe;
  return {
    ok: true,
    recipe: {
      meal_id: p.meal_id,
      pricing_id: p.claim_token,
      name: r.name,
      est_servings: r.est_servings ?? null,
      lines: (r.ingredients || []).map((i, n) => ({ line: n + 1, ingredient: i.name, measure: i.raw || null })),
    },
  };
}

// Checks the Pricer Agent's cart, works out every cost from the products'
// prices and sizes, and stores the price. Only the run holding the recipe
// (pricing_id) can save it.
export async function savePricing(input) {
  const parsed = pricingSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error) };
  const d = parsed.data;
  const store = getStore();
  const p = await store.pricingClaim(d.meal_id);
  if (!p) return { ok: false, status: 404, errors: [`no recipe has meal_id ${d.meal_id}`] };
  if (p.status !== 'pricing' || p.claim_token !== d.pricing_id) {
    return { ok: false, status: 409, lost: true, errors: ['this run no longer holds the recipe (it was reset or another run took it over): stop, and don’t save'] };
  }

  if (d.could_not_price) {
    if (d.lines?.length) return { ok: false, status: 400, errors: ['send either lines or could_not_price, not both'] };
    const kept = await store.finishPricing(d.meal_id, { status: 'failed', error: d.could_not_price, token: d.pricing_id });
    if (!kept) return { ok: false, status: 409, lost: true, errors: ['this run no longer holds the recipe'] };
    return { ok: true, saved: { meal_id: d.meal_id, status: 'failed', error: d.could_not_price } };
  }

  if (!p.recipe) return { ok: false, status: 404, errors: ['the recipe was deleted: send could_not_price'] };
  const ingredients = p.recipe.ingredients || [];
  const errors = [];
  if (!d.people) errors.push('people: required: how many people the cart feeds');
  if (!d.lines?.length) errors.push('lines: required: one entry for every ingredient line, or could_not_price');
  if (errors.length) return { ok: false, status: 400, errors };

  const byLine = new Map();
  for (const [i, l] of d.lines.entries()) {
    if (l.line > ingredients.length) errors.push(`lines.${i}: the recipe has only ${ingredients.length} ingredient lines`);
    else if (byLine.has(l.line)) errors.push(`lines.${i}: line ${l.line} is priced twice`);
    else byLine.set(l.line, { l, i });
  }
  const missing = ingredients.map((_, n) => n + 1).filter((n) => !byLine.has(n));
  if (missing.length) errors.push(`these lines aren't in the cart: ${missing.join(', ')} (skip a line you don't buy, with a reason)`);

  const notes = [];
  const basket = [];
  for (const [line, { l, i }] of [...byLine].sort(([a], [b]) => a - b)) {
    const ing = ingredients[line - 1];
    const base = { line, ingredient: ing.name, raw: ing.raw ?? null };
    if (l.status === 'skipped') {
      if (!l.reason) errors.push(`lines.${i}: a skipped line needs a reason`);
      basket.push({ ...base, status: 'skipped', reason: l.reason ?? null, cost_used_usd: 0 });
      continue;
    }
    if (!l.product || !l.amount_used || !l.unit_used) {
      errors.push(`lines.${i}: a ${l.status} line needs product, amount_used and unit_used`);
      continue;
    }
    if (l.status === 'estimated' && !l.reason) errors.push(`lines.${i}: an estimated line needs a reason`);
    // The coordinator works out the share of a package and the costs itself.
    const share = priceShare({ amount: l.amount_used, unitName: l.unit_used, grams: l.grams, size: l.product.size, price: l.product.price_usd });
    if (share.error) {
      errors.push(`lines.${i}: ${share.error}`);
      continue;
    }
    let image = l.product.image_url ?? null;
    if (image && !photoAllowed(image, PHOTO_HOSTS.product)) {
      image = null;
      notes.push(`lines.${i}.product.image_url wasn’t a Kroger product photo, so it was left out`);
    }
    basket.push({
      ...base,
      status: l.status,
      product: {
        id: l.product.id, description: l.product.description, brand: l.product.brand ?? null, size: l.product.size,
        price_usd: l.product.price_usd, on_sale: Boolean(l.product.on_sale), image_url: image,
        ...(l.status === 'estimated' && { estimated: true }),
      },
      amount_used: l.amount_used,
      unit_used: l.unit_used,
      grams: l.grams ?? null,
      fraction: share.fraction,
      packages: share.packages,
      cost_used_usd: share.cost_used_usd,
      cost_to_buy_usd: share.cost_to_buy_usd,
      note: [share.note, l.note].filter(Boolean).join('; ') || null,
      ...(l.status === 'estimated' ? { reason: l.reason } : { substitute_for: l.substitute_for || null }),
    });
  }
  if (errors.length) return { ok: false, status: 400, errors };

  const t = totals(basket);
  const kept = await store.finishPricing(d.meal_id, {
    status: 'priced', summary: d.summary || 'Priced.', people: d.people, basket, total: t.total, toBuy: t.toBuy, token: d.pricing_id,
  });
  if (!kept) return { ok: false, status: 409, lost: true, errors: ['this run no longer holds the recipe'] };
  return {
    ok: true,
    saved: {
      meal_id: d.meal_id,
      status: 'priced',
      people: d.people,
      cost_per_serving_usd: round2(t.total / d.people),
      cost_used_usd: t.total,
      cart_usd: t.toBuy,
      estimated_lines: t.estimated,
      skipped_lines: basket.filter((e) => e.status === 'skipped').length,
    },
    basket,
    totals: t,
    ...(notes.length && { notes }),
  };
}
