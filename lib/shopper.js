// The Shopper Agent's side of the coordinator: the class's saved meal plans,
// the week's Kroger cart for one of them, and the class's choice. The cart is
// built from the Recipe Pricer's carts: the same Kroger product used by
// several dinners is bought once, in whole packages for what they use in all.
import { z } from 'zod';
import { getStore } from './store/index.js';

const round2 = (x) => Math.round(x * 100) / 100;
const planId = z.uuid().describe('The id of a saved plan, from list_meal_plans');
export const cartSchema = z.strictObject({ plan_id: planId });
export const choiceSchema = z.strictObject({
  plan_id: planId,
  reason: z.string().trim().min(20).max(2000).describe('Why this plan is the class’s best: compare it with the others'),
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
  if (!plan) return { ok: false, status: 404, errors: [`no saved plan has the id ${parsed.data.plan_id} (use an id from list_meal_plans)`] };
  const carts = await store.pricingCarts([...new Set(plan.meals.map((m) => m.meal_id))]);
  const missing = plan.meals.filter((m) => carts.get(m.meal_id)?.status !== 'priced');
  if (missing.length) return { ok: false, status: 409, errors: [`these dinners have no Kroger cart yet (the Recipe Pricer is re-pricing them): ${missing.map((m) => m.name).join(', ')}`] };

  const byProduct = new Map();
  const people = new Set();
  for (const m of plan.meals) {
    const c = carts.get(m.meal_id);
    people.add(c.people);
    for (const e of c.basket || []) {
      if (e?.status !== 'bought' && e?.status !== 'estimated') continue;
      const key = e.product.id ?? `${e.product.description}|${e.product.size}`;
      const line = byProduct.get(key) ?? {
        product_id: e.product.id ?? null, description: e.product.description, brand: e.product.brand ?? null, size: e.product.size,
        price_usd: e.product.price_usd, estimated: e.status === 'estimated', share: 0, used_for: [],
      };
      line.share += e.fraction;
      line.used_for.push(`${m.day}: ${e.ingredient}`);
      byProduct.set(key, line);
    }
  }
  const lines = [...byProduct.values()].map(({ share, ...l }) => {
    const packages = Math.max(1, Math.ceil(share - 1e-9));
    return { ...l, packages, cost_usd: round2(packages * l.price_usd) };
  }).sort((a, b) => b.cost_usd - a.cost_usd);
  const total = round2(lines.reduce((s, l) => s + l.cost_usd, 0));
  const servings = [...people].length === 1 ? [...people][0] : null;
  return {
    ok: true,
    plan,
    cart: {
      plan_id: plan.id,
      group: plan.group_name,
      people: servings,
      lines,
      total_usd: total,
      per_person_usd: servings ? round2(total / servings) : null,
      estimated_lines: lines.filter((l) => l.estimated).length,
      note: servings
        ? `Everything to buy at Kroger to cook the five dinners for ${servings} people. A product several dinners use is bought once.`
        : 'The dinners were priced for different numbers of people, so the cart mixes them.',
    },
  };
}

// The class's choice: the plan, why, and its cart (built again here, never taken from the agent).
export async function saveChoice(input) {
  const parsed = choiceSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error) };
  const built = await buildWeekCart({ plan_id: parsed.data.plan_id });
  if (!built.ok) return built;
  const row = await getStore().saveChoice({
    plan_id: parsed.data.plan_id, reason: parsed.data.reason, people: built.cart.people, cart: built.cart, total_usd: built.cart.total_usd,
  });
  return { ok: true, choice: row };
}

// For the Shopper page: the class's choice with its plan, and the latest run.
export async function shopperOverview() {
  const store = getStore();
  const [choice, run] = await Promise.all([store.latestChoice(), store.latestAgentRun('shopper')]);
  const plan = choice ? await store.getPlan(choice.plan_id) : null;
  return { choice: choice && { ...choice, plan }, run };
}
