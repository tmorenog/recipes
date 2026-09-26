// Meal plans: five dinners, Monday to Friday, chosen from the recipes the
// Pricer has priced. The Planner agent chooses and explains; this code looks
// up each dinner's cost from the Pricer, adds up the week and checks the
// rules, all from the stored data (cost, cuisine, category). A nutrition
// estimate may come with a dinner: it is kept and shown, never checked.
// Shared by MCP and REST.
import { z } from 'zod';
import { getStore } from './store/index.js';
import { reasons, pricingSummary } from './recipes.js';
import { lenientPlan } from './lenient.js';
import { getSettings, limitFor } from './settings.js';

const text = (max) => z.string().trim().min(1).max(max);

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

export const nutritionSchema = z.strictObject({
  calories: z.number().finite().min(0).max(5000).optional().describe('Calories per serving'),
  protein_g: z.number().finite().min(0).max(500).optional().describe('Grams of protein per serving'),
  fiber_g: z.number().finite().min(0).max(200).optional().describe('Grams of fibre per serving'),
  sodium_mg: z.number().finite().min(0).max(20000).optional().describe('Milligrams of sodium per serving'),
});

export const mealSchema = z.strictObject({
  day: z.enum(DAYS).describe('Monday to Friday, each day once'),
  recipe_id: z.uuid().describe('A recipe id from list_recipes; the recipe must be priced'),
  why: text(500).describe('One sentence: why this dinner'),
  nutrition_per_serving: nutritionSchema.optional().describe('Optional: your estimate for one serving. Stored and shown, not checked'),
});

export const planSchema = z.strictObject({
  budget_usd: z.number().finite().positive().max(10000).describe('The budget you were given: the most a dinner may cost on average, in US dollars per person'),
  summary: text(4000).describe('How the five dinners meet your goals and the budget, and any trade-offs'),
  meals: z.array(mealSchema).length(5).describe('Five dinners, Monday to Friday'),
});

// The checks the coordinator runs on a plan, with the instructor's values
// (lib/settings.js). Classroom rules, not dietary advice.
const VEGETARIAN_CATEGORIES = ['Vegetarian', 'Vegan'];
export function ruleText(c) {
  return {
    budget: 'The average dinner costs no more than the budget, per person',
    cuisines: `At least ${c.min_cuisines} different cuisines`,
    categories: `No category (e.g. Beef, Chicken) more than ${c.max_same_category} times`,
    ...(c.require_vegetarian && { vegetarian: 'At least one vegetarian or vegan dinner' }),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

// Looks up each dinner and checks the plan. Returns
//   { ok: false, status, errors }               the plan can't be used as it is
//   { ok: true, meals, week, checks, passed }  the dinners with their numbers, and every rule
export async function evaluatePlan(input) {
  const { value, notes } = await lenientPlan(input ?? {});
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error, value) };
  const plan = parsed.data;
  const errors = [];

  const days = plan.meals.map((m) => m.day);
  const missing = DAYS.filter((d) => !days.includes(d));
  if (missing.length) errors.push(`meals: each day Monday to Friday once (missing ${missing.join(', ')})`);
  const ids = plan.meals.map((m) => m.recipe_id);
  if (new Set(ids).size !== ids.length) errors.push('meals: the same recipe is used twice');

  const store = getStore();
  const recipes = await store.recipesByIds([...new Set(ids)]);
  for (const id of new Set(ids)) {
    const r = recipes.get(id);
    if (!r) errors.push(`meals: no recipe has the id ${id} (use ids from list_recipes)`);
    else if (pricingSummary(r).status !== 'priced') errors.push(`meals: “${r.name}” isn’t priced yet; choose recipes whose pricing.status is "priced"`);
  }
  if (errors.length) return { ok: false, status: 400, errors };

  const meals = [...plan.meals]
    .sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day))
    .map((m) => {
      const r = recipes.get(m.recipe_id);
      const p = pricingSummary(r);
      return {
        day: m.day,
        recipe_id: m.recipe_id,
        meal_id: r.meal_id,
        name: r.name,
        cuisine: r.cuisine,
        category: r.category,
        image_url: r.image_url,
        why: m.why,
        cost_per_serving_usd: p.cost_per_serving_usd,
        price_estimated: p.estimated,
        pick_count: new Set((r.picks || []).map((x) => x.group)).size,
        ...(m.nutrition_per_serving && { nutrition_per_serving: m.nutrition_per_serving, nutrition_estimated_by: 'planner' }),
      };
    });

  const week = round2(meals.reduce((sum, m) => sum + m.cost_per_serving_usd, 0));
  const perDinner = round2(week / meals.length);
  const { checks: c } = await getSettings();
  const RULE_TEXT = ruleText(c);
  const cuisines = new Set(meals.map((m) => m.cuisine).filter(Boolean));
  const byCategory = meals.reduce((c, m) => (m.category ? c.set(m.category, (c.get(m.category) || 0) + 1) : c), new Map());
  const tooMany = [...byCategory].filter(([, n]) => n > c.max_same_category).map(([cat, n]) => `${cat} ×${n}`);
  const veg = meals.some((m) => VEGETARIAN_CATEGORIES.includes(m.category));

  const checks = [
    { rule: RULE_TEXT.budget, passed: perDinner <= plan.budget_usd, detail: `$${perDinner.toFixed(2)} a dinner on average ($${week.toFixed(2)} for the week), budget $${plan.budget_usd.toFixed(2)} a dinner, per person` },
    { rule: RULE_TEXT.cuisines, passed: cuisines.size >= c.min_cuisines, detail: `${cuisines.size}: ${[...cuisines].join(', ') || 'none recorded'}` },
    { rule: RULE_TEXT.categories, passed: tooMany.length === 0, detail: tooMany.length ? tooMany.join(', ') : null },
    ...(c.require_vegetarian ? [{ rule: RULE_TEXT.vegetarian, passed: veg, detail: veg ? null : 'none of the five is in the Vegetarian or Vegan category' }] : []),
  ];
  return { ok: true, plan, meals, week, perDinner, checks, passed: checks.every((c) => c.passed), notes };
}

