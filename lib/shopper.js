// The Shopper Agent's side of the coordinator: the class's saved meal plans,
// the week's Kroger cart for one of them, and the class's choice.
// The Pricer and the Meal Planners work per person (the cost of one serving,
// bought at scale). The Shopper does the one real shopping trip: it scales each
// dinner's share of every Kroger product to the number of people, adds up the
// week, and rounds up to whole packages once. A product used by several dinners
// is bought once.
import { z } from 'zod';
import { getStore } from './store/index.js';
import { productAtStore } from './kroger.js';
import { parseSize } from './units.js';
import * as pricer from './pricer.js';

const round2 = (x) => Math.round(x * 100) / 100;
export const DEFAULT_PEOPLE = 50;
const planId = z.uuid().describe('The id of a saved plan, from list_meal_plans');
const people = z.number().int().min(1).max(1000).optional().describe(`How many people the week’s shopping is for (default ${DEFAULT_PEOPLE})`);
const replacements = z.array(z.strictObject({
  product_id: z.string().describe('The product in the cart to replace (from build_week_cart: one the store no longer carries, or an estimate)'),
  replacement_product_id: z.string().describe('A Kroger product_id from search_kroger_products at the class store'),
  reason: z.string().trim().min(5).max(300).describe('Why, e.g. "no longer carried; same cheese, larger pack"'),
  packages: z.number().int().min(1).max(500).optional().describe('How many to buy, only when the two package sizes don’t compare (e.g. a count and a weight)'),
})).max(40).optional().describe('Products to buy instead of ones the store no longer carries');
export const cartSchema = z.strictObject({ plan_id: planId, people, replacements });
export const choiceSchema = z.strictObject({
  plan_id: planId,
  people,
  replacements,
  reason: z.string().trim().min(20).max(2000).describe('Why this plan is the class’s best: name the group that created it and compare it with the others'),
});
const reasons = (error) => error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);

// Every saved plan, newest first, with what a comparison needs.
export async function listPlansForShopper() {
  const plans = await getStore().listPlans({ limit: 200 });
  return plans.map((p) => {
    const checks = p.rule_checks || [];
    return {
      id: p.id,
      group: p.group_name,
      saved_at: p.created_at,
      summary: p.summary,
      budget_usd: p.budget_usd,
      week_cost_per_person_usd: p.total_cost_usd,
      average_dinner_cost_per_person_usd: p.meals.length ? round2(p.total_cost_usd / p.meals.length) : null,
      checks_passed: `${checks.filter((c) => c.passed).length} of ${checks.length}`,
      failed_checks: checks.filter((c) => !c.passed).map((c) => (c.detail ? `${c.rule} (${c.detail})` : c.rule)),
      dinners: p.meals.map((m) => ({
        day: m.day, recipe_id: m.recipe_id, name: m.name, cuisine: m.cuisine, category: m.category,
        cost_per_serving_usd: m.cost_per_serving_usd, picked_by: m.picked_by ?? [], why: m.why,
      })),
    };
  });
}

