// Database administration: edit or delete records, back up, restore, reset.
// Protected by ADMIN_KEY, which is separate from the class key.
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getStore } from './store/index.js';
import { recipeSchema, ingredientSchema, reasons } from './recipes.js';
import { toRecipe } from './recipes.js';
import { normalizeGroup } from './auth.js';
import { SAMPLE_DB, SAMPLE_PRICES } from './sample-db.js';

export const BACKUP_FORMAT = 'recipe-coordinator-backup';
export const adminKeySet = () => Boolean(process.env.ADMIN_KEY?.trim());

export function checkAdmin(request) {
  if (!adminKeySet()) {
    return { status: 503, error: 'The admin key isn’t set up: add ADMIN_KEY in Vercel (Settings → Environment Variables) and redeploy.' };
  }
  const given = Buffer.from((request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim());
  const want = Buffer.from(process.env.ADMIN_KEY.trim());
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { status: 401, error: 'Wrong admin key.' };
  }
  return { ok: true };
}

const log = (action, ok, detail, input = null) =>
  getStore().logActivity({ group_name: 'admin', channel: 'admin', action, ok, detail, input });

const fail = (status, errors) => ({ ok: false, status, errors });
const uuid = z.uuid();

// ---------------------------------------------------------------- edit
// Any recipe field can be changed, plus its group and status.
const recipeEditSchema = recipeSchema.partial().extend({
  group: z.string().trim().min(1).max(40).optional().describe('Group name, e.g. team-3'),
  status: z.enum(['new', 'processed']).optional(),
});

export async function updateRecipe(id, input) {
  if (!uuid.safeParse(id).success) return fail(400, ['not a valid recipe id']);
  const parsed = recipeEditSchema.safeParse(input ?? {});
  if (!parsed.success) return fail(400, reasons(parsed.error, input));
  const { group, status, ...rest } = parsed.data;
  const fields = { ...rest };
  if (group !== undefined) {
    const name = normalizeGroup(group);
    if (!name) return fail(400, ['group must be 1 to 40 letters, numbers, dashes or underscores']);
    fields.group_name = name;
  }
  if (status === 'new') Object.assign(fields, { status, processed_at: null, processed_by: null });
  if (status === 'processed') Object.assign(fields, { status, processed_at: new Date().toISOString(), processed_by: 'admin' });
  if (!Object.keys(fields).length) return fail(400, ['nothing to change']);

  const res = await getStore().updateRecipe(id, fields);
  if (res.duplicate) return fail(409, ['another recipe already has this meal_id: each TheMealDB recipe is stored once']);
  if (!res.row) return fail(404, [`no recipe has the id ${id}`]);
  await log('admin_edit_recipe', true, id, input);
  return { ok: true, recipe: toRecipe(res.row) };
}

export async function deleteRecipe(id) {
  if (!uuid.safeParse(id).success) return fail(400, ['not a valid recipe id']);
  if (!(await getStore().deleteRecipe(id))) return fail(404, [`no recipe has the id ${id}`]);
  await log('admin_delete_recipe', true, id);
  return { ok: true };
}

export async function deletePlan(id) {
  if (!uuid.safeParse(id).success) return fail(400, ['not a valid meal plan id']);
  if (!(await getStore().deletePlan(id))) return fail(404, [`no meal plan has the id ${id}`]);
  await log('admin_delete_plan', true, id);
  return { ok: true };
}

export async function clearExchanges() {
  await getStore().clearExchanges();
  await log('admin_clear_exchanges', true, 'exchange log cleared');
  return { ok: true };
}

export async function clearActivity() {
  await getStore().clearActivity();
  await log('admin_clear_activity', true, 'activity log cleared');
  return { ok: true };
}

// ---------------------------------------------------------------- backup
export async function backup() {
  const data = await getStore().exportAll();
  return {
    format: BACKUP_FORMAT,
    version: 2,
    exported_at: new Date().toISOString(),
    counts: { recipes: data.recipes.length, plans: data.plans.length, activity: data.activity.length },
    ...data,
  };
}

const when = z.union([z.string(), z.date()]).transform((v) => new Date(v)).refine((d) => !Number.isNaN(d.getTime()), 'must be a date')
  .transform((d) => d.toISOString());
const maybeWhen = when.nullable().optional();

