// Meal plan rules and operations, shared by MCP and REST.
import { z } from 'zod';
import { getStore } from './store/index.js';
import { reasons } from './recipes.js';

const text = (max) => z.string().trim().min(1).max(max);
const optionalText = (max) => z.string().trim().max(max).nullable().optional();
const money = z.number().finite().min(0).max(100000);

const nutritionSchema = z.strictObject({
  calories: z.number().finite().min(0).max(5000),
  protein_g: z.number().finite().min(0).max(500),
  fiber_g: z.number().finite().min(0).max(200),
  sodium_mg: z.number().finite().min(0).max(20000),
});

export const mealSchema = z.strictObject({
  day: z.number().int().min(1).max(7).describe('1 = Monday … 5 = Friday'),
  recipe_id: z.uuid().describe('The recipe id from list_recipes'),
  servings: z.number().int().min(1).max(100),
  cost_used_usd: money.describe('What the ingredients this meal actually uses cost'),
  cost_per_serving_usd: money.describe('cost_used_usd / servings'),
  nutrition_per_serving: nutritionSchema.describe('Estimated: calories, protein_g, fiber_g, sodium_mg'),
});

export const shoppingItemSchema = z.strictObject({
  item: text(200).describe('What to buy, e.g. "yellow onions"'),
  kroger_product_id: optionalText(50),
  description: optionalText(300).describe('The Kroger product description'),
  size: optionalText(100).describe('Package size, e.g. "3 lb bag"'),
  quantity: z.number().int().min(1).max(100).describe('Number of packages'),
  unit_price_usd: money.describe('Price of one package'),
  recipe_ids: z.array(z.uuid()).min(1).describe('Which of the plan’s recipes use it'),
});

export const planSchema = z.strictObject({
  summary: text(4000).describe('Why these 5 meals: balance, cost, trade-offs'),
  budget_usd: money.nullable().optional(),
  store_id: optionalText(50).describe('The Kroger store the prices came from'),
  total_cost_usd: money.describe('What the shopping list costs: the sum of quantity × unit_price_usd'),
  meals: z.array(mealSchema).length(5),
  shopping_list: z.array(shoppingItemSchema).min(1).max(200),
  rule_checks: z
    .array(z.strictObject({ rule: text(200), passed: z.boolean(), detail: z.string().max(1000).optional() }))
    .max(50)
    .optional()
    .describe('The diet and budget rules you checked, and whether each passed'),
});

export const listPlansSchema = z.strictObject({
  group: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const CENTS = 0.05;

// Checks a schema can't express. `statuses` maps each existing recipe id to its status.
export function checkPlan(plan, statuses) {
  const errors = [];
  const warnings = [];

  const days = plan.meals.map((m) => m.day);
  if (new Set(days).size !== days.length) errors.push('meals: each meal needs a different day');

  const ids = plan.meals.map((m) => m.recipe_id);
  if (new Set(ids).size !== ids.length) errors.push('meals: the same recipe is used twice');
  for (const id of new Set(ids)) {
    if (!statuses.has(id)) errors.push(`meals: no recipe has the id ${id} (use ids from list_recipes)`);
  }

  plan.meals.forEach((m, i) => {
    const expected = m.cost_used_usd / m.servings;
    if (Math.abs(expected - m.cost_per_serving_usd) > CENTS) {
      errors.push(`meals.${i}.cost_per_serving_usd is ${m.cost_per_serving_usd}, but cost_used_usd ÷ servings is ${expected.toFixed(2)}`);
    }
  });

  const planIds = new Set(ids);
  plan.shopping_list.forEach((s, i) => {
    for (const rid of s.recipe_ids) {
      if (!planIds.has(rid)) errors.push(`shopping_list.${i} (${s.item}): recipe ${rid} isn’t one of this plan’s meals`);
    }
  });

  const listTotal = plan.shopping_list.reduce((sum, s) => sum + s.quantity * s.unit_price_usd, 0);
  if (Math.abs(listTotal - plan.total_cost_usd) > CENTS) {
    errors.push(`total_cost_usd is ${plan.total_cost_usd}, but the shopping list adds up to ${listTotal.toFixed(2)}`);
  }

  if (plan.budget_usd != null && plan.total_cost_usd > plan.budget_usd) {
    warnings.push(`over budget: ${plan.total_cost_usd} > ${plan.budget_usd}`);
  }
  return { errors, warnings };
}

const toPlan = ({ group_name, ...row }) => ({ group: group_name, ...row });

export async function savePlan({ group, channel, input }) {
  const store = getStore();
  const log = (ok, detail) => store.logActivity({ group_name: group, channel, action: 'save_meal_plan', ok, detail, input: input ?? null });

  const parsed = planSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const errors = reasons(parsed.error, input);
    await log(false, errors.join('; '));
    return { ok: false, status: 400, errors };
  }
  const plan = parsed.data;
  const statuses = await store.recipeStatuses([...new Set(plan.meals.map((m) => m.recipe_id))]);
  const { errors, warnings } = checkPlan(plan, statuses);
  if (errors.length) {
    await log(false, errors.join('; '));
    return { ok: false, status: 400, errors };
  }

  const row = await store.insertPlan({
    group_name: group,
    summary: plan.summary,
    budget_usd: plan.budget_usd ?? null,
    total_cost_usd: plan.total_cost_usd,
    store_id: plan.store_id ?? null,
    meals: plan.meals,
    shopping_list: plan.shopping_list,
    rule_checks: plan.rule_checks ?? [],
  });
  await log(true, row.id);
  const stillNew = plan.meals.map((m) => m.recipe_id).filter((id) => statuses.get(id) === 'new');
  return {
    ok: true,
    plan: toPlan(row),
    warnings,
    next_step: stillNew.length ? `mark these recipes processed: ${stillNew.join(', ')}` : null,
  };
}

export async function listPlans(input) {
  const parsed = listPlansSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error, input) };
  const rows = await getStore().listPlans(parsed.data);
  return { ok: true, count: rows.length, plans: rows.map(toPlan) };
}

export const listActivitySchema = z.strictObject({
  group: z.string().trim().min(1).max(100).optional(),
  result: z.enum(['all', 'accepted', 'rejected']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export async function listActivity(input) {
  const parsed = listActivitySchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error, input) };
  const { group, result, limit } = parsed.data;
  const ok = result === 'all' ? undefined : result === 'accepted';
  const rows = await getStore().listActivity({ group, ok, limit });
  return { ok: true, count: rows.length, activity: rows.map(({ group_name, ...r }) => ({ group: group_name, ...r })) };
}
