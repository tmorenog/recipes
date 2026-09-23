// Recipe rules and operations, shared by the MCP server and the REST API so
// both give the same answers and the same reasons.
import { z } from 'zod';
import { query } from './db.js';

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
  name: text(120).describe('Ingredient name, lowercase, e.g. "red onion"'),
  amount: z.number().finite().positive().nullable().describe('Numeric amount, e.g. 2. null for "to taste" or "a pinch"'),
  unit: z.string().trim().max(40).nullable().describe('e.g. "tbsp", "g", "cup". null for countable items like "2 eggs"'),
  raw: text(200).describe('The original text from the source, e.g. "2 tbsp, chopped"'),
});

export const recipeSchema = z.strictObject({
  theme: text(200).describe('The theme you searched for, e.g. "cheap weeknight vegetarian dinners"'),
  meal_id: text(100).describe('The recipe id at its source, e.g. TheMealDB idMeal "52772"'),
  name: text(200),
  category: optionalText(100),
  cuisine: optionalText(100),
  ingredients: z.array(ingredientSchema).min(1).max(60),
  instructions: z.string().trim().min(20).max(20000),
  est_minutes: z.number().int().min(1).max(1440).describe('Estimated total time in minutes'),
  est_servings: z.number().int().min(1).max(100).describe('Estimated number of servings'),
  image_url: httpUrl.describe('Photo of the dish'),
  source_url: httpUrl.describe('Where the recipe came from'),
  why_chosen: text(500).describe('One sentence: why this recipe fits the theme'),
});

export const listSchema = z.strictObject({
  status: z.enum(['new', 'processed', 'all']).default('new').describe('Default "new": not yet marked processed'),
  theme: z.string().trim().min(1).max(200).optional().describe('Only this exact theme'),
  group: z.string().trim().min(1).max(100).optional().describe('Only recipes saved by this group'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
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

// ---------------------------------------------------------------- operations
// Each returns { ok: true, ... } or { ok: false, status, errors: [readable reasons] }.

const COLUMNS = `id, group_name, theme, meal_id, name, category, cuisine, ingredients, instructions,
  est_minutes, est_servings, image_url, source_url, why_chosen, status, created_at, processed_at, processed_by`;

const toRecipe = ({ group_name, ...row }) => ({ group: group_name, ...row });

async function record(entry) {
  try {
    await query(
      'insert into activity (group_name, channel, action, ok, detail, input) values ($1, $2, $3, $4, $5, $6)',
      [entry.group, entry.channel, entry.action, entry.ok, entry.detail ?? null, entry.input == null ? null : JSON.stringify(entry.input)],
    );
  } catch (e) {
    console.error('activity log failed:', e.message); // logging must never break a request
  }
}

export async function saveRecipe({ group, channel, input }) {
  const parsed = recipeSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const errors = reasons(parsed.error, input);
    await record({ group, channel, action: 'save_recipe', ok: false, detail: errors.join('; '), input });
    return { ok: false, status: 400, errors };
  }
  const r = parsed.data;
  try {
    const { rows } = await query(
      `insert into recipes (group_name, theme, meal_id, name, category, cuisine, ingredients, instructions,
         est_minutes, est_servings, image_url, source_url, why_chosen)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning ${COLUMNS}`,
      [group, r.theme, r.meal_id, r.name, r.category ?? null, r.cuisine ?? null, JSON.stringify(r.ingredients),
        r.instructions, r.est_minutes, r.est_servings, r.image_url ?? null, r.source_url ?? null, r.why_chosen],
    );
    await record({ group, channel, action: 'save_recipe', ok: true, detail: rows[0].id, input });
    return { ok: true, recipe: toRecipe(rows[0]) };
  } catch (e) {
    if (e.code !== '23505') throw e; // unique violation: a duplicate
    const errors = [`your group already saved meal_id "${r.meal_id}" for the theme "${r.theme}"`];
    await record({ group, channel, action: 'save_recipe', ok: false, detail: errors[0], input });
    return { ok: false, status: 409, errors };
  }
}

export async function listRecipes(input) {
  const parsed = listSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, status: 400, errors: reasons(parsed.error, input) };
  const { status, theme, group, limit } = parsed.data;
  const where = [];
  const params = [];
  if (status !== 'all') where.push(`status = $${params.push(status)}`);
  if (theme) where.push(`theme = $${params.push(theme)}`);
  if (group) where.push(`group_name = $${params.push(group)}`);
  const { rows } = await query(
    `select ${COLUMNS} from recipes ${where.length ? `where ${where.join(' and ')}` : ''}
     order by created_at desc limit $${params.push(limit)}`,
    params,
  );
  return { ok: true, count: rows.length, recipes: rows.map(toRecipe) };
}

export async function markProcessed({ group, channel, id }) {
  if (!idSchema.safeParse(id).success) {
    const errors = [`"${String(id).slice(0, 60)}" is not a valid recipe id`];
    await record({ group, channel, action: 'mark_processed', ok: false, detail: errors[0], input: { recipe_id: id } });
    return { ok: false, status: 400, errors };
  }
  const { rows } = await query(
    `update recipes set status = 'processed', processed_at = now(), processed_by = $2
     where id = $1 and status = 'new' returning ${COLUMNS}`,
    [id, group],
  );
  if (rows.length) {
    await record({ group, channel, action: 'mark_processed', ok: true, detail: id, input: { recipe_id: id } });
    return { ok: true, already: false, recipe: toRecipe(rows[0]) };
  }
  const existing = await query(`select ${COLUMNS} from recipes where id = $1`, [id]);
  if (!existing.rows.length) {
    const errors = [`no recipe has the id ${id}`];
    await record({ group, channel, action: 'mark_processed', ok: false, detail: errors[0], input: { recipe_id: id } });
    return { ok: false, status: 404, errors };
  }
  // Already processed: nothing to do, and not an error.
  return { ok: true, already: true, recipe: toRecipe(existing.rows[0]) };
}
