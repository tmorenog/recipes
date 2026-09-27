// How to work with the coordinator, served by the MCP tool get_contract.
// It describes the system's structure and protocol (each agent's role, the
// tools, formats, checks, limits, and what happens to what is saved), not
// the agent's goals or strategy: those belong to the agent's own instructions.
// Field lists come from the same schemas that check every save, and limits
// and checks from the instructor's settings.
import { recipeSchema, ingredientSchema } from './recipes.js';
import { planSchema, mealSchema, ruleText } from './plans.js';
import { getSettings } from './settings.js';
import { choiceSchema } from './shopper.js';
import { pricingSchema } from './pricing.js';

export const AGENTS = ['scout', 'planner', 'pricer', 'shopper'];

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
const classRate = (n) => (n > 0 ? `The whole class together can make at most ${n} save attempts a minute; when it’s busy, wait a moment and try again.` : null);
const REJECTED = 'The tool result is marked "isError": true and its text starts "Rejected:" followed by every problem at once. It is feedback, not a failure: fix every reason and submit again.';
const NOTES = 'format_notes: small, certain fixes the coordinator made to what was sent (e.g. a number sent as text). Send the exact format next time.';

const CONTRACTS = {
  scout: (s) => ({
    agent: 'Scout Agent',
    role: 'Proposes real recipes for the class. The coordinator checks and stores each recipe, the Recipe Pricer prices it, and the Meal Planner Agents then choose among the priced recipes.',
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
    limits: [perGroup(s.max_recipes_per_group, 'recipes'), s.max_recipes_total > 0 ? `The whole class can store at most ${s.max_recipes_total} different recipes; after that, only recipes already saved can be picked.` : null, rate(s.max_saves_per_minute), classRate(s.max_class_saves_per_minute)].filter(Boolean),
    storage_and_handoff: [
      'Each TheMealDB recipe is stored once. If another group already saved it, your pick is added to it: picked_by and pick_count show its popularity to the Meal Planner Agents.',
      s.auto_pricing
        ? 'A newly stored recipe goes straight to the Recipe Pricer, which works out its cost. Meal Planner Agents can use it once it is priced.'
        : 'A newly stored recipe waits until the instructor sends it to the Recipe Pricer. Meal Planner Agents can use it once it is priced.',
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
    agent: 'Meal Planner Agent',
    role: 'Turns the class’s priced recipes into meal plans of five dinners, Monday to Friday, within a budget. Everything is per person: the Recipe Pricer prices one serving, bought at scale, and the Shopper Agent later scales the chosen plan to the number of people shopping for. The coordinator looks up the costs, checks each plan and stores it.',
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
    limits: [perGroup(s.max_plans_per_group, 'meal plans'), rate(s.max_saves_per_minute), classRate(s.max_class_saves_per_minute), 'check_meal_plan saves nothing and has no per-group limit.'].filter(Boolean),
    storage_and_handoff: [
      'A stored plan keeps the coordinator’s costs and check results and is shown on the class Coordinator page, with every request and answer.',
      ...(s.auto_shopper_after_plans > 0 ? [`Once ${s.auto_shopper_after_plans} plans are saved and the class has no plan yet, the Shopper Agent compares them and chooses the class’s plan.`] : []),
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
  pricer: () => ({
    agent: 'Pricer Agent',
    role: 'Works out what one serving of each recipe costs when the class buys its ingredients at Kroger. The site gives it one recipe at a time; it chooses a Kroger product (or an estimate) for every ingredient line and saves the cart here. The coordinator works out the costs, checks the cart and stores the price, which the Meal Planner Agents then use.',
    tools: {
      get_contract: 'This description of how to work with the coordinator.',
      get_recipe_to_price: 'The recipe this run was given: name, servings, numbered ingredient lines, and the pricing_id to save with.',
      save_pricing: 'Saves the cart for the recipe, in pricing_format. The answer gives the price per serving, or lists every problem.',
    },
    pricing_format: fields(pricingSchema),
    data_sources: [
      'Products, prices and sizes come from Kroger searches at the class’s store. An estimate is labelled as one, with the reason.',
      'Costs are worked out by the coordinator from each product’s price and size and the amount used. Never send costs.',
    ],
    checks: [
      'Every field and type in pricing_format; fields that are not listed are rejected.',
      'Every ingredient line exactly once: bought, estimated or skipped. Estimated and skipped lines need a reason.',
      'The amount used must convert to the product’s package size (weight, volume or count).',
      'Only the run the site gave the recipe to can save it (pricing_id).',
    ],
    limits: ['One recipe per run; the site decides when the Pricer Agent runs and how many recipes an hour.'],
    storage_and_handoff: [
      'The price per serving and the cart are stored with the recipe: list_recipes shows them to the Meal Planner Agents, and the Recipe Pricer page shows every cart.',
      'Every request and answer is shown on the class Coordinator page.',
    ],
    answers: {
      saved: '{ "saved": true, "meal_id", "status": "priced", "people", "cost_per_serving_usd", "cost_used_usd", "cart_usd", "estimated_lines", "skipped_lines" }',
      rejected: REJECTED,
    },
  }),
  shopper: () => ({
    agent: 'Shopper Agent',
    role: 'Chooses the class’s best meal plan from the plans the Meal Planner Agents saved, builds the week’s Kroger cart for it, and saves both here. The coordinator serves the plans and the Recipe Pricer’s carts, checks the cart it receives, and stores the choice; the shopping itself is the Shopper Agent’s.',
    tools: {
      get_contract: 'This description of how to work with the coordinator.',
      list_meal_plans: 'Every saved plan, newest first: its group, budget, the week’s cost and the average dinner’s cost per person, which checks it passed and failed, and its five dinners with their cost per serving and picked_by (the groups whose Scout Agents chose each recipe).',
      get_plan_ingredients: 'For each dinner of one plan, the Recipe Pricer’s cart: every ingredient bought or estimated, as a need with a need_id, the product the Pricer chose, and packages_for_pricer_people (the share of one package the recipe uses when cooked for pricer_people).',
      save_choice: 'Stores the class’s choice: the plan, why, and the cart. The newest choice is the class’s active shopping plan.',
    },
    choice_format: fields(choiceSchema),
    data_sources: [
      'plan_id: the id of a saved plan from list_meal_plans.',
      'need_ids come from get_plan_ingredients. Every line of the cart lists the needs it covers.',
      'Products and prices in the cart are the Shopper Agent’s: the Pricer’s products, or others it chose at Kroger.',
    ],
    checks: {
      structure: ['Every field and type in choice_format; fields that are not listed are rejected.', 'The plan must exist, and every dinner in it must have a Kroger cart.'],
      cart: ['Every need of the plan is covered by exactly one line, and no line names a need that isn’t the plan’s.', 'Each line’s cost_usd is packages × price_usd, and total_usd is the sum of the lines.'],
    },
    limits: ['None: a later choice replaces an earlier one as the class’s.'],
    storage_and_handoff: ['The choice, its reason and its cart are shown on the Shopper page, and every request and answer on the Coordinator page.'],
    answers: {
      ingredients: '{ "plan_id", "group", "dinners": [{ "day", "name", "pricer_people", "needs": [{ "need_id", "ingredient", "recipe_line", "estimated", "product": { "id", "description", "brand", "size", "price_usd", "image_url" }, "packages_for_pricer_people", "substitute_for", "estimate_reason" }], "not_bought" }] }',
      saved: '{ "saved": true, "id": …, "plan_id": …, "total_usd": …, "people": … }',
      rejected: REJECTED,
    },
    example: { plan_id: '<id from list_meal_plans>', reason: 'team-3’s plan passes every check at $2.40 a dinner, the cheapest of the three that do, and four of its five dinners were picked by more than one group.', cart: { people: 50, lines: [{ product_id: '0001111060903', description: 'Kroger Yellow Onions', size: '3 lb', price_usd: 3.49, packages: 2, cost_usd: 6.98, needs: ['mon-2', 'wed-1'] }], total_usd: 6.98 } },
  }),
};

export const contract = async (agent) => CONTRACTS[agent](await getSettings());