const answer = (e) => ({
  week_cost_per_person_usd: e.week,
  average_dinner_cost_per_person_usd: e.perDinner,
  budget_usd: e.plan.budget_usd,
  all_rules_passed: e.passed,
  checks: e.checks,
  meals: e.meals.map(({ day, recipe_id, meal_id, name, cuisine, category, image_url, why, cost_per_serving_usd, price_estimated, pick_count, nutrition_per_serving }) =>
    ({ day, recipe_id, meal_id, name, cuisine, category, image_url, why, cost_per_serving_usd, price_estimated, pick_count, nutrition_per_serving })),
  ...(e.notes?.length && { format_notes: e.notes }),
});

// Checks a draft without saving it, so the agent can improve it first.
export async function checkPlan(input) {
  const e = await evaluatePlan(input);
  return e.ok ? { ok: true, ...answer(e) } : e;
}

const toPlan = ({ group_name, ...row }) => ({ group: group_name, ...row });

export async function savePlan({ group, channel, input }) {
  const store = getStore();
  const log = (ok, detail) => store.logActivity({ group_name: group, channel, action: 'save_meal_plan', ok, detail, input: input ?? null });
  const limited = await limitFor(group, 'plan');
  if (limited) {
    await log(false, limited.errors.join('; '));
    return { ok: false, ...limited };
  }
  const e = await evaluatePlan(input);
  if (!e.ok) {
    await log(false, e.errors.join('; '));
    return e;
  }
  const row = await store.insertPlan({
    group_name: group,
    summary: e.plan.summary,
    budget_usd: e.plan.budget_usd,
    total_cost_usd: e.week,
    store_id: null,
    meals: e.meals,
    shopping_list: [],
    rule_checks: e.checks,
  });
  await log(true, row.id);
  return { ok: true, plan: toPlan(row), ...answer(e) };
}

export const listPlansSchema = z.strictObject({
  group: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

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
  // Public: what was sent stays out (the Admin backup keeps it).
  return { ok: true, count: rows.length, activity: rows.map(({ group_name, input, ...r }) => ({ group: group_name, ...r })) };
}