// The week's cart for a saved plan, checked with Kroger today.
// Returns { ok, plan, cart } or { ok: false, status, errors }.
//   1. From the Pricer's carts: each dinner's share of each product, scaled to
//      the people shopped for; a product used by several dinners is bought once.
//   2. Each Kroger product is looked up at the class store now: whether the store
//      still carries it, and today's price. Stock levels are not checked: shopping
//      for many people can empty a shelf anyway, so the cart says to check them.
//   3. Replacements the Shopper chose for products the store doesn't carry (or
//      for estimated prices) take their place, in enough packages.
export async function buildWeekCart(input) {
  const parsed = cartSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error) };
  const store = getStore();
  const plan = await store.getPlan(parsed.data.plan_id);
  const servings = parsed.data.people ?? DEFAULT_PEOPLE;
  if (!plan) return { ok: false, status: 404, errors: [`no saved plan has the id ${parsed.data.plan_id} (use an id from list_meal_plans)`] };
  const carts = await store.pricingCarts([...new Set(plan.meals.map((m) => m.meal_id))]);
  const missing = plan.meals.filter((m) => carts.get(m.meal_id)?.status !== 'priced');
  if (missing.length) return { ok: false, status: 409, errors: [`these dinners have no Kroger cart yet (the Recipe Pricer is re-pricing them): ${missing.map((m) => m.name).join(', ')}`] };

  const byProduct = new Map();
  for (const m of plan.meals) {
    const c = carts.get(m.meal_id);
    // The Pricer's cart is for c.people; scale each share to the people shopped for.
    const scale = c.people > 0 ? servings / c.people : 1;
    for (const e of c.basket || []) {
      if (e?.status !== 'bought' && e?.status !== 'estimated') continue;
      // An estimate is its own line: estimates for different recipes are different things.
      const id = e.status === 'estimated' ? `estimate-${m.meal_id}-${e.line}` : e.product.id ?? `${e.product.description}|${e.product.size}`;
      const line = byProduct.get(id) ?? {
        product_id: id, description: e.product.description, brand: e.product.brand ?? null, size: e.product.size,
        price_usd: e.product.price_usd, image_url: e.product.image_url ?? null, estimated: e.status === 'estimated',
        share: 0, used_for: [], substitutes: [],
      };
      line.share += e.fraction * scale;
      line.used_for.push(`${m.day}: ${e.ingredient}`);
      if (e.substitute_for) line.substitutes.push(`${m.day}: instead of ${e.substitute_for}`);
      byProduct.set(id, line);
    }
  }

  const check = await checkWithKroger([...byProduct.values()], parsed.data.replacements ?? []);
  if (!check.ok) return check;
  const lines = [...byProduct.values()].map(({ share, packages, substitutes, ...l }) => {
    const n = packages ?? Math.max(1, Math.ceil(share - 1e-9));
    return { ...l, ...(substitutes.length ? { substitutes } : {}), packages: n, cost_usd: round2(n * l.price_usd) };
  }).sort((a, b) => b.cost_usd - a.cost_usd);
  const total = round2(lines.reduce((s, l) => s + l.cost_usd, 0));
  const unavailable = lines.filter((l) => l.availability === 'unavailable');
  return {
    ok: true,
    plan,
    cart: {
      plan_id: plan.id,
      group: plan.group_name,
      people: servings,
      lines,
      total_usd: total,
      per_person_usd: round2(total / servings),
      plan_cost_per_person_usd: plan.total_cost_usd,
      estimated_lines: lines.filter((l) => l.estimated).length,
      kroger_check: check.summary,
      checked_at: check.store ? new Date().toISOString() : null,
      store: check.store,
      unavailable: unavailable.map((l) => ({ product_id: l.product_id, description: l.description, size: l.size, needed_packages: l.packages, used_for: l.used_for })),
      replaced_lines: lines.filter((l) => l.replaces).length,
      note: `Everything to buy at Kroger to cook the five dinners for ${servings} people: each recipe scaled to ${servings}, then rounded up to whole packages once, and a product several dinners use is bought once. Quantities scale in proportion, which is rough for spices and “to taste” items.`,
    },
  };
}

