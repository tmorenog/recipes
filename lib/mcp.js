// MCP server with three tools. The rules live in lib/recipes.js, shared with
// the REST API.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { recipeSchema, listSchema, saveRecipe, listRecipes, markProcessed } from './recipes.js';
import { planSchema, savePlan } from './plans.js';
import { storesSchema, productsSchema, findStores, searchProducts } from './kroger.js';

const INSTRUCTIONS = `Shared recipe database for the class. Your group key identifies your group.
Recipe Scout: store each recipe you find with save_recipe.
Meal Planner: read recipes with list_recipes (by default only "new" ones); price ingredients
with find_kroger_stores then search_kroger_products; store your 5-meal plan with
save_meal_plan; then call mark_processed for each recipe you used.
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

export function createMcpServer(group) {
  const server = new SharedRulesMcpServer({ name: 'recipes', version: '2.0.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'save_recipe',
    {
      title: 'Save a recipe',
      description:
        'Store one recipe under your group. Incomplete recipes and duplicates (your group already saved this ' +
        'meal_id for this theme) are rejected with the reasons.',
      inputSchema: recipeSchema,
    },
    async (input) => {
      const res = await saveRecipe({ group, channel: 'mcp', input });
      return res.ok ? reply({ saved: true, id: res.recipe.id, status: res.recipe.status }) : rejected(res.errors);
    },
  );

  server.registerTool(
    'list_recipes',
    {
      title: 'List recipes',
      description: 'Recipes from every group, newest first. By default only "new" ones, which nobody has marked processed.',
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
    'save_meal_plan',
    {
      title: 'Save a meal plan',
      description:
        'Store your group’s 5-meal plan with costs, nutrition and a Kroger shopping list. Checked before saving: ' +
        'exactly 5 meals on different days, recipes exist and aren’t repeated, cost_per_serving_usd = cost_used_usd ÷ servings, ' +
        'and total_cost_usd = the shopping list total. Afterwards, mark the recipes you used as processed.',
      inputSchema: planSchema,
    },
    async (input) => {
      const res = await savePlan({ group, channel: 'mcp', input });
      if (!res.ok) return rejected(res.errors);
      return reply({ saved: true, id: res.plan.id, warnings: res.warnings, next_step: res.next_step });
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
