// The Shopper Agent's side of the coordinator: the class's saved meal plans,
// the week's Kroger cart for one of them, and the class's choice.
// The Pricer and the Meal Planners work per person (the cost of one serving,
// bought at scale). The Shopper does the one real shopping trip: it scales each
// dinner's share of every Kroger product to the number of people, adds up the
// week, and rounds up to whole packages once. A product used by several dinners
// is bought once.
import { z } from 'zod';
import { getStore } from './store/index.js';

const round2 = (x) => Math.round(x * 100) / 100;
export const DEFAULT_PEOPLE = 50;
const planId = z.uuid().describe('The id of a saved plan, from list_meal_plans');
const people = z.number().int().min(1).max(1000).optional().describe(`How many people the week’s shopping is for (default ${DEFAULT_PEOPLE})`);
export const cartSchema = z.strictObject({ plan_id: planId, people });
export const choiceSchema = z.strictObject({
  plan_id: planId,
  people,
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

// The week's cart for a saved plan. Returns { ok, cart } or { ok: false, status, errors }.
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
      const key = e.product.id ?? `${e.product.description}|${e.product.size}`;
      const line = byProduct.get(key) ?? {
        product_id: e.product.id ?? null, description: e.product.description, brand: e.product.brand ?? null, size: e.product.size,
        price_usd: e.product.price_usd, image_url: e.product.image_url ?? null, estimated: e.status === 'estimated', share: 0, used_for: [],
      };
      line.share += e.fraction * scale;
      line.used_for.push(`${m.day}: ${e.ingredient}`);
      byProduct.set(key, line);
    }
  }
  const lines = [...byProduct.values()].map(({ share, ...l }) => {
    const packages = Math.max(1, Math.ceil(share - 1e-9));
    return { ...l, packages, cost_usd: round2(packages * l.price_usd) };
  }).sort((a, b) => b.cost_usd - a.cost_usd);
  const total = round2(lines.reduce((s, l) => s + l.cost_usd, 0));
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
      note: `Everything to buy at Kroger to cook the five dinners for ${servings} people: each recipe scaled to ${servings}, then rounded up to whole packages once, and a product several dinners use is bought once. Quantities scale in proportion, which is rough for spices and “to taste” items.`,
    },
  };
}

// The class's choice: the plan, why, and its cart (built again here, never taken from the agent).
export async function saveChoice(input) {
  const parsed = choiceSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error) };
  const built = await buildWeekCart({ plan_id: parsed.data.plan_id, people: parsed.data.people });
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
