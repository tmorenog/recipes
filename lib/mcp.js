// MCP server with three tools. The rules live in lib/recipes.js, shared with
// the REST API.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { recipeSchema, listSchema, saveRecipe, listRecipes, markProcessed } from './recipes.js';

const INSTRUCTIONS = `Shared recipe database for the class. Your group key identifies your group.
Recipe Scout: store each recipe you find with save_recipe.
Meal Planner: read recipes with list_recipes (by default only "new" ones), then call
mark_processed for each recipe you use so no one uses it twice.
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

  return server;
}
