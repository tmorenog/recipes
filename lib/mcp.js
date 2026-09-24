// MCP server for the class database. The rules live in lib/recipes.js and
// lib/plans.js, shared with the REST API. With ?agent=scout or ?agent=planner
// an agent sees only its own tools, plus get_expectations.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { recipeSchema, listSchema, saveRecipe, listRecipes, markProcessed } from './recipes.js';
import { planSchema, savePlan, checkPlan } from './plans.js';
import { storesSchema, productsSchema, findStores, searchProducts } from './kroger.js';
import { AGENTS, expectations } from './expectations.js';
import { searchFoods } from './usda.js';

const INSTRUCTIONS = `Shared recipe database for the class. The X-Group header you send identifies your group.
Start with get_expectations: it says what your agent must do and the exact format to save.
Recipe Scout: store each recipe you find with save_recipe.
Meal Planner: read priced recipes with list_recipes (priced: true); estimate each dinner's
nutrition (search_foods has USDA values); check a draft of five dinners, Monday to Friday,
with check_meal_plan; then save it with save_meal_plan.
Pricer: an agent on the coordinator prices every saved recipe; see /pricer.
A rejected call explains every problem at once; fix them and call again.`;

const reply = (value, isError = false) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  ...(isError && { isError: true }),
});
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
  scout: ['get_expectations', 'save_recipe', 'list_recipes'],
  planner: ['get_expectations', 'list_recipes', 'search_foods', 'check_meal_plan', 'save_meal_plan'],
};

export function createMcpServer(group, { agent = null } = {}) {
  const server = new SharedRulesMcpServer({ name: 'recipes', version: '2.1.0' }, { instructions: INSTRUCTIONS });
  if (agent) {
    const allowed = new Set(TOOLS[agent]);
    const register = server.registerTool.bind(server);
    server.registerTool = (name, ...rest) => (allowed.has(name) ? register(name, ...rest) : undefined);
  }

  server.registerTool(
    'get_expectations',
    {
      title: 'Read what your agent must do',
      description:
        'Call this first. Returns your agent’s goal, steps and rules, the exact format save_recipe or save_meal_plan ' +
        'accepts (every field, required or optional, and where its value comes from), and an example.',
      inputSchema: z.strictObject({
        agent: z.enum(AGENTS).optional().describe(agent ? `Defaults to "${agent}"` : '"scout" (Recipe Scout) or "planner" (Meal Planner)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const which = input?.agent ?? agent;
      if (!AGENTS.includes(which)) return rejected([`agent must be one of: ${AGENTS.join(', ')}`]);
      return reply(expectations(which));
    },
  );

  server.registerTool(
    'save_recipe',
    {
      title: 'Save a recipe',
      description:
        'Store one recipe under your group. Each TheMealDB recipe is stored once: if another group already saved it, your pick ' +
        'is added to it (the recipe shows how many groups picked it). Incomplete recipes, and a recipe your group already picked ' +
        'for this theme, are rejected with the reasons.',
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
        ...(!res.created && { note: `Another group had already chosen this recipe, so your pick was added to it: now picked by ${r.pick_count} groups.` }),
      });
    },
  );

  server.registerTool(
    'list_recipes',
    {
      title: 'List recipes',
      description:
        'Recipes from every group, newest first. By default only "new" ones, which nobody has marked processed. Each recipe is ' +
        'stored once, with pick_count and picked_by (the groups that chose it: its popularity) and pricing (its price from the Pricer).',
      inputSchema: listSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const res = await listRecipes(input);
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

  server.registerTool(
    'search_foods',
    {
      title: 'Look up nutrition',
      description:
        'Search USDA FoodData Central for a plain food, e.g. "chicken thigh raw" or "chickpeas canned". Returns up to 5 foods with ' +
        'calories, protein, fibre and sodium per 100 g. Use it to estimate each dinner’s nutrition per serving.',
      inputSchema: z.strictObject({ query: z.string().trim().min(2).max(100).describe('A plain food name') }),
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const foods = await searchFoods(String(input?.query ?? ''));
        return reply({ count: foods.length, foods, hint: foods.length ? undefined : 'Nothing found: try a plainer name.' });
      } catch (e) {
        return rejected([e.message]);
      }
    },
  );

  const planDescription =
    'Five dinners, Monday to Friday, from priced recipes, each with your nutrition estimate per serving, and the budget (US dollars per person for the week). ' +
    'The coordinator looks up each dinner’s cost from the Pricer, adds up the week, and checks the balance rules.';

  server.registerTool(
    'check_meal_plan',
    {
      title: 'Check a meal plan',
      description: `Check a draft plan without saving it. ${planDescription} Returns the week’s cost per person and every rule, passed or not.`,
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
      description: `Save your group’s plan. ${planDescription} A plan that breaks a balance rule is still saved, with the rule marked as failed; check it first.`,
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
