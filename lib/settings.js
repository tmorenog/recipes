// The coordinator's limits and checks, set by the instructor on the Admin page
// and stored in the database. The coordinator enforces them and describes them
// to the agents (get_contract), so agents never hard-code them.
import { z } from 'zod';
import { getStore } from './store/index.js';

export const DEFAULTS = {
  max_recipes_per_group: 10,     // saved picks per group; 0 = no limit
  verify_recipes: true,          // check each recipe against TheMealDB before storing it
  max_plans_per_group: 10,       // saved meal plans per group; 0 = no limit
  max_saves_per_minute: 20,      // save attempts (recipes and plans) per group per minute; 0 = no limit
  auto_pricing: true,            // new recipes go straight to the Recipe Pricer's queue
  max_priced_per_hour: 60,       // recipes the Recipe Pricer finishes per hour; 0 = no limit
  checks: {                      // what check_meal_plan and save_meal_plan check, from the stored data
    min_cuisines: 3,
    max_same_category: 2,
    require_vegetarian: true,
  },
};

const count = (max) => z.number().int().min(0).max(max);
const checksSchema = z.strictObject({
  min_cuisines: count(5),
  max_same_category: count(5).min(1),
  require_vegetarian: z.boolean(),
});
export const settingsSchema = z.strictObject({
  max_recipes_per_group: count(1000),
  verify_recipes: z.boolean(),
  max_plans_per_group: count(1000),
  max_saves_per_minute: count(1000),
  auto_pricing: z.boolean(),
  max_priced_per_hour: count(1000),
  checks: checksSchema,
});

// Only settings that still exist are kept (stored settings can name retired
// ones, e.g. the nutrition checks).
const known = (obj, defaults) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => k in defaults));
const merge = (stored) => {
  const s = stored && typeof stored === 'object' ? stored : {};
  return { ...DEFAULTS, ...known(s, DEFAULTS), checks: { ...DEFAULTS.checks, ...known(s.checks, DEFAULTS.checks) } };
};

// Read at most every few seconds per server instance: every save checks them.
let cache = null;
export async function getSettings() {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  let value = DEFAULTS;
  try {
    value = merge(await getStore().getSettings());
  } catch {
    /* no database or table yet: the defaults apply */
  }
  cache = { at: Date.now(), value };
  return value;
}
export const forgetSettings = () => { cache = null; };

// Saves a partial change (or {reset: true}); checks the whole result first.
export async function saveSettings(input) {
  if (input?.reset === true) {
    await getStore().setSettings(null);
    forgetSettings();
    return { ok: true, settings: DEFAULTS };
  }
  const current = await getSettings();
  const next = { ...current, ...(input || {}), checks: { ...current.checks, ...(input?.checks || {}) } };
  const parsed = settingsSchema.safeParse(next);
  if (!parsed.success) {
    return { ok: false, status: 400, errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  await getStore().setSettings(parsed.data);
  forgetSettings();
  return { ok: true, settings: parsed.data };
}

// The per-group limits, checked before a save. kind: 'recipe' or 'plan'.
// Returns null, or { status, errors } to reject the save with.
export async function limitFor(group, kind) {
  const s = await getSettings();
  const store = getStore();
  if (s.max_saves_per_minute > 0) {
    const recent = await store.recentAttempts(group, new Date(Date.now() - 60_000).toISOString());
    if (recent >= s.max_saves_per_minute) {
      return { status: 429, errors: [`too many save attempts: each group can make at most ${s.max_saves_per_minute} a minute. Wait a minute, then try again.`] };
    }
  }
  const usage = await store.groupUsage(group);
  if (kind === 'recipe' && s.max_recipes_per_group > 0 && usage.picks >= s.max_recipes_per_group) return totalLimit('recipe', usage.picks, s.max_recipes_per_group);
  if (kind === 'plan' && s.max_plans_per_group > 0 && usage.plans >= s.max_plans_per_group) return totalLimit('plan', usage.plans, s.max_plans_per_group);
  return null;
}

// A group that has saved as many recipes (or plans) as the class allows.
export function totalLimit(kind, n, max) {
  return {
    status: 403,
    errors: [kind === 'recipe'
      ? `your group has already saved ${n} recipes, the most this class allows (${max}). Nothing more can be saved unless the instructor raises the limit.`
      : `your group has already saved ${n} meal plans, the most this class allows (${max}). Use check_meal_plan to try ideas without saving.`],
  };
}
