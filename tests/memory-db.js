// In-memory stand-in for lib/db.js, with the same behaviour as the Supabase
// schema (unique theme + meal_id, only "new" rows can be marked processed).
import { randomUUID } from 'node:crypto';

export function memoryDb() {
  const recipes = [];
  const plans = [];
  const calls = [];

  return {
    recipes,
    plans,
    calls,

    async addRecipe(recipe, createdBy) {
      if (recipes.some((r) => r.theme === recipe.theme && r.meal_id === recipe.meal_id)) return { duplicate: true };
      const row = {
        id: randomUUID(),
        category: null,
        cuisine: null,
        image_url: null,
        source_url: null,
        ...recipe,
        status: 'new',
        created_by: createdBy,
        created_at: new Date(Date.now() + recipes.length).toISOString(),
        processed_at: null,
        processed_by: null,
      };
      recipes.push(row);
      return { id: row.id };
    },

    async listRecipes({ status, theme, limit }) {
      return recipes
        .filter((r) => status === 'all' || r.status === status)
        .filter((r) => !theme || r.theme === theme)
        .slice(0, limit);
    },

    async getRecipeStatuses(ids) {
      return new Map(recipes.filter((r) => ids.includes(r.id)).map((r) => [r.id, r.status]));
    },

    async markProcessed(ids, processedBy) {
      const done = [];
      for (const r of recipes) {
        if (ids.includes(r.id) && r.status === 'new') {
          Object.assign(r, { status: 'processed', processed_by: processedBy, processed_at: new Date().toISOString() });
          done.push(r.id);
        }
      }
      return done;
    },

    async saveMealPlan(plan) {
      const id = randomUUID();
      plans.push({ id, ...plan });
      return id;
    },

    async logCall(entry) {
      calls.push(entry);
    },
  };
}
