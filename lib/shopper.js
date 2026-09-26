// The Shopper Agent's side of the coordinator, which keeps to its contract role:
// it serves the stored data (the saved meal plans, and the Recipe Pricer's cart
// for each dinner), checks the cart the Shopper Agent built, and stores the
// class's choice. The shopping itself (checking Kroger today, replacements,
// buying an ingredient several dinners share once) is the Shopper Agent's job:
// see lib/shopper-agent.js.
import { z } from 'zod';
import { getStore } from './store/index.js';

const round2 = (x) => Math.round(x * 100) / 100;
export const DEFAULT_PEOPLE = 50;
const planId = z.uuid().describe('The id of a saved plan, from list_meal_plans');
export const planSchema = z.strictObject({ plan_id: planId });

const text = (max) => z.string().trim().min(1).max(max);
const lineSchema = z.strictObject({
  product_id: text(80).describe('The Kroger product_id, or the Pricer’s estimate id'),
  description: text(200),
  brand: z.string().max(100).nullish(),
  size: z.string().max(60).nullish(),
  price_usd: z.number().positive().max(1000).describe('One package, today'),
  packages: z.number().int().min(1).max(5000),
  cost_usd: z.number().min(0),
  needs: z.array(text(40)).min(1).max(200).describe('The need_ids from get_plan_ingredients this product covers'),
  used_for: z.array(text(200)).max(200).optional(),
  image_url: z.string().max(500).nullish(),
  estimated: z.boolean().optional(),
  priced_at_usd: z.number().nullish().describe('The Pricer’s price, when today’s differs'),
  instead_of: z.array(text(200)).max(50).optional().describe('The Pricer’s products this replaces or combines'),
  substitutes: z.array(text(300)).max(50).optional(),
  note: z.string().max(500).optional(),
});
export const cartSchema = z.strictObject({
  people: z.number().int().min(1).max(1000).describe(`How many people the week’s shopping is for (default ${DEFAULT_PEOPLE})`),
  lines: z.array(lineSchema).min(1).max(300),
  total_usd: z.number().min(0),
  store: z.strictObject({ store_id: z.string(), name: z.string().nullish() }).nullish(),
  checked_at: z.string().max(40).nullish(),
  kroger_check: z.string().max(500).nullish(),
});
export const choiceSchema = z.strictObject({
  plan_id: planId,
  reason: z.string().trim().min(20).max(2000).describe('Why this plan is the class’s best: name the group that created it and compare it with the others'),
  cart: cartSchema.describe('The week’s Kroger cart the Shopper Agent built for this plan'),
});
const reasons = (error) => error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
const dayId = (day, line) => `${String(day).slice(0, 3).toLowerCase()}-${line}`;

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

// The Recipe Pricer's stored cart for each dinner in a plan: every ingredient
// line it bought or estimated, as a need with an id, the product the Pricer
// chose and the share of one package it uses when the recipe is cooked for
// pricer_people. Returns { ok, ... } or { ok: false, status, errors }.
export async function planIngredients(input) {
  const parsed = planSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error) };
  const store = getStore();
  const plan = await store.getPlan(parsed.data.plan_id);
  if (!plan) return { ok: false, status: 404, errors: [`no saved plan has the id ${parsed.data.plan_id} (use an id from list_meal_plans)`] };
  const carts = await store.pricingCarts([...new Set(plan.meals.map((m) => m.meal_id))]);
  const missing = plan.meals.filter((m) => carts.get(m.meal_id)?.status !== 'priced');
  if (missing.length) return { ok: false, status: 409, errors: [`these dinners have no Kroger cart yet (the Recipe Pricer is re-pricing them): ${missing.map((m) => m.name).join(', ')}`] };
  const dinners = plan.meals.map((m) => {
    const c = carts.get(m.meal_id);
    return {
      day: m.day,
      name: m.name,
      pricer_people: c.people,
      needs: (c.basket || []).filter((e) => e?.status === 'bought' || e?.status === 'estimated').map((e) => ({
        need_id: dayId(m.day, e.line),
        ingredient: e.ingredient,
        recipe_line: e.raw ?? null,
        estimated: e.status === 'estimated',
        product: { id: e.status === 'estimated' ? `estimate-${dayId(m.day, e.line)}` : e.product.id, description: e.product.description, brand: e.product.brand ?? null, size: e.product.size, price_usd: e.product.price_usd, image_url: e.product.image_url ?? null },
        packages_for_pricer_people: e.fraction,
        substitute_for: e.substitute_for ?? null,
        estimate_reason: e.status === 'estimated' ? e.reason ?? null : undefined,
      })),
      not_bought: (c.basket || []).filter((e) => e?.status === 'skipped').map((e) => e.ingredient),
    };
  });
  return { ok: true, plan, plan_id: plan.id, group: plan.group_name, dinners };
}

// The class's choice: the plan, why, and the cart the Shopper Agent built. The
// coordinator checks the cart against the plan before storing it: every need
// covered exactly once, and the sums right.
export async function saveChoice(input) {
  const parsed = choiceSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error) };
  const { plan_id, reason, cart } = parsed.data;
  const ing = await planIngredients({ plan_id });
  if (!ing.ok) return ing;
  const needs = new Map(ing.dinners.flatMap((d) => d.needs.map((n) => [n.need_id, `${d.day}: ${n.ingredient}`])));
  const errors = [];
  const covered = new Map();
  cart.lines.forEach((l, i) => {
    for (const id of l.needs) {
      if (!needs.has(id)) errors.push(`lines.${i}: ${id} isn't a need_id of this plan`);
      else if (covered.has(id)) errors.push(`lines.${i}: ${id} is already covered by lines.${covered.get(id)}`);
      else covered.set(id, i);
    }
    if (Math.abs(l.cost_usd - l.packages * l.price_usd) > 0.011) errors.push(`lines.${i}: cost_usd should be packages × price_usd (${round2(l.packages * l.price_usd)})`);
  });
  const uncovered = [...needs.keys()].filter((id) => !covered.has(id));
  if (uncovered.length) errors.push(`these needs aren't in the cart: ${uncovered.map((id) => `${id} (${needs.get(id)})`).join(', ')}`);
  const total = round2(cart.lines.reduce((s, l) => s + l.cost_usd, 0));
  if (Math.abs(total - cart.total_usd) > 0.02) errors.push(`total_usd should be the sum of the lines (${total})`);
  if (errors.length) return { ok: false, status: 400, errors };

  const lines = cart.lines.map((l) => ({ ...l, used_for: l.used_for?.length ? l.used_for : l.needs.map((id) => needs.get(id)) }));
  const stored = {
    ...cart,
    lines,
    plan_id,
    group: ing.group,
    per_person_usd: round2(total / cart.people),
    plan_cost_per_person_usd: ing.plan.total_cost_usd,
    estimated_lines: lines.filter((l) => l.estimated).length,
    note: `Everything to buy at Kroger to cook the five dinners for ${cart.people} people, in whole packages, as the Shopper Agent worked it out from the Recipe Pricer’s carts. Quantities scale in proportion, which is rough for spices and “to taste” items.`,
  };
  const row = await getStore().saveChoice({ plan_id, reason, people: cart.people, cart: stored, total_usd: total });
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