const LOOKUPS_AT_ONCE = 6;
// Looks up every Kroger product at the class store and applies the replacements.
// Changes the lines in place. Returns { ok, summary, store } or a rejection.
async function checkWithKroger(lines, replacements) {
  const byId = new Map(lines.map((l) => [l.product_id, l]));
  for (const r of replacements) {
    if (!byId.has(r.product_id)) return { ok: false, status: 400, errors: [`replacements: ${r.product_id} isn't a product_id in this plan's cart`] };
  }
  let classStore;
  try {
    classStore = await pricer.classStore();
  } catch (e) {
    for (const l of lines) l.availability = l.estimated ? 'estimated' : 'unchecked';
    if (replacements.length) return { ok: false, status: 503, errors: [`can't check replacements with Kroger now: ${e.message}`] };
    return { ok: true, summary: `Not checked with Kroger today (${e.message}): the prices are the Recipe Pricer’s.`, store: null };
  }
  const at = (product_id) => productAtStore({ product_id, store_id: classStore.store_id }, pricer.krogerFetch());
  const store = { store_id: classStore.store_id, name: classStore.name };

  // Whether the store carries each Kroger product in the cart, and today's price.
  const kroger = lines.filter((l) => !l.estimated);
  let failure = null;
  for (let i = 0; i < kroger.length; i += LOOKUPS_AT_ONCE) {
    await Promise.all(kroger.slice(i, i + LOOKUPS_AT_ONCE).map(async (l) => {
      const res = await at(l.product_id);
      if (!res.ok) { failure ??= res.errors.join(' '); l.availability = 'unchecked'; return; }
      const p = res.product;
      const price = p ? p.promo_price_usd ?? p.price_usd : null;
      if (!p || price == null) {
        l.availability = 'unavailable';
        l.unavailable_reason = !p ? 'the store no longer carries it' : 'no price at the store today';
        return;
      }
      l.availability = 'available';
      if (Math.abs(price - l.price_usd) >= 0.01) { l.priced_at_usd = l.price_usd; l.price_usd = price; }
      if (p.image_url) l.image_url = p.image_url;
    }));
  }
  for (const l of lines) if (l.estimated) l.availability = 'estimated';

  // The Shopper's replacements: available today, in enough packages.
  for (const r of replacements) {
    const l = byId.get(r.product_id);
    const res = await at(r.replacement_product_id);
    if (!res.ok) return { ok: false, status: res.status, errors: res.errors };
    const p = res.product;
    const price = p ? p.promo_price_usd ?? p.price_usd : null;
    if (!p || price == null) {
      return { ok: false, status: 409, errors: [`replacements: the store doesn't carry ${r.replacement_product_id} today (or it has no price); search for another`] };
    }
    let packages = r.packages;
    if (packages == null) {
      const from = parseSize(l.size);
      const to = parseSize(p.size);
      if (!from || !to || from.family !== to.family) {
        return { ok: false, status: 400, errors: [`replacements: the sizes don't compare (${l.size ?? '?'} and ${p.size ?? '?'}); give "packages", how many of ${p.description} to buy for everyone`] };
      }
      packages = Math.max(1, Math.ceil((l.share * from.base) / to.base - 1e-9));
    }
    Object.assign(l, {
      replaces: { product_id: l.product_id, description: l.description, size: l.size, why: l.unavailable_reason ?? (l.estimated ? 'its price was only an estimate' : 'chosen by the Shopper') },
      replacement_reason: r.reason,
      product_id: p.product_id, description: p.description, brand: p.brand, size: p.size, price_usd: price,
      image_url: p.image_url ?? l.image_url, estimated: false, packages, priced_at_usd: undefined,
      availability: 'available', unavailable_reason: undefined,
    });
  }

  const count = (a) => lines.filter((l) => l.availability === a).length;
  const changed = lines.filter((l) => l.priced_at_usd != null).length;
  const summary = failure && count('unchecked')
    ? `Checked with Kroger, but ${count('unchecked')} product${count('unchecked') === 1 ? '' : 's'} couldn’t be checked (${failure}).`
    : `Checked with Kroger at ${store.name ?? 'the class store'}: ${count('available')} product${count('available') === 1 ? '' : 's'} carried, ${count('unavailable')} no longer carried${changed ? `, ${changed} price${changed === 1 ? '' : 's'} changed since pricing` : ''}.`;
  return { ok: true, summary: `${summary} Double-check stock quantities before shopping: buying for many people can empty a shelf.`, store };
}

// The class's choice: the plan, why, and its cart (built again here, never taken from the agent).
export async function saveChoice(input) {
  const parsed = choiceSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error) };
  const built = await buildWeekCart({ plan_id: parsed.data.plan_id, people: parsed.data.people, replacements: parsed.data.replacements });
  if (!built.ok) return built;
  const row = await getStore().saveChoice({
    plan_id: parsed.data.plan_id, reason: parsed.data.reason, people: built.cart.people, cart: built.cart, total_usd: built.cart.total_usd,
  });
  return { ok: true, choice: row };
}

// For the Shopper and Coordinator pages. There is one active shopping plan:
// the newest choice. Running the Shopper again makes the earlier ones history.
export async function shopperOverview() {
  const store = getStore();
  const [choices, run] = await Promise.all([store.listChoices(20), store.latestAgentRun('shopper')]);
  await addPhotos(store, choices);
  const [active, ...history] = choices.map((c, i) => ({ ...c, status: i === 0 ? 'active' : 'historical' }));
  return { choice: active ?? null, history, run };
}

// Carts saved before product photos were kept: find each product's Kroger photo
// in the Pricer's carts for the plan's dinners.
async function addPhotos(store, choices) {
  const bare = choices.filter((c) => c.cart?.lines?.some((l) => !('image_url' in l)));
  if (!bare.length) return;
  const mealIds = [...new Set(bare.flatMap((c) => (c.plan?.meals || []).map((m) => m.meal_id)))];
  const photos = new Map();
  for (const c of (await store.pricingCarts(mealIds)).values()) {
    for (const e of c.basket || []) if (e?.product?.id && e.product.image_url) photos.set(e.product.id, e.product.image_url);
  }
  for (const c of bare) for (const l of c.cart.lines) if (!('image_url' in l)) l.image_url = photos.get(l.product_id) ?? null;
}
