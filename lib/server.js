// The MCP server: four tools over the recipes database.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  recipeSchema,
  listRecipesSchema,
  markProcessedSchema,
  mealPlanSchema,
  checkMealPlan,
} from './schemas.js';

const INSTRUCTIONS = `Shared recipe database for two agents.
Recipe Scout: find recipes and store each one with save_recipe.
Meal Planner: read unused recipes with list_recipes (status "new"), store the plan with
save_meal_plan, then call mark_processed with the recipe ids the plan used.
Every write is validated. A rejected call returns the reasons; fix them and call again.`;

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const rejected = (errors) => ({
  content: [{ type: 'text', text: `Rejected:\n- ${errors.join('\n- ')}` }],
  isError: true,
});

// Logs calls that fail schema validation, which the SDK rejects before any
// tool handler runs. validateToolInput is internal to the SDK, which is why
// package.json pins an exact SDK version.
class LoggedMcpServer extends McpServer {
  constructor(info, options, onInvalid) {
    super(info, options);
    this.onInvalid = onInvalid;
  }

  async validateToolInput(tool, args, name) {
    try {
      return await super.validateToolInput(tool, args, name);
    } catch (e) {
      await this.onInvalid(name, args, e.message);
      throw e;
    }
  }
}

export function createMcpServer({ db, caller = 'unknown' }) {
  const log = (tool, ok, input, error = null) => db.logCall({ tool, caller, ok, input: input ?? null, error });

  const server = new LoggedMcpServer(
    { name: 'recipes-db', version: '1.0.0' },
    { instructions: INSTRUCTIONS },
    (tool, input, error) => log(tool, false, input, error),
  );

  server.registerTool(
    'save_recipe',
    {
      title: 'Save a recipe',
      description:
        'Store one recipe for the Meal Planner. Every field is checked; malformed recipes and ' +
        'duplicates (same theme and meal_id) are rejected with the reasons.',
      inputSchema: recipeSchema,
    },
    async (recipe) => {
      const res = await db.saveRecipe(recipe, caller === 'unknown' ? 'recipe-scout' : caller);
      if (res.duplicate) {
        const error = `a recipe with meal_id "${recipe.meal_id}" is already saved for theme "${recipe.theme}"`;
        await log('save_recipe', false, recipe, error);
        return rejected([error]);
      }
      await log('save_recipe', true, recipe);
      return json({ saved: true, id: res.id, status: 'new' });
    },
  );

  server.registerTool(
    'list_recipes',
    {
      title: 'List recipes',
      description:
        'Recipes in the agreed format, oldest first. By default only "new" ones, which no planner has used yet.',
      inputSchema: listRecipesSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const recipes = await db.listRecipes(args);
      await log('list_recipes', true, args);
      return json({ count: recipes.length, recipes });
    },
  );

  server.registerTool(
    'mark_processed',
    {
      title: 'Mark recipes processed',
      description:
        'Record that a planner has used these recipes, so they stop appearing in list_recipes(status "new"). ' +
        'Only "new" recipes change; the result lists any that were already processed or do not exist.',
      inputSchema: markProcessedSchema,
      annotations: { idempotentHint: true },
    },
    async ({ recipe_ids, processed_by }) => {
      const ids = [...new Set(recipe_ids)];
      const statuses = await db.getRecipeStatuses(ids);
      const not_found = ids.filter((id) => !statuses.has(id));
      const already_processed = ids.filter((id) => statuses.get(id) === 'processed');
      const toUpdate = ids.filter((id) => statuses.get(id) === 'new');
      const updated = toUpdate.length ? await db.markProcessed(toUpdate, processed_by ?? caller) : [];
      const input = { recipe_ids, processed_by };
      if (not_found.length) {
        await log('mark_processed', false, input, `not found: ${not_found.join(', ')}`);
      } else {
        await log('mark_processed', true, input);
      }
      return { ...json({ updated, already_processed, not_found }), isError: not_found.length > 0 };
    },
  );

  server.registerTool(
    'save_meal_plan',
    {
      title: 'Save a meal plan',
      description:
        'Store a 5-meal plan with its costs, nutrition and Kroger shopping list. Checked before saving: ' +
        'recipes must exist, days and recipes must not repeat, cost_per_serving must equal cost_used / servings, ' +
        'and total_cost_usd must equal the shopping list total. Call mark_processed afterwards.',
      inputSchema: mealPlanSchema,
    },
    async (plan) => {
      const ids = plan.meals.map((m) => m.recipe_id);
      const statuses = await db.getRecipeStatuses(ids);
      const { errors, warnings } = checkMealPlan(plan, statuses);
      if (errors.length) {
        await log('save_meal_plan', false, plan, errors.join('; '));
        return rejected(errors);
      }
      const planId = await db.saveMealPlan(plan);
      await log('save_meal_plan', true, plan);
      const stillNew = ids.filter((id) => statuses.get(id) === 'new');
      return json({
        saved: true,
        plan_id: planId,
        warnings,
        next_step: stillNew.length ? `call mark_processed with these recipe_ids: ${stillNew.join(', ')}` : null,
      });
    },
  );

  return server;
}
