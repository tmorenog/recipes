// How to work with the coordinator, served by the MCP tool get_contract.
// It describes the system's structure and protocol (each agent's role, the
// tools, formats, checks, limits, and what happens to what is saved), not
// the agent's goals or strategy: those belong to the agent's own instructions.
// Field lists come from the same schemas that check every save, and limits
// and checks from the instructor's settings.
import { recipeSchema, ingredientSchema } from './recipes.js';
import { planSchema, mealSchema, ruleText } from './plans.js';
import { getSettings } from './settings.js';

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

const perGroup = (n, what) => (n > 0 ? `Each group can save at most ${n} ${what} in total; further saves are rejected.` : null);
const rate = (n) => (n > 0 ? `Each group can make at most ${n} save attempts a minute (accepted or not); faster attempts are rejected until the minute passes.` : null);
const REJECTED = 'The tool result is marked "isError": true and its text starts "Rejected:" followed by every problem at once. It is feedback, not a failure: fix every reason and submit again.';
const NOTES = 'format_notes: small, certain fixes the coordinator made to what was sent (e.g. a number sent as text). Send the exact format next time.';

const CONTRACTS = {
  scout: (s) => ({
    agent: 'Recipe Scout',
    role: 'Proposes real recipes for the class. The coordinator checks and stores each recipe, the Recipe Pricer prices it, and the Meal Planners then choose among the priced recipes.',
    tools: {
      get_contract: 'This description of how to work with the coordinator.',
      save_recipe: 'Submits one recipe for your group, in recipe_format. The answer says whether it was accepted, or lists every problem.',
    },
    recipe_format: fields(recipeSchema),
    ingredient_format: fields(ingredientSchema),
    data_sources: [
      'Every value except est_minutes, est_servings and why_chosen must come from the recipe as TheMealDB gives it. Other agents rely on stored recipes being real: never invent a recipe, ingredient, quantity or link.',
      'Ingredients, measures and instructions are only in TheMealDB’s full record of a recipe (its lookup by id), not in search or filter results.',
      'Pair strIngredientN with strMeasureN for the same N, in order. Trim spaces and skip empty ingredient slots. Keep an ingredient whose measure is blank: amount null, unit null, raw "".',
    ],
    checks: [
      'Every field and type in recipe_format. Fields that are not listed are rejected.',
      ...(s.verify_recipes ? ['The recipe must be real: the coordinator looks up meal_id on TheMealDB and compares the name and the ingredient names with it (capitals, spacing and plurals don’t matter). Measures and your own fields are not compared.'] : []),
      'A group can pick a TheMealDB recipe only once for the same theme.',
    ],
    limits: [perGroup(s.max_recipes_per_group, 'recipes'), rate(s.max_saves_per_minute)].filter(Boolean),
    storage_and_handoff: [
      'Each TheMealDB recipe is stored once. If another group already saved it, your pick is added to it: picked_by and pick_count show its popularity to the Meal Planners.',
      s.auto_pricing
        ? 'A newly stored recipe goes straight to the Recipe Pricer, which works out its cost. Meal Planners can use it once it is priced.'
        : 'A newly stored recipe waits until the instructor sends it to the Recipe Pricer. Meal Planners can use it once it is priced.',
      'Every request and answer is shown on the class Coordinator page.',
    ],
    answers: {
      accepted: '{ "saved": true, "id": …, "new_recipe": true|false, "picked_by": [groups] }, plus a note when another group had already chosen the recipe.',
      rejected: REJECTED,
      format_notes: NOTES,
    },
    example: exampleRecipe,
  }),
  planner: (s) => ({
    agent: 'Meal Planner',
    role: 'Turns the class’s priced recipes into meal plans of five dinners, Monday to Friday, within a budget. The coordinator looks up the costs, checks each plan and stores it.',
    tools: {
      get_contract: 'This description of how to work with the coordinator.',
      list_recipes: 'The class’s recipes, each stored once, with ingredients, est_servings, pick_count and picked_by (how many groups chose it), and pricing. With {"priced": true}: only recipes the Recipe Pricer has priced, each with pricing.cost_per_serving_usd; pricing.estimated_lines counts ingredients whose price was estimated because Kroger had none.',
      check_meal_plan: 'Checks a draft plan without saving it: returns the week’s cost per person and every check with passed true or false.',
      save_meal_plan: 'Stores a plan for your group, after the same checks. A plan that fails a check is still stored, with that check marked as failed.',
    },
    plan_format: fields(planSchema),
    meal_format: fields(mealSchema),
    data_sources: [
      'recipe_id: the id of a priced recipe from list_recipes.',
      'nutrition_per_serving (optional): your estimate for one serving; stored and shown as the Meal Planner’s estimate, never checked.',
      'Costs come from the Recipe Pricer and are added up by the coordinator. Never send costs.',
    ],
    checks: {
      structure: [
        'Every field and type in plan_format and meal_format; fields that are not listed are rejected.',
        'Exactly five dinners: Monday, Tuesday, Wednesday, Thursday and Friday, each once.',
        'Each recipe at most once, and only recipes that are priced.',
      ],
      reported_for_every_plan: {
        note: 'The class’s rules for a plan, worked out from the stored costs, cuisines and categories. check_meal_plan and save_meal_plan report each one as passed or not.',
        rules: Object.values(ruleText(s.checks)),
      },
    },
    limits: [perGroup(s.max_plans_per_group, 'meal plans'), rate(s.max_saves_per_minute), 'check_meal_plan saves nothing and has no per-group limit.'].filter(Boolean),
    storage_and_handoff: [
      'A stored plan keeps the coordinator’s costs and check results and is shown on the class Coordinator page, with every request and answer.',
    ],
    answers: {
      checked: '{ "week_cost_per_person_usd": …, "average_dinner_cost_per_person_usd": …, "budget_usd": …, "all_rules_passed": true|false, "checks": [{ "rule", "passed", "detail" }], "meals": [each dinner with its cost, pick_count and picked_by (the groups that chose it)] }',
      saved: 'The same, with "saved": true and the plan’s "id".',
      rejected: REJECTED,
      format_notes: NOTES,
    },
    example: {
      budget_usd: 3,
      summary: 'Five dinners from four cuisines, $2.28 a dinner on average per person. Tuesday is the vegetarian night.',
      meals: [
        {
          day: 'Monday',
          recipe_id: '<id from list_recipes>',
          why: 'Cheap and filling, to start the week.',
        },
        '… one entry for each of Tuesday, Wednesday, Thursday and Friday',
      ],
    },
  }),
};

export const contract = async (agent) => CONTRACTS[agent](await getSettings());
