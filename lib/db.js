// Supabase access for the MCP tools. Uses the service role key, so it must
// only ever run on the server.
import { createClient } from '@supabase/supabase-js';

export const RECIPE_COLUMNS =
  'id, theme, meal_id, name, category, cuisine, ingredients, instructions, est_minutes, est_servings, ' +
  'image_url, source_url, why_chosen, status, created_by, created_at, processed_at, processed_by';

const UNIQUE_VIOLATION = '23505';

function fail(what, error) {
  const err = new Error(`Database error while ${what}: ${error.message}`);
  err.cause = error;
  return err;
}

// Vercel's Supabase integration sets SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
// The alternatives cover projects set up by hand or with Supabase's newer secret keys.
const env = (...names) => names.map((n) => process.env[n]).find(Boolean);

export function supabaseDb(
  url = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'),
  key = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'),
) {
  if (!url || !key) {
    throw new Error(
      'Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) on the server.',
    );
  }
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  return {
    async saveRecipe(recipe, createdBy) {
      const { data, error } = await sb
        .from('recipes')
        .insert({ ...recipe, created_by: createdBy })
        .select('id')
        .single();
      if (error?.code === UNIQUE_VIOLATION) return { duplicate: true };
      if (error) throw fail('saving the recipe', error);
      return { id: data.id };
    },

    async listRecipes({ status, theme, limit }) {
      let q = sb.from('recipes').select(RECIPE_COLUMNS).order('created_at', { ascending: true }).limit(limit);
      if (status !== 'all') q = q.eq('status', status);
      if (theme) q = q.eq('theme', theme);
      const { data, error } = await q;
      if (error) throw fail('listing recipes', error);
      return data;
    },

    async getRecipeStatuses(ids) {
      const { data, error } = await sb.from('recipes').select('id, status').in('id', ids);
      if (error) throw fail('looking up recipes', error);
      return new Map(data.map((r) => [r.id, r.status]));
    },

    async markProcessed(ids, processedBy) {
      const { data, error } = await sb
        .from('recipes')
        .update({ status: 'processed', processed_at: new Date().toISOString(), processed_by: processedBy })
        .in('id', ids)
        .eq('status', 'new')
        .select('id');
      if (error) throw fail('marking recipes processed', error);
      return data.map((r) => r.id);
    },

    async saveMealPlan(plan) {
      const { data, error } = await sb.rpc('save_meal_plan', { plan });
      if (error) throw fail('saving the meal plan', error);
      return data;
    },

    async logCall(entry) {
      // Logging must never break a tool call.
      const { error } = await sb.from('mcp_calls').insert(entry);
      if (error) console.error('mcp_calls insert failed:', error.message);
    },
  };
}