// Recipes as exported: the recipe, its first pick's group/theme/why, every
// pick (backups from version 2), and read-only price columns (ignored: prices
// are worked out again after a restore).
const backupRecipe = z.object({
  ...recipeSchema.shape,
  picks: z.array(z.object({ group: z.string().min(1).max(40), theme: z.string().min(1), why_chosen: z.string().min(1), at: maybeWhen })).optional(),
  id: uuid,
  group_name: z.string().min(1).max(40),
  status: z.enum(['new', 'processed']),
  created_at: when,
  processed_at: maybeWhen,
  processed_by: z.string().max(100).nullable().optional(),
  ingredients: z.array(ingredientSchema).min(1).max(60),
});
// Plans are kept as saved, whichever version of the plan format made them.
const backupPlan = z.object({
  id: uuid,
  group_name: z.string().min(1).max(40),
  summary: z.string().min(1),
  budget_usd: z.number().nullable().optional(),
  total_cost_usd: z.number().min(0),
  store_id: z.string().nullable().optional(),
  meals: z.array(z.object({}).passthrough()),
  shopping_list: z.array(z.unknown()).default([]),
  rule_checks: z.array(z.unknown()).default([]),
  created_at: when,
});
const backupActivity = z.object({
  at: when,
  group_name: z.string().max(100).nullable().optional(),
  channel: z.enum(['mcp', 'rest', 'admin']),
  action: z.string().min(1).max(100),
  ok: z.boolean(),
  detail: z.string().nullable().optional(),
  input: z.unknown().optional(),
});
const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.union([z.literal(1), z.literal(2)]),
  recipes: z.array(backupRecipe),
  plans: z.array(backupPlan),
  activity: z.array(backupActivity).default([]),
});

// Checks the whole file first; nothing is replaced unless all of it is valid.
export async function restore(input) {
  if (input?.format !== BACKUP_FORMAT) return fail(400, ['this isn’t a Recipe Coordinator backup file (download one with “Download backup”)']);
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success) {
    const all = reasons(parsed.error, input);
    const errors = all.slice(0, 20);
    if (all.length > errors.length) errors.push(`…and ${all.length - errors.length} more problems`);
    return fail(400, errors);
  }
  const data = parsed.data;
  const ids = new Set(data.recipes.map((r) => r.id));
  if (ids.size !== data.recipes.length) return fail(400, ['the backup has two recipes with the same id']);
  const keys = new Set(data.recipes.map((r) => `${r.group_name}|${r.theme}|${r.meal_id}`));
  if (keys.size !== data.recipes.length) return fail(400, ['the backup has the same recipe twice for one group and theme']);

  await getStore().replaceAll(data);
  const counts = { recipes: data.recipes.length, plans: data.plans.length, activity: data.activity.length };
  await log('admin_restore', true, `restored ${counts.recipes} recipes, ${counts.plans} meal plans, ${counts.activity} activity entries`);
  return { ok: true, counts };
}

export async function reset(input) {
  if (input?.confirm !== 'RESET') return fail(400, ['to delete everything, send {"confirm": "RESET"}']);
  await getStore().replaceAll({ recipes: [], plans: [], activity: [] });
  await log('admin_reset', true, 'deleted all recipes, meal plans and activity');
  return { ok: true };
}

// ---------------------------------------------------------------- sample
// A fixed database of 20 TheMealDB recipes picked by five groups, for when
// something goes wrong in class. With prices: each recipe gets a ready-made
// price, labelled as an estimate (not from Kroger), so the Meal Planners can
// work even if the Pricer can't. Without: the Pricer prices them as usual.
export const SAMPLE_PEOPLE = 50;

export function sampleSummary() {
  const r = SAMPLE_DB.recipes;
  return {
    recipes: r.length,
    picks: r.reduce((n, x) => n + x.picks.length, 0),
    groups: [...new Set(r.flatMap((x) => x.picks.map((p) => p.group)))].sort(),
    themes: [...new Set(r.flatMap((x) => x.picks.map((p) => p.theme)))],
  };
}

export async function loadSample(input) {
  if (input?.confirm !== 'SAMPLE') return fail(400, ['to replace everything with the sample database, send {"confirm": "SAMPLE"}']);
  const res = await restore(structuredClone(SAMPLE_DB));
  if (!res.ok) return res;
  const withPrices = input.prices !== false;
  if (withPrices) {
    await getStore().setSamplePrices(SAMPLE_DB.recipes.map((r) => {
      const total = Math.round(SAMPLE_PRICES[r.meal_id] * SAMPLE_PEOPLE * 100) / 100;
      const reason = 'Ready-made price loaded with the sample database, not looked up at Kroger. Reprice the recipe to get a Kroger cart.';
      return {
        meal_id: r.meal_id,
        people: SAMPLE_PEOPLE,
        total,
        summary: `Sample price: about $${SAMPLE_PRICES[r.meal_id].toFixed(2)} a serving, estimated for the whole recipe, not from Kroger.`,
        basket: [{
          line: 1, ingredient: 'the whole recipe', raw: null, status: 'estimated',
          product: { id: 'sample', description: `Ingredients for ${r.name}, ${SAMPLE_PEOPLE} people`, brand: null, size: '1 each', price_usd: total, on_sale: false, image_url: null, estimated: true },
          amount_used: 1, unit_used: 'each', grams: null, fraction: 1, packages: 1, cost_used_usd: total, cost_to_buy_usd: total, reason, note: null,
        }],
      };
    }));
  }
  await log('admin_load_sample', true, `loaded the sample database (${SAMPLE_DB.recipes.length} recipes, ${withPrices ? 'with sample prices' : 'to be priced by the Pricer'})`);
  return { ok: true, counts: res.counts, prices: withPrices };
}
