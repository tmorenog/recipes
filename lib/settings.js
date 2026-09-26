// The coordinator's limits and checks, set by the instructor on the Admin page
// and stored in the database. The coordinator enforces them and describes them
// to the agents (get_contract), so agents never hard-code them.
import { z } from 'zod';
import { getStore } from './store/index.js';

// Ready-made sets of meal-plan rules the instructor can start from on the
// Admin page. Every rule is listed, so choosing a preset replaces them all.
const OFF = {
  min_cuisines: 0, max_same_category: 0, require_vegetarian: false, no_category_twice_in_a_row: false,
  max_dinner_usd: 0, max_minutes: 0, excluded_ingredients: '', min_popular: 0,
};
export const PLAN_PRESETS = {
  standard: { name: 'Standard', about: 'Variety and one vegetarian night.', checks: { ...OFF, min_cuisines: 3, max_same_category: 2, require_vegetarian: true } },
  budget: { name: 'Budget week', about: 'No single dinner over $4 per person.', checks: { ...OFF, min_cuisines: 2, max_same_category: 2, max_dinner_usd: 4 } },
  allergy: {
    name: 'Allergy-aware',
    about: 'The standard rules, and no nuts or shellfish.',
    checks: { ...OFF, min_cuisines: 3, max_same_category: 2, require_vegetarian: true, excluded_ingredients: 'peanut, almond, cashew, walnut, pecan, hazelnut, pistachio, shrimp, prawn, crab, lobster, mussel, clam, oyster, scallop' },
  },
  world: { name: 'World tour', about: 'Five cuisines, and never the same kind of dish two days running.', checks: { ...OFF, min_cuisines: 5, max_same_category: 2, no_category_twice_in_a_row: true } },
  quick: { name: 'Quick dinners', about: 'Every dinner ready in 30 minutes.', checks: { ...OFF, min_cuisines: 2, max_same_category: 2, max_minutes: 30 } },
  favourites: { name: 'Crowd favourites', about: 'At least three dinners more than one group picked.', checks: { ...OFF, min_cuisines: 2, max_same_category: 2, min_popular: 3 } },
};

export const DEFAULTS = {
  max_recipes_per_group: 10,     // saved picks per group; 0 = no limit
  verify_recipes: true,          // check each recipe against TheMealDB before storing it
  max_plans_per_group: 10,       // saved meal plans per group; 0 = no limit
  max_saves_per_minute: 20,      // save attempts (recipes and plans) per group per minute; 0 = no limit
  max_class_saves_per_minute: 120, // the same for the whole class together; 0 = no limit
  max_kroger_per_minute: 30,     // Kroger look-ups (/api/kroger, the MCP Kroger tools) per group per minute; 0 = no limit
  max_class_kroger_per_minute: 300, // the same for the whole class together (the Pricer and Shopper don't count); 0 = no limit
  auto_pricing: true,            // new recipes go straight to the Recipe Pricer's queue
  max_priced_per_hour: 60,
  auto_shopper_after_plans: 10, // with no class plan yet, the Shopper Agent starts by itself once this many plans are saved; 0 = only when the instructor runs it       // recipes the Recipe Pricer finishes per hour; 0 = no limit
  checks: PLAN_PRESETS.standard.checks, // the meal-plan rules; see PLAN_PRESETS
};

const count = (max) => z.number().int().min(0).max(max);
// The meal-plan rules, each off at 0, false or "" (the budget is always checked).
const checksSchema = z.strictObject({
  min_cuisines: count(5),               // at least N different cuisines
  max_same_category: count(5),          // no category more than N times
  require_vegetarian: z.boolean(),      // at least one vegetarian or vegan dinner
  no_category_twice_in_a_row: z.boolean(),
  max_dinner_usd: z.number().min(0).max(100), // no dinner costs more than this per person
  max_minutes: count(600),              // no dinner takes longer (the Scout Agent's estimate)
  excluded_ingredients: z.string().trim().max(300), // comma-separated: no dinner contains any
  min_popular: count(5),                // at least N dinners picked by two or more groups
});
export const settingsSchema = z.strictObject({
  max_recipes_per_group: count(1000),
  verify_recipes: z.boolean(),
  max_plans_per_group: count(1000),
  max_saves_per_minute: count(1000),
  max_class_saves_per_minute: count(10000),
  max_kroger_per_minute: count(1000),
  max_class_kroger_per_minute: count(10000),
  auto_pricing: z.boolean(),
  max_priced_per_hour: count(1000),
  auto_shopper_after_plans: count(1000),
  checks: checksSchema,
});

// Only settings that still exist are kept (stored settings can name retired
// ones, e.g. the nutrition checks).
const known = (obj, defaults) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => k in defaults));
const merge = (stored) => {
  const s = stored && typeof stored === 'object' ? stored : {};
  return { ...DEFAULTS, ...known(s, DEFAULTS), checks: { ...OFF, ...DEFAULTS.checks, ...known(s.checks, DEFAULTS.checks) } };
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
  // Checked and counted in one step, so saves sent at the same moment can't pass it together.
  const over = await store.takeRateSlot('save', group, { perGroup: s.max_saves_per_minute, perClass: s.max_class_saves_per_minute });
  if (over?.scope === 'group') {
    return { status: 429, errors: [`too many save attempts: each group can make at most ${over.max} a minute. Wait a minute, then try again.`] };
  }
  if (over) {
    return { status: 429, errors: [`too many save attempts: the whole class can make at most ${over.max} a minute together. Wait a minute, then try again.`] };
  }
  const usage = await store.groupUsage(group);
  if (kind === 'recipe' && s.max_recipes_per_group > 0 && usage.picks >= s.max_recipes_per_group) return totalLimit('recipe', usage.picks, s.max_recipes_per_group);
  if (kind === 'plan' && s.max_plans_per_group > 0 && usage.plans >= s.max_plans_per_group) return totalLimit('plan', usage.plans, s.max_plans_per_group);
  return null;
}

// Kroger look-ups with the class's credentials (/api/kroger and the MCP Kroger
// tools), per group and for the whole class. The site's own agents (Pricer,
// Shopper) call Kroger directly and aren't counted. Returns null, or { status, errors }.
export async function krogerLimitFor(group) {
  const s = await getSettings();
  let over;
  try {
    over = await getStore().takeRateSlot('kroger', group ?? 'unknown', { perGroup: s.max_kroger_per_minute, perClass: s.max_class_kroger_per_minute });
  } catch (e) {
    console.error('Kroger limit not checked:', e.message); // no database: Kroger still answers
    return null;
  }
  if (!over) return null;
  const who = over.scope === 'group' ? 'each group can make' : 'the whole class can make';
  return { status: 429, errors: [`too many Kroger look-ups: ${who} at most ${over.max} a minute${over.scope === 'class' ? ' together' : ''}. Wait a minute and reuse the results you already have.`] };
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
