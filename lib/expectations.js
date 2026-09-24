// What each agent is expected to do, served by the MCP tool get_expectations
// so agents read the rules from the coordinator instead of hard-coding them.
// The field lists come from the same schemas that check every save.
import { recipeSchema, ingredientSchema } from './recipes.js';
import { planSchema, mealSchema, shoppingItemSchema } from './plans.js';

export const AGENTS = ['scout', 'planner'];

function fields(schema) {
  return Object.fromEntries(
    Object.entries(schema.shape).map(([name, s]) => [
      name,
      `${s.safeParse(undefined).success ? 'optional' : 'required'}. ${s.description ?? ''}`.trim(),
    ]),
  );
}

const exampleRecipe = {
  theme: 'cheap weeknight vegetarian dinners',
  meal_id: '52870',
  name: 'Chickpea Fajitas',
  category: 'Vegetarian',
  cuisine: 'Mexican',
  ingredients: [
    { name: 'chickpeas', amount: 400, unit: 'g', raw: '400g can' },
    { name: 'red pepper', amount: 1, unit: null, raw: '1 sliced' },
    { name: 'salt', amount: null, unit: null, raw: 'to taste' },
  ],
  instructions: 'Heat the oven to 200C. Toss the chickpeas and pepper with the spices and roast for 20 minutes.',
  est_minutes: 30,
  est_servings: 4,
  image_url: 'https://www.themealdb.com/images/media/meals/example.jpg',
  source_url: null,
  why_chosen: 'Cheap tinned chickpeas, one tray, ready in 30 minutes.',
};

const BRIEFS = {
  scout: () => ({
    agent: 'Recipe Scout',
    goal: 'Find 5 real recipes on TheMealDB that fit the theme, and save each one with save_recipe.',
    steps: [
      'Search TheMealDB in several ways: by name, ingredient, category and cuisine. If a search finds nothing, try another.',
      'Call get_recipe for each candidate before saving: the filters only return id, name and photo.',
      'Build the recipe in the recipe_format below from the full TheMealDB recipe, and call save_recipe.',
      'Stop when 5 recipes are saved, and finish with a short summary.',
    ],
    rules: [
      'Never invent a recipe, an ingredient or a quantity. Everything except est_minutes, est_servings and why_chosen comes from TheMealDB.',
      'Send only the fields in recipe_format. Any other field is rejected.',
      'Choose variety: different main ingredients and cuisines where the theme allows.',
      'If save_recipe is rejected, read every reason, fix them all, and save again.',
      'If it says your group already saved that recipe for this theme, choose a different recipe.',
      'If the theme contradicts itself or cannot be met, explain why and finish early instead of inventing.',
    ],
    recipe_format: fields(recipeSchema),
    ingredient_format: fields(ingredientSchema),
    example: exampleRecipe,
  }),
  planner: () => ({
    agent: 'Meal Planner',
    goal: 'Plan 5 dinners (days 1 to 5) from the class’s new recipes, priced at a Kroger store, and save the plan with save_meal_plan.',
    steps: [
      'Read recipes with list_recipes (by default only "new" ones). If there are fewer than 5, say so and finish.',
      'Find a store with find_kroger_stores and use the same store_id for every search_kroger_products call.',
      'Price the ingredients of promising recipes, choose 5, and build the shopping list.',
      'Save the plan with save_meal_plan, then call mark_processed for each of the 5 recipes.',
    ],
    rules: [
      'Use recipe ids from list_recipes. Exactly 5 meals, each on a different day, no recipe twice.',
      'cost_per_serving_usd must equal cost_used_usd ÷ servings (to within 5 cents).',
      'total_cost_usd must equal the shopping list total: the sum of quantity × unit_price_usd (to within 5 cents).',
      'Every shopping list item’s recipe_ids must be recipes in this plan.',
      'Send only the fields in plan_format. If save_meal_plan is rejected, fix every reason and save again.',
    ],
    plan_format: fields(planSchema),
    meal_format: fields(mealSchema),
    shopping_item_format: fields(shoppingItemSchema),
  }),
};

export const expectations = (agent) => BRIEFS[agent]();
