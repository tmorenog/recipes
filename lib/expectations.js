// What each agent is expected to do, served by the MCP tool get_expectations
// so agents read the rules from the coordinator instead of hard-coding them.
// The field lists come from the same schemas that check every save.
import { recipeSchema, ingredientSchema } from './recipes.js';
import { planSchema, mealSchema, RULE_TEXT } from './plans.js';

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
      'Search TheMealDB in several ways: by name, main ingredient, category and cuisine. If a search finds nothing, try another.',
      'Before saving a recipe, retrieve its complete details (ingredients, measures and instructions): searches and filters only give an id, a name and a photo.',
      'Build the recipe in the recipe_format below from those complete details, and save it with save_recipe.',
      'Stop when 5 recipes are saved, and finish with a short summary. If 5 suitable recipes can’t be found, stop and explain why.',
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
      'If it says your group already picked that recipe for this theme, choose a different recipe. If another group had already chosen it, that’s fine: your pick is counted and makes the recipe more popular.',
      'If the theme contradicts itself or cannot be met, explain why and finish early instead of inventing.',
    ],
    recipe_format: fields(recipeSchema),
    ingredient_format: fields(ingredientSchema),
    example: exampleRecipe,
  }),
  planner: () => ({
    agent: 'Meal Planner',
    goal:
      'Plan five dinners, Monday to Friday, from the class’s priced recipes: balanced for nutrition, varied, and as cheap as possible ' +
      'within the budget you were given (US dollars per person for the whole week). Save the plan with save_meal_plan.',
    steps: [
      'Call list_recipes with priced: true. Each recipe has its ingredients and pricing.cost_per_serving_usd, worked out by the Pricer agent (pricing.estimated_lines counts ingredients whose price it had to estimate because Kroger had none). If fewer than 5 are priced, say so and finish.',
      'Estimate the nutrition of one serving of each promising recipe (calories, protein_g, fiber_g, sodium_mg) from its ingredients and est_servings, using what you know about those foods.',
      'Choose five that together follow every balance rule and fit the budget. Consider popularity: pick_count and picked_by show how many groups chose each recipe, and a popular recipe is one the class likes. When two choices are otherwise equally good, prefer the more popular one, then the cheaper one.',
      'Call check_meal_plan with your draft, including your nutrition estimates. The coordinator adds up the costs and checks every rule: never add up costs yourself.',
      'If a rule fails, swap dinners and check again. If no set of five can pass every rule, choose the best one and explain in the summary which rule fails and why.',
      'Call save_meal_plan with the plan you checked, then finish with a short summary. Say that the nutrition figures are estimates.',
    ],
    balance_rules: {
      note: 'Classroom rules, not dietary advice. The coordinator checks these; if your instructions add rules of your own, follow them too and say so in the summary.',
      rules: Object.values(RULE_TEXT),
    },
    plan_format: fields(planSchema),
    meal_format: fields(mealSchema),
    example: {
      budget_usd: 15,
      summary: 'Five dinners from four cuisines, all with at least 20 g protein, for $11.40 per person. Tuesday is the vegetarian night.',
      meals: [
        {
          day: 'Monday',
          recipe_id: '<id from list_recipes>',
          why: 'Cheap and high in protein to start the week.',
          nutrition_per_serving: { calories: 620, protein_g: 34, fiber_g: 9, sodium_mg: 780 },
        },
        '… one entry for each of Tuesday, Wednesday, Thursday and Friday',
      ],
    },
  }),
};

export const expectations = (agent) => BRIEFS[agent]();
