// Where recipes are stored. A Postgres connection string (POSTGRES_URL /
// DATABASE_URL, e.g. from a database created in Vercel's Storage tab) is
// preferred, because then every deploy creates the tables automatically.
// Without one, Supabase's API is used (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY),
// and the tables must be created once in Supabase's SQL Editor.
//
// Every store has the same methods:
//   insertRecipe(row)                 -> { row } or { duplicate: true }
//   listRecipes({ status, theme, group, limit }) -> rows, newest first
//   markProcessed(id, group)          -> the updated row, or null if it wasn't "new"
//   getRecipe(id)                     -> row or null
//   recipeStatuses(ids)               -> Map of id -> status, for the ids that exist
//   insertPlan(row) / listPlans({ group, limit })
//   listActivity({ group, ok, limit }) / logActivity(entry)
//   tablesExist()                     -> true / false
// Rows use the database column names (group_name, ...).
import { supabaseSettings } from '../env.js';
import { databaseUrl } from '../db.js';
import { supabaseStore } from './supabase.js';
import { postgresStore } from './postgres.js';
import { StoreError } from './errors.js';

export { StoreError };

let store;

export function configuredBackend(env = process.env) {
  if (store && env === process.env) return store.backend;
  if (databaseUrl({ env })) return 'postgres';
  const sb = supabaseSettings(env);
  if (sb.url && sb.key) return 'supabase';
  return null;
}

export function getStore() {
  if (!store) {
    const backend = configuredBackend();
    if (backend === 'postgres') store = postgresStore(databaseUrl());
    else if (backend === 'supabase') store = supabaseStore(supabaseSettings());
    else {
      throw new StoreError(
        'No database is connected: in Vercel, open Storage, create a Postgres database, connect it to this project, and redeploy.',
      );
    }
  }
  return store;
}

// Tests supply their own store.
export function setStore(s) {
  store = s;
}
