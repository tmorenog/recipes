// Where recipes are stored: the Postgres database connected in Vercel's
// Storage tab (Neon). Its connection string is POSTGRES_URL or DATABASE_URL.
//
// The store's methods:
//   insertRecipe(row)                 -> { row } or { duplicate: true }
//   listRecipes({ status, theme, group, limit }) -> rows, newest first
//   markProcessed(id, group)          -> the updated row, or null if it wasn't "new"
//   getRecipe(id)                     -> row or null
//   recipeStatuses(ids)               -> Map of id -> status, for the ids that exist
//   insertPlan(row) / listPlans({ group, limit })
//   listActivity({ group, ok, limit }) / logActivity(entry)
//   updateRecipe / deleteRecipe / deletePlan / clearActivity / exportAll / replaceAll   (admin)
//   tablesExist()                     -> true / false
// Rows use the database column names (group_name, ...).
import { databaseUrl } from '../db.js';
import { postgresStore } from './postgres.js';
import { StoreError } from './errors.js';

export { StoreError };

export const NOT_CONNECTED =
  'No database is connected: in Vercel, open Storage, create a Neon (Postgres) database, connect it to this project, and redeploy.';

let store;

export const databaseConnected = () => Boolean(store || databaseUrl());

export function getStore() {
  if (!store) {
    const url = databaseUrl();
    if (!url) throw new StoreError(NOT_CONNECTED);
    store = postgresStore(url);
  }
  return store;
}

// Tests supply their own store.
export function setStore(s) {
  store = s;
}
