// Recipe rules and operations, shared by the MCP server and the REST API so
// both give the same answers and the same reasons.
import { z } from 'zod';
import { getStore } from './store/index.js';

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
    .describe('true: only recipes the Pricer has priced, with their cost and nutrition per serving'),
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
  if (issue.code === 'invalid_type') return `${field} must be ${issue.expected === 'int' ? 'a whole number' : `a ${issue.expected}`}`;
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

// What the Pricer found, attached to each recipe: the Kroger cart for the
// number of people in the Pricer's instructions, and nutrition per serving.
const perServing = (x, people) => (x == null || !people ? null : Math.round((x / people) * 100) / 100);
export function pricingSummary(p) {
  if (!p) return { status: 'pending' };
  if (p.status !== 'priced') return { status: p.status, ...(p.error && { error: p.error }) };
  const n = p.nutrition_total || {};
  return {
    status: 'priced',
    people: p.people,
    cart_usd: p.to_buy_usd,
    cost_used_usd: p.total_cost_usd,
    cost_per_serving_usd: perServing(p.total_cost_usd, p.people),
    nutrition_per_serving: Object.fromEntries(['calories', 'protein_g', 'fiber_g', 'sodium_mg'].map((k) => [k, perServing(n[k], p.people)])),
  };
}

// ---------------------------------------------------------------- operations
// Each returns { ok: true, ... } or { ok: false, status, errors: [readable reasons] }.

const toRecipe = ({ group_name, ...row }) => ({ group: group_name, ...row });

const record = ({ group, ...entry }) => getStore().logActivity({ group_name: group, detail: null, input: null, ...entry });

export async function saveRecipe({ group, channel, input }) {
  const parsed = recipeSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const errors = reasons(parsed.error, input);
    await record({ group, channel, action: 'save_recipe', ok: false, detail: errors.join('; '), input });
    return { ok: false, status: 400, errors };
  }
  const r = parsed.data;
  const res = await getStore().insertRecipe({
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
    const errors = [`your group already saved meal_id "${r.meal_id}" for the theme "${r.theme}"`];
    await record({ group, channel, action: 'save_recipe', ok: false, detail: errors[0], input });
    return { ok: false, status: 409, errors };
  }
  await record({ group, channel, action: 'save_recipe', ok: true, detail: res.row.id, input });
  // Hand the recipe to the Pricer; it runs in the background.
  await getStore().enqueuePricing(r.meal_id);
  const { kickPricer } = await import('./pricer.js');
  kickPricer();
  return { ok: true, recipe: toRecipe(res.row) };
}

export async function listRecipes(input) {
  const parsed = listSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error, input) };
  const { priced, ...query } = parsed.data;
  const rows = await getStore().listRecipes(query);
  const prices = await getStore().pricingsFor([...new Set(rows.map((r) => r.meal_id))]);
  let recipes = rows.map((r) => ({ ...toRecipe(r), pricing: pricingSummary(prices.get(r.meal_id)) }));
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
