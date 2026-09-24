// Meal plans: five dinners, Monday to Friday, chosen from the recipes the
// Pricer has priced. The Planner agent chooses, explains, and estimates each
// dinner's nutrition; this code looks up each dinner's cost from the Pricer,
// adds up the week and checks the rules. Shared by MCP and REST.
import { z } from 'zod';
import { getStore } from './store/index.js';
import { reasons, pricingSummary } from './recipes.js';

const text = (max) => z.string().trim().min(1).max(max);

export const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

export const nutritionSchema = z.strictObject({
  calories: z.number().finite().min(0).max(5000).describe('Calories per serving'),
  protein_g: z.number().finite().min(0).max(500).describe('Grams of protein per serving'),
  fiber_g: z.number().finite().min(0).max(200).describe('Grams of fibre per serving'),
  sodium_mg: z.number().finite().min(0).max(20000).describe('Milligrams of sodium per serving'),
});

export const mealSchema = z.strictObject({
  day: z.enum(DAYS).describe('Monday to Friday, each day once'),
  recipe_id: z.uuid().describe('A recipe id from list_recipes; the recipe must be priced'),
  why: text(500).describe('One sentence: why this dinner'),
  nutrition_per_serving: nutritionSchema.describe('Your estimate for one serving, worked out from the recipe’s ingredients'),
});

export const planSchema = z.strictObject({
  budget_usd: z.number().finite().positive().max(10000).describe('The budget you were given: US dollars per person for the whole week'),
  summary: text(4000).describe('How the five dinners balance nutrition, variety and cost, and any trade-offs'),
  meals: z.array(mealSchema).length(5).describe('Five dinners, Monday to Friday'),
});

// The rules the coordinator checks. Classroom rules, not dietary advice.
export const RULES = {
  per_dinner: { calories: [400, 800], protein_g: 20, fiber_g: 5, sodium_mg: 1500 },
  min_cuisines: 3,
  max_same_category: 2,
  vegetarian_categories: ['Vegetarian', 'Vegan'],
};
export const RULE_TEXT = {
  budget: 'The week costs no more than the budget, per person',
  calories: `Every dinner has ${RULES.per_dinner.calories[0]} to ${RULES.per_dinner.calories[1]} calories per serving`,
  protein: `Every dinner has at least ${RULES.per_dinner.protein_g} g protein per serving`,
  fiber: `Every dinner has at least ${RULES.per_dinner.fiber_g} g fibre per serving`,
  sodium: `Every dinner has less than ${RULES.per_dinner.sodium_mg.toLocaleString('en-US')} mg sodium per serving`,
  cuisines: `At least ${RULES.min_cuisines} different cuisines`,
  categories: `No category (e.g. Beef, Chicken) more than ${RULES.max_same_category} times`,
  vegetarian: 'At least one vegetarian or vegan dinner',
};

const round2 = (x) => Math.round(x * 100) / 100;

// Looks up each dinner and checks the plan. Returns
//   { ok: false, status, errors }               the plan can't be used as it is
//   { ok: true, meals, week, checks, passed }  the dinners with their numbers, and every rule
export async function evaluatePlan(input) {
  const parsed = planSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error, input) };
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
        nutrition_estimated_by: 'planner',
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
        nutrition_per_serving: m.nutrition_per_serving,
      };
    });

  const week = round2(meals.reduce((sum, m) => sum + m.cost_per_serving_usd, 0));
  const dinnersFailing = (test) => meals.filter((m) => !test(m.nutrition_per_serving)).map((m) => `${m.day} (${m.name})`);
  const rule = (key, failing, detail) => ({ rule: RULE_TEXT[key], passed: failing.length === 0, detail: failing.length ? detail(failing) : null });
  const { calories: [lo, hi], protein_g, fiber_g, sodium_mg } = RULES.per_dinner;
  const cuisines = new Set(meals.map((m) => m.cuisine).filter(Boolean));
  const byCategory = meals.reduce((c, m) => (m.category ? c.set(m.category, (c.get(m.category) || 0) + 1) : c), new Map());
  const tooMany = [...byCategory].filter(([, n]) => n > RULES.max_same_category).map(([c, n]) => `${c} ×${n}`);
  const veg = meals.some((m) => RULES.vegetarian_categories.includes(m.category));

  const checks = [
    { rule: RULE_TEXT.budget, passed: week <= plan.budget_usd, detail: `$${week.toFixed(2)} per person for the week, budget $${plan.budget_usd.toFixed(2)}` },
    rule('calories', dinnersFailing((n) => n.calories >= lo && n.calories <= hi), (f) => `outside the range: ${f.join(', ')}`),
    rule('protein', dinnersFailing((n) => n.protein_g >= protein_g), (f) => `too little: ${f.join(', ')}`),
    rule('fiber', dinnersFailing((n) => n.fiber_g >= fiber_g), (f) => `too little: ${f.join(', ')}`),
    rule('sodium', dinnersFailing((n) => n.sodium_mg < sodium_mg), (f) => `too much: ${f.join(', ')}`),
    { rule: RULE_TEXT.cuisines, passed: cuisines.size >= RULES.min_cuisines, detail: `${cuisines.size}: ${[...cuisines].join(', ') || 'none recorded'}` },
    { rule: RULE_TEXT.categories, passed: tooMany.length === 0, detail: tooMany.length ? tooMany.join(', ') : null },
    { rule: RULE_TEXT.vegetarian, passed: veg, detail: veg ? null : 'none of the five is in the Vegetarian or Vegan category' },
  ];
  return { ok: true, plan, meals, week, checks, passed: checks.every((c) => c.passed) };
}

const answer = (e) => ({
  week_cost_per_person_usd: e.week,
  budget_usd: e.plan.budget_usd,
  all_rules_passed: e.passed,
  checks: e.checks,
  meals: e.meals.map(({ day, recipe_id, meal_id, name, cuisine, category, image_url, why, cost_per_serving_usd, price_estimated, pick_count, nutrition_per_serving }) =>
    ({ day, recipe_id, meal_id, name, cuisine, category, image_url, why, cost_per_serving_usd, price_estimated, pick_count, nutrition_per_serving })),
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
  return { ok: true, count: rows.length, activity: rows.map(({ group_name, ...r }) => ({ group: group_name, ...r })) };
}
