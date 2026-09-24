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
      'Build ingredients by pairing strIngredientN with strMeasureN for the same N, in order. Trim spaces and skip empty ingredient slots. ' +
        'Keep an ingredient whose measure is blank: amount null, unit null, raw "".',
      'Judge fit from the full recipe. Don’t claim a recipe is vegetarian, vegan, gluten-free, halal or allergy-safe from its name, category or tags: ' +
        'check every ingredient, and if you can’t be sure, choose another recipe.',
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
    goal:
      'Plan 5 dinners, one per day for days 1 to 5, from the class’s new recipes, for the number of people you were given, ' +
      'priced at a Kroger store near the ZIP code you were given, within the budget you were given. Save the plan with save_meal_plan.',
    steps: [
      'Call list_recipes (by default only "new" recipes). If there are fewer than 5, say so and finish.',
      'Call find_kroger_stores with the ZIP code and use the first store’s store_id for every search.',
      'For each promising recipe, price its ingredients. Scale quantities from the recipe’s est_servings to the number of people. ' +
        'Skip pantry staples (salt, pepper, water, cooking oil, dried herbs and spices): assume they’re at home, cost 0, and mention them in the summary.',
      'For every other ingredient, call search_kroger_products and choose the product that matches the ingredient’s form (garlic, not garlic powder) ' +
        'and a sensible size. Use promo_price_usd when there is one. If nothing matches, try a simpler search term; if still nothing, choose another recipe.',
      'Work out each ingredient’s cost with your price_ingredient calculator tool if you have one. Never do unit conversions or arithmetic in your head.',
      'Estimate each recipe’s nutrition per serving: calories, protein_g, fiber_g, sodium_mg. Say in the summary that these are estimates.',
      'Choose 5 recipes that follow balance_rules. Prefer recipes that share ingredients. If no set passes every rule, pick the best one and say which rules failed.',
      'Build the shopping list: one line per Kroger product, with the total number of packages needed across all 5 meals and the recipe_ids that use it.',
      'Get cost_per_serving_usd and total_cost_usd from your plan_totals calculator tool if you have one, then call save_meal_plan in plan_format, with one rule_checks entry per balance rule.',
      'Once the plan is saved, call mark_processed for each of the 5 recipes, then finish with a short summary.',
    ],
    balance_rules: {
      note: 'Classroom rules, not dietary advice. If your instructions give different rules, use those instead.',
      per_serving: ['400 to 800 calories', 'at least 20 g protein', 'at least 5 g fibre', 'under 1,500 mg sodium'],
      across_the_week: [
        'no main protein more than twice',
        'at least 3 different cuisines, when the recipes allow',
        'at least one vegetable-forward dinner',
        'the shopping list total is within the budget',
      ],
    },
    checks: [
      'Use recipe ids from list_recipes. Exactly 5 meals, each on a different day, no recipe twice.',
      'cost_per_serving_usd must equal cost_used_usd ÷ servings (to within 5 cents).',
      'total_cost_usd must equal the shopping list total: the sum of quantity × unit_price_usd (to within 5 cents).',
      'Every shopping list item’s recipe_ids must be recipes in this plan.',
      'Going over budget is allowed but flagged.',
      'Send only the fields in plan_format. If save_meal_plan is rejected, read every reason, fix them all, and save again.',
    ],
    kroger: 'The class shares a daily limit of Kroger searches. Search once per ingredient and reuse the answer: the same search at the same store gives the same prices.',
    costs: 'cost_used_usd is the share of each package a meal actually uses (its real food cost). The shopping list is what you pay at the till: whole packages. total_cost_usd is the shopping list total, and the budget applies to it.',
    plan_format: fields(planSchema),
    meal_format: fields(mealSchema),
    shopping_item_format: fields(shoppingItemSchema),
  }),
};

export const expectations = (agent) => BRIEFS[agent]();
