// Recipe rules and operations, shared by the MCP server and the REST API so
// both give the same answers and the same reasons.
import { z } from 'zod';
import { getStore } from './store/index.js';
import { lenientRecipe } from './lenient.js';
import { getSettings, limitFor } from './settings.js';

// ---------------------------------------------------------------- the contract
const text = (max) => z.string().trim().min(1).max(max);
const optionalText = (max) => z.string().trim().max(max).nullable().optional();
const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://')
  .nullable()
  .optional();

export const ingredientSchema = z.strictObject({
  name: text(120).describe('The ingredient (strIngredientN), lowercase, e.g. "red onion"'),
  amount: z.number().finite().positive().nullable().describe('The number in strMeasureN, e.g. 2 for "2 tbsp". null when there is none, e.g. "to taste"'),
  unit: z.string().trim().max(40).nullable().describe('The unit in strMeasureN, e.g. "tbsp", "g", "cup". null for things you count, like "2 eggs"'),
  raw: z.string().trim().max(200).nullable().describe('strMeasureN exactly as written, e.g. "2 tbsp chopped". "" or null when TheMealDB gives no measure: never invent one'),
});

export const recipeSchema = z.strictObject({
  theme: text(200).describe('The theme you were given, exactly as typed'),
  meal_id: text(100).describe('TheMealDB idMeal, e.g. "52772"'),
  name: text(200).describe('strMeal'),
  category: optionalText(100).describe('strCategory'),
  cuisine: optionalText(100).describe('strArea'),
  ingredients: z.array(ingredientSchema).min(1).max(60).describe('One item per non-empty strIngredient1…20, paired with strMeasure1…20'),
  instructions: z.string().trim().min(20).max(20000).describe('strInstructions (at least 20 characters)'),
  est_minutes: z.number().int().min(1).max(1440).describe('Your estimate of the total time in minutes: a whole number'),
  est_servings: z.number().int().min(1).max(100).describe('Your estimate of the servings: a whole number'),
  image_url: httpUrl.describe('strMealThumb'),
  source_url: httpUrl.describe('strSource, or null when it is empty'),
  why_chosen: text(500).describe('One sentence: why this recipe fits the theme'),
});

export const listSchema = z.strictObject({
  status: z.enum(['new', 'processed', 'all']).default('new').describe('Default "new": not yet marked processed'),
  theme: z.string().trim().min(1).max(200).optional().describe('Only this exact theme'),
  group: z.string().trim().min(1).max(100).optional().describe('Only recipes saved by this group'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  priced: z
    .preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean())
    .optional()
    .describe('true: only recipes the Pricer has priced, with their cost per serving'),
});

export const idSchema = z.uuid();

// ---------------------------------------------------------------- readable reasons
const valueAt = (input, path) => path.reduce((v, k) => (v == null ? undefined : v[k]), input);

function describe(issue, input) {
  const field = issue.path.length ? issue.path.join('.') : 'recipe';
  if (issue.code === 'unrecognized_keys') {
    const where = issue.path.length ? ` in ${issue.path.join('.')}` : '';
    return `unknown field${issue.keys.length > 1 ? 's' : ''}${where}: ${issue.keys.join(', ')}`;
  }
  if (issue.code === 'invalid_type' && valueAt(input, issue.path) === undefined) return `${field} is missing`;
  if (issue.code === 'invalid_type' && issue.expected === 'object' && issue.path[0] === 'ingredients' && issue.path.length === 2) {
    return `${field} must be an object like {"name": "red onion", "amount": 1, "unit": null, "raw": "1 sliced"}, not text`;
  }
  if (issue.code === 'invalid_type') {
    const what = issue.expected === 'int' ? 'whole number' : issue.expected;
    return `${field} must be ${/^[aeiou]/.test(what) ? 'an' : 'a'} ${what}`;
  }
  if (issue.code === 'too_small' && issue.origin === 'string' && issue.minimum === 1) return `${field} is empty`;
  if (issue.code === 'too_small' && issue.origin === 'string') return `${field} is too short (at least ${issue.minimum} characters)`;
  if ((issue.code === 'too_small' || issue.code === 'too_big') && issue.origin === 'array' && issue.exact) {
    return `${field} needs exactly ${issue.minimum ?? issue.maximum} items`;
  }
  if (issue.code === 'invalid_format' && issue.format === 'regex') return `${field} ${issue.message}`;
  if (issue.code === 'too_small' && issue.origin === 'array') return `${field} needs at least ${issue.minimum} item${issue.minimum > 1 ? 's' : ''}`;
  if (issue.code === 'too_small') return `${field} must be ${issue.inclusive === false ? 'more than' : 'at least'} ${issue.minimum}`;
  if (issue.code === 'too_big' && issue.origin === 'string') return `${field} is too long (at most ${issue.maximum} characters)`;
  if (issue.code === 'too_big' && issue.origin === 'array') return `${field} has too many items (at most ${issue.maximum})`;
  if (issue.code === 'too_big') return `${field} must be at most ${issue.maximum}`;
  if (issue.code === 'invalid_format' && issue.format === 'url') return `${field} is not a valid web address`;
  if (issue.code === 'invalid_format' && issue.format === 'uuid') return `${field} is not a valid recipe id`;
  if (issue.code === 'invalid_value') return `${field} must be one of: ${issue.values.join(', ')}`;
  if (issue.code === 'custom') return `${field} ${issue.message}`;
  return `${field}: ${issue.message}`;
}

