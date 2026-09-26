// MCP server for the class database. The rules live in lib/recipes.js and
// lib/plans.js, shared with the REST API. With ?agent=scout or ?agent=planner
// an agent sees only its own tools, plus get_contract.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { recipeSchema, listSchema, saveRecipe, listRecipes, markProcessed } from './recipes.js';
import { planSchema, savePlan, checkPlan } from './plans.js';
import { storesSchema, productsSchema, findStores, searchProducts } from './kroger.js';
import { AGENTS, contract } from './contract.js';
import { planSchema as planIdSchema, choiceSchema, listPlansForShopper, planIngredients, saveChoice } from './shopper.js';

// What an app reads first when it connects: which group it is, and what this
// coordinator does for its agent.
const INSTRUCTIONS = {
  scout: 'Save your Scout Agent’s recipes with save_recipe.',
  planner: 'Read the priced recipes with list_recipes, check a draft with check_meal_plan (it saves nothing), then save your plan with save_meal_plan.',
  shopper: 'Compare the saved plans with list_meal_plans, read a plan’s ingredients with get_plan_ingredients, then save the class’s choice and its cart with save_choice.',
  all:
    'Scout Agents save recipes with save_recipe. Meal Planner Agents read the priced recipes with list_recipes, check a draft with ' +
    'check_meal_plan and save a plan with save_meal_plan. The Shopper Agent compares plans with list_meal_plans, reads a plan’s ' +
    'ingredients with get_plan_ingredients and saves the class’s choice with save_choice. The Recipe Pricer prices every recipe on its own; see /pricer.',
};
const instructions = (hello, agent) =>
  `${hello}This is the Meal Squad coordinator: it checks and stores the class’s recipes and meal plans and passes them between the agents. ` +
  `Start with get_contract. ${INSTRUCTIONS[agent || 'all']} ` +
  'A rejected call lists every problem at once: fix them all and call again.';

// The save format each agent's get_contract explains.
const FORMATS = {
  scout: 'the exact format save_recipe accepts',
  planner: 'the exact format check_meal_plan and save_meal_plan accept',
  shopper: 'the exact format save_choice accepts',
};

const reply = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError && { isError: true }),
});
// Said when a save adds a pick to a recipe that was already stored.
function pickNote(pickedBy = [], group) {
  const n = pickedBy.length;
  return pickedBy.some((g) => g !== group)
    ? `Another group had already saved this recipe, so your pick was added to it. It has now been picked by ${n} group${n === 1 ? '' : 's'}.`
    : 'Your group had already saved this recipe for another theme, so this pick was added to it.';
}
const rejected = (errors) => reply(`Rejected:\n- ${errors.join('\n- ')}`, true);

// The input schemas are published so agents know the exact format, but the
// SDK's own validation is skipped: lib/recipes.js validates instead, so MCP
// and REST give the same readable reasons and every rejection is logged.
// validateToolInput is internal to the SDK, hence the exact version pin in
// package.json; the tests fail if an upgrade changes it.
class SharedRulesMcpServer extends McpServer {
  async validateToolInput(tool, args) {
    return args;
  }
}

const TOOLS = {
  scout: ['get_contract', 'save_recipe'],
  planner: ['get_contract', 'list_recipes', 'check_meal_plan', 'save_meal_plan'],
  shopper: ['get_contract', 'list_meal_plans', 'get_plan_ingredients', 'save_choice'],
};

