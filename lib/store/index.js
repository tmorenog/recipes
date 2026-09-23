// Where recipes are stored. Supabase (through its API, with the service role
// key) is the default; a plain Postgres connection string is the fallback.
//
// Every store has the same methods:
//   insertRecipe(row)                 -> { row } or { duplicate: true }
//   listRecipes({ status, theme, group, limit }) -> rows, newest first
//   markProcessed(id, group)          -> the updated row, or null if it wasn't "new"
//   getRecipe(id)                     -> row or null
//   logActivity(entry)
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
  const sb = supabaseSettings(env);
  if (sb.url && sb.key) return 'supabase';
  if (databaseUrl({ env })) return 'postgres';
  return null;
}

export function getStore() {
  if (!store) {
    const backend = configuredBackend();
    if (backend === 'supabase') store = supabaseStore(supabaseSettings());
    else if (backend === 'postgres') store = postgresStore(databaseUrl());
    else {
      throw new StoreError(
        'No database is connected: this project needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
          '(Vercel adds them when you connect a Supabase database in Storage).',
      );
    }
  }
  return store;
}

// Tests supply their own store.
export function setStore(s) {
  store = s;
}