export const reasons = (zodError, input) => zodError.issues.map((issue) => describe(issue, input));

// What the Pricer found, kept on each recipe: the Kroger cart for the number
// of people in the Pricer's instructions, the cost per serving, and whether
// any ingredient's price is an estimate (Kroger had none).
const num = (v) => (v == null ? null : Number(v));
export function pricingSummary(row) {
  const status = row?.price_status ?? 'pending';
  if (status !== 'priced') return { status };
  return {
    status,
    people: row.priced_for,
    cart_usd: num(row.cart_usd),
    cost_per_serving_usd: num(row.cost_per_serving_usd),
    estimated: Boolean(row.price_estimated),
    estimated_lines: row.estimated_lines ?? 0,
    priced_at: row.priced_at,
  };
}

// ---------------------------------------------------------------- operations
// Each returns { ok: true, ... } or { ok: false, status, errors: [readable reasons] }.

// A recipe as the API returns it: stored once per TheMealDB meal, with every
// group that picked it (popularity) and its price.
export function toRecipe(row) {
  const { group_name, picks = [], price_status, cost_per_serving_usd, cart_usd, priced_for, estimated_lines, price_estimated, priced_at, ...rest } = row;
  const pickedBy = [...new Set(picks.map((p) => p.group))];
  return { ...rest, group: group_name, pick_count: pickedBy.length, picked_by: pickedBy, picks, pricing: pricingSummary(row) };
}

const record = ({ group, ...entry }) => getStore().logActivity({ group_name: group, detail: null, input: null, ...entry });

export async function saveRecipe({ group, channel, input }) {
  const limited = await limitFor(group, 'recipe');
  if (limited) {
    await record({ group, channel, action: 'save_recipe', ok: false, detail: limited.errors.join('; '), input });
    return { ok: false, ...limited };
  }
  const { value, notes } = lenientRecipe(input ?? {});
  const parsed = recipeSchema.safeParse(value);
  if (!parsed.success) {
    const errors = reasons(parsed.error, input);
    await record({ group, channel, action: 'save_recipe', ok: false, detail: errors.join('; '), input });
    return { ok: false, status: 400, errors };
  }
  const r = parsed.data;
  const res = await getStore().saveRecipePick({
    group_name: group,
    theme: r.theme,
    meal_id: r.meal_id,
    name: r.name,
    category: r.category ?? null,
    cuisine: r.cuisine ?? null,
    ingredients: r.ingredients,
    instructions: r.instructions,
    est_minutes: r.est_minutes,
    est_servings: r.est_servings,
    image_url: r.image_url ?? null,
    source_url: r.source_url ?? null,
    why_chosen: r.why_chosen,
  });
  if (res.duplicate) {
    const errors = [`your group already picked meal_id "${r.meal_id}" for the theme "${r.theme}": choose a different recipe`];
    await record({ group, channel, action: 'save_recipe', ok: false, detail: errors[0], input });
    return { ok: false, status: 409, errors };
  }
  await record({ group, channel, action: 'save_recipe', ok: true, detail: res.created ? res.row.id : `${res.row.id} (picked again)`, input });
  // A new recipe goes to the Pricer, which runs in the background.
  if (res.created) {
    // Paused by the instructor: the recipe waits, unpriced, until they release it.
    const { auto_pricing } = await getSettings();
    await getStore().enqueuePricing(r.meal_id, auto_pricing ? 'pending' : 'unpriced');
    if (auto_pricing) {
      const { kickPricer } = await import('./pricer.js');
      kickPricer();
    }
  }
  return { ok: true, created: res.created, recipe: toRecipe(res.row), notes };
}

export async function listRecipes(input) {
  const parsed = listSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error, input) };
  const { priced, ...query } = parsed.data;
  const rows = await getStore().listRecipes(query);
  let recipes = rows.map(toRecipe);
  if (priced === true) recipes = recipes.filter((r) => r.pricing.status === 'priced');
  if (priced === false) recipes = recipes.filter((r) => r.pricing.status !== 'priced');
  return { ok: true, count: recipes.length, recipes };
}

export async function markProcessed({ group, channel, id }) {
  const input = { recipe_id: id };
  if (!idSchema.safeParse(id).success) {
    const errors = [`"${String(id).slice(0, 60)}" is not a valid recipe id`];
    await record({ group, channel, action: 'mark_processed', ok: false, detail: errors[0], input });
    return { ok: false, status: 400, errors };
  }
  const updated = await getStore().markProcessed(id, group);
  if (updated) {
    await record({ group, channel, action: 'mark_processed', ok: true, detail: id, input });
    return { ok: true, already: false, recipe: toRecipe(updated) };
  }
  const existing = await getStore().getRecipe(id);
  if (!existing) {
    const errors = [`no recipe has the id ${id}`];
    await record({ group, channel, action: 'mark_processed', ok: false, detail: errors[0], input });
    return { ok: false, status: 404, errors };
  }
  // Already processed: nothing to do, and not an error.
  return { ok: true, already: true, recipe: toRecipe(existing) };
}