export function createMcpServer(group, { agent = null } = {}) {
  // The first thing an app receives says back which group the coordinator knows it as.
  const hello = group ? `You’re connected as group “${group}”. ` : '';
  const server = new SharedRulesMcpServer(
    { name: 'Meal Squad coordinator', title: 'Meal Squad coordinator', version: '1.0' },
    { instructions: instructions(hello, agent) },
  );
  if (agent) {
    const allowed = new Set(TOOLS[agent]);
    const register = server.registerTool.bind(server);
    server.registerTool = (name, ...rest) => (allowed.has(name) ? register(name, ...rest) : undefined);
  }

  server.registerTool(
    'get_contract',
    {
      title: 'How to work with the coordinator',
      // The group is also in this description, since some apps show only the tool list when they connect.
      description:
        `${hello}Call this first. It explains your agent’s role, the tools, ${FORMATS[agent] || 'the exact format each save tool accepts'}, ` +
        'what the coordinator checks, its limits and what happens to what you save, with an example.',
      inputSchema: z.strictObject({
        agent: z.enum(AGENTS).optional().describe(agent ? `Defaults to "${agent}"` : '"scout" (Scout Agent), "planner" (Meal Planner Agent) or "shopper" (Shopper Agent)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const which = input?.agent ?? agent;
      if (!AGENTS.includes(which)) return rejected([`agent must be one of: ${AGENTS.join(', ')}`]);
      return reply({ ...(group && { your_group: group }), ...(await contract(which)) });
    },
  );

  server.registerTool(
    'save_recipe',
    {
      title: 'Save a recipe',
      description:
        'Saves one TheMealDB recipe for your group. If another group already saved the same recipe, your pick is added to it ' +
        'and counts toward its popularity. Incomplete recipes, and the same recipe twice for one theme, are rejected with the reasons.',
      inputSchema: recipeSchema,
    },
    async (input) => {
      const res = await saveRecipe({ group, channel: 'mcp', input });
      if (!res.ok) return rejected(res.errors);
      const r = res.recipe;
      return reply({
        saved: true,
        id: r.id,
        new_recipe: res.created,
        picked_by: r.picked_by,
        ...(!res.created && { note: pickNote(r.picked_by, group) }),
        ...(res.notes?.length && { format_notes: res.notes }),
      });
    },
  );

  server.registerTool(
    'list_recipes',
    {
      title: 'List the class’s recipes',
      description:
        'The recipes every group saved, newest first, each stored once, with its popularity (pick_count, and picked_by: the groups ' +
        'that chose it) and its pricing from the Recipe Pricer. ' +
        (agent === 'planner'
          ? 'Pass {"priced": true} for only the recipes you can plan with. Returns up to 500.'
          : 'By default only "new" ones, which nobody has marked processed.'),
      // The Meal Planner's published defaults are what it gets: every recipe, up to 500.
      inputSchema: agent === 'planner'
        ? listSchema.extend({
          status: listSchema.shape.status.unwrap().default('all').describe('Default "all": every recipe'),
          limit: listSchema.shape.limit.unwrap().default(500),
        })
        : listSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      // The Meal Planner chooses from every recipe; "processed" is a handoff marker for other workflows.
      const res = await listRecipes(agent === 'planner' ? { status: 'all', limit: 500, ...(input || {}) } : input);
      return res.ok ? reply({ count: res.count, recipes: res.recipes }) : rejected(res.errors);
    },
  );

  server.registerTool(
    'mark_processed',
    {
      title: 'Mark a recipe processed',
      description:
        'Record that your group has used this recipe, so it no longer appears in list_recipes with status "new". ' +
        'Marking an already processed recipe changes nothing.',
      inputSchema: z.strictObject({ recipe_id: z.uuid().describe('The id from list_recipes') }),
      annotations: { idempotentHint: true },
    },
    async (input) => {
      const res = await markProcessed({ group, channel: 'mcp', id: input?.recipe_id });
      if (!res.ok) return rejected(res.errors);
      const r = res.recipe;
      return reply(
        res.already
          ? { processed: true, note: `already processed by ${r.processed_by} at ${new Date(r.processed_at).toISOString()}`, id: r.id }
          : { processed: true, id: r.id },
      );
    },
  );

  const planDescription =
    'A plan is five dinners, Monday to Friday, chosen from priced recipes, plus the budget: the most a dinner may cost on average, ' +
    'in US dollars per person. The coordinator looks up each dinner’s cost from the Recipe Pricer, adds up the week and checks the budget and variety rules.';

  server.registerTool(
    'check_meal_plan',
    {
      title: 'Check a meal plan',
      description: `Checks a draft plan without saving it. ${planDescription} Returns the week’s cost per person and every rule, passed or not.`,
      inputSchema: planSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const res = await checkPlan(input);
      if (!res.ok) return rejected(res.errors);
      const { ok, ...result } = res;
      return reply(result);
    },
  );

  server.registerTool(
    'save_meal_plan',
    {
      title: 'Save a meal plan',
      description: `Saves your group’s plan, after the same checks. ${planDescription} A plan that breaks a rule is still saved, with that rule marked as failed, so check it first.`,
      inputSchema: planSchema,
    },
    async (input) => {
      const res = await savePlan({ group, channel: 'mcp', input });
      if (!res.ok) return rejected(res.errors);
      const { ok, plan, ...result } = res;
      return reply({ saved: true, id: plan.id, ...result });
    },
  );

  server.registerTool(
    'list_meal_plans',
    {
      title: 'List the saved meal plans',
      description: 'Every plan the Meal Planner Agents saved, newest first: its costs, the checks it passed and failed, and its five dinners, each with picked_by (the groups that chose the recipe).',
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const plans = await listPlansForShopper();
      return reply({ count: plans.length, plans });
    },
  );

  server.registerTool(
    'get_plan_ingredients',
    {
      title: 'Read a plan’s ingredients',
      description:
        'For each dinner of a saved plan, the Recipe Pricer’s cart: every ingredient it bought or estimated, as a need with a need_id, ' +
        'the product the Pricer chose and the share of a package the recipe uses for pricer_people. Saves nothing.',
      inputSchema: planIdSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const res = await planIngredients(input);
      if (!res.ok) return rejected(res.errors);
      const { ok, plan, ...data } = res;
      return reply(data);
    },
  );

  server.registerTool(
    'save_choice',
    {
      title: 'Save the class’s choice',
      description: 'Saves the plan you choose for the class, why you chose it, and the week’s Kroger cart you built for it. The coordinator checks that the cart covers every need of the plan exactly once and that its sums add up. The newest choice is the class’s.',
      inputSchema: choiceSchema,
    },
    async (input) => {
      const res = await saveChoice(input);
      if (!res.ok) return rejected(res.errors);
      const c = res.choice;
      return reply({ saved: true, id: c.id, plan_id: c.plan_id, total_usd: c.total_usd, people: c.people, ...(res.notes && { format_notes: res.notes }) });
    },
  );

  server.registerTool(
    'find_kroger_stores',
    {
      title: 'Find Kroger stores',
      description: 'Kroger stores near a US ZIP code. Prices depend on the store, so pick one and use its store_id for every search.',
      inputSchema: storesSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const res = await findStores(input);
      return res.ok ? reply({ count: res.count, stores: res.stores }) : rejected(res.errors);
    },
  );

  server.registerTool(
    'search_kroger_products',
    {
      title: 'Search Kroger products',
      description:
        'Products matching a search at one Kroger store, with package size and price in US dollars. ' +
        'Pick the product that matches the ingredient’s form and a sensible size, e.g. "garlic", not "garlic powder".',
      inputSchema: productsSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const res = await searchProducts(input);
      return res.ok ? reply({ count: res.count, products: res.products, note: res.note }) : rejected(res.errors);
    },
  );

  return server;
}
