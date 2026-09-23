// The data contract between the Recipe Scout and the Meal Planner.
// These schemas are published to agents as the tools' input schemas, so the
// descriptions below are what an agent reads when deciding how to call a tool.
import { z } from 'zod';

const text = (max) => z.string().trim().min(1).max(max);
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://');
const money = z.number().finite().min(0).max(100000);

export const ingredientSchema = z.strictObject({
  name: text(120).describe('Ingredient name, lowercase, e.g. "red onion"'),
  amount: z.number().finite().positive().nullable().describe('Numeric amount, e.g. 2. null for "to taste" / "pinch"'),
  unit: z.string().trim().max(40).nullable().describe('Unit, e.g. "tbsp", "g", "cup". null for countable items like "2 eggs"'),
  raw: text(200).describe('The original text from the source, e.g. "2 tbsp, chopped"'),
});

export const recipeSchema = z.strictObject({
  theme: text(200).describe('The theme the scout was searching for, e.g. "cheap weeknight vegetarian dinners"'),
  meal_id: text(100).describe('The recipe id at its source, e.g. TheMealDB idMeal "52772"'),
  name: text(200),
  category: z.string().trim().max(100).nullable().optional(),
  cuisine: z.string().trim().max(100).nullable().optional(),
  ingredients: z.array(ingredientSchema).min(1).max(60),
  instructions: z.string().trim().min(20, 'must be at least 20 characters').max(20000),
  est_minutes: z.number().int().min(1).max(1440).describe('Estimated total time in minutes'),
  est_servings: z.number().int().min(1).max(100).describe('Estimated number of servings'),
  image_url: httpUrl.nullable().optional(),
  source_url: httpUrl.nullable().optional(),
  why_chosen: text(500).describe('One sentence: why this recipe fits the theme'),
});

export const listRecipesSchema = {
  status: z.enum(['new', 'processed', 'all']).default('new').describe('Which recipes to return. Default "new": not yet used by a planner'),
  theme: z.string().trim().min(1).max(200).optional().describe('Only recipes saved for this exact theme'),
  limit: z.number().int().min(1).max(100).default(50),
};

export const markProcessedSchema = {
  recipe_ids: z.array(z.uuid()).min(1).max(100).describe('ids of recipes the planner has used'),
  processed_by: z.string().trim().min(1).max(100).optional().describe('Who processed them, e.g. "meal-planner-team-2"'),
};

const nutritionSchema = z.strictObject({
  calories: z.number().finite().min(0).max(5000),
  protein_g: z.number().finite().min(0).max(500),
  fiber_g: z.number().finite().min(0).max(200),
  sodium_mg: z.number().finite().min(0).max(20000),
});

export const mealSchema = z.strictObject({
  day: z.number().int().min(1).max(7),
  recipe_id: z.uuid().describe('id from list_recipes'),
  servings: z.number().int().min(1).max(100),
  cost_used_usd: money.describe('Cost of the ingredients this meal actually uses'),
  cost_per_serving_usd: money.describe('cost_used_usd / servings'),
  nutrition_per_serving: nutritionSchema,
});

export const shoppingItemSchema = z.strictObject({
  item: text(200).describe('What to buy, e.g. "yellow onions"'),
  kroger_product_id: z.string().trim().max(50).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional().describe('Kroger product description'),
  size: z.string().trim().max(100).nullable().optional().describe('Package size, e.g. "3 lb bag"'),
  quantity: z.number().int().min(1).max(100).describe('Number of packages to buy'),
  unit_price_usd: money.describe('Price of one package'),
  recipe_ids: z.array(z.uuid()).min(1).describe('Which meals in this plan use it'),
});

export const mealPlanSchema = z.strictObject({
  planner: text(100).describe('Team or agent name, e.g. "meal-planner-team-2"'),
  summary: text(4000).describe('Why these 5 meals: balance, cost, trade-offs'),
  budget_usd: money.nullable().optional(),
  store_id: z.string().trim().max(50).nullable().optional().describe('Kroger locationId the prices came from'),
  total_cost_usd: money.describe('What the shopping list costs at the till: sum of quantity × unit_price_usd'),
  meals: z.array(mealSchema).length(5),
  shopping_list: z.array(shoppingItemSchema).min(1).max(200),
  rule_checks: z
    .array(z.strictObject({ rule: text(200), passed: z.boolean(), detail: z.string().max(1000).optional() }))
    .max(50)
    .optional()
    .describe('The diet and budget rules the planner checked, and whether each passed'),
});

const CENT = 0.05;

// Checks a schema can't express. Returns { errors, warnings }.
// existing: Map of recipe id -> { status } for the plan's recipe ids that exist.
export function checkMealPlan(plan, existing) {
  const errors = [];
  const warnings = [];

  const days = plan.meals.map((m) => m.day);
  if (new Set(days).size !== days.length) errors.push('meals: each meal needs a different day');

  const ids = plan.meals.map((m) => m.recipe_id);
  if (new Set(ids).size !== ids.length) errors.push('meals: the same recipe is used twice');

  for (const id of ids) {
    if (!existing.has(id)) errors.push(`meals: recipe ${id} does not exist (use ids from list_recipes)`);
  }

  plan.meals.forEach((m, i) => {
    const expected = m.cost_used_usd / m.servings;
    if (Math.abs(expected - m.cost_per_serving_usd) > CENT) {
      errors.push(
        `meals[${i}]: cost_per_serving_usd is ${m.cost_per_serving_usd} but cost_used_usd / servings is ${expected.toFixed(2)}`,
      );
    }
  });

  const planIds = new Set(ids);
  plan.shopping_list.forEach((s, i) => {
    for (const rid of s.recipe_ids) {
      if (!planIds.has(rid)) errors.push(`shopping_list[${i}] (${s.item}): recipe ${rid} is not one of this plan's meals`);
    }
  });

  const listTotal = plan.shopping_list.reduce((sum, s) => sum + s.quantity * s.unit_price_usd, 0);
  if (Math.abs(listTotal - plan.total_cost_usd) > CENT) {
    errors.push(
      `total_cost_usd is ${plan.total_cost_usd} but the shopping list adds up to ${listTotal.toFixed(2)}`,
    );
  }

  if (plan.budget_usd != null && plan.total_cost_usd > plan.budget_usd) {
    warnings.push(`over budget: ${plan.total_cost_usd} > ${plan.budget_usd}`);
  }

  return { errors, warnings };
}
