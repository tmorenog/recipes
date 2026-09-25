// Small, unambiguous fixes to what an agent sends, before the rules check it:
// numbers written as text, empty links, missing optional ingredient fields,
// day names in any case, a TheMealDB id where the recipe id is expected, and
// a {recipe: …} or {plan: …} wrapper. Each fix is reported back as a note, so
// the agent (and its builders) learn the exact format. Anything ambiguous is
// left alone for the rules to reject with a reason.
import { getStore } from './store/index.js';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

// "45" → 45, "0.75" → 0.75, "3/4" → 0.75, "1 1/2" → 1.5. Anything else: undefined.
export function numberFromText(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/);
  if (m && Number(m[3]) > 0) return Math.round(((m[1] ? Number(m[1]) : 0) + Number(m[2]) / Number(m[3])) * 1000) / 1000;
  return undefined;
}

function unwrap(input, key, notes) {
  if (isObject(input) && Object.keys(input).length === 1 && isObject(input[key])) {
    notes.push(`the ${key} was sent inside {"${key}": …}; send its fields directly`);
    return input[key];
  }
  return input;
}

function number(obj, field, label, notes) {
  const n = numberFromText(obj[field]);
  if (n !== undefined) {
    notes.push(`${label} was sent as text ("${obj[field]}"); read as ${n}`);
    obj[field] = n;
  }
}

export function lenientRecipe(input) {
  const notes = [];
  let value = unwrap(input, 'recipe', notes);
  if (!isObject(value)) return { value, notes };
  value = { ...value };
  number(value, 'est_minutes', 'est_minutes', notes);
  number(value, 'est_servings', 'est_servings', notes);
  if (typeof value.meal_id === 'number') {
    notes.push(`meal_id was sent as a number; read as "${value.meal_id}"`);
    value.meal_id = String(value.meal_id);
  }
  for (const field of ['source_url', 'image_url']) {
    if (typeof value[field] === 'string' && !value[field].trim()) {
      notes.push(`${field} was empty; read as null (no link)`);
      value[field] = null;
    }
  }
  if (Array.isArray(value.ingredients)) {
    value.ingredients = value.ingredients.map((ing, i) => {
      if (!isObject(ing)) return ing;
      const out = { ...ing };
      number(out, 'amount', `ingredients.${i}.amount`, notes);
      for (const field of ['unit', 'raw']) {
        if (!(field in out)) {
          notes.push(`ingredients.${i}.${field} was missing; read as null`);
          out[field] = null;
        }
      }
      return out;
    });
  }
  return { value, notes };
}

export async function lenientPlan(input) {
  const notes = [];
  let value = unwrap(input, 'plan', notes);
  if (!isObject(value)) return { value, notes };
  value = { ...value };
  number(value, 'budget_usd', 'budget_usd', notes);
  if (!Array.isArray(value.meals)) return { value, notes };

  // TheMealDB ids given as recipe_id: each meal is stored once, so the match is certain.
  const mealIds = value.meals.map((m) => (isObject(m) && typeof m.recipe_id !== 'undefined' && /^\d+$/.test(String(m.recipe_id)) ? String(m.recipe_id) : null)).filter(Boolean);
  const byMeal = mealIds.length ? await getStore().recipeIdsByMealIds([...new Set(mealIds)]) : new Map();

  value.meals = value.meals.map((m, i) => {
    if (!isObject(m)) return m;
    const out = { ...m };
    if (typeof out.day === 'string') {
      const day = DAYS.find((d) => d.toLowerCase() === out.day.trim().toLowerCase());
      if (day && day !== out.day) {
        notes.push(`meals.${i}.day "${out.day}" read as "${day}"`);
        out.day = day;
      }
    }
    const asMeal = out.recipe_id != null && /^\d+$/.test(String(out.recipe_id)) ? String(out.recipe_id) : null;
    if (asMeal && byMeal.has(asMeal)) {
      notes.push(`meals.${i}.recipe_id "${out.recipe_id}" is a TheMealDB meal_id; read as that recipe’s id ${byMeal.get(asMeal)} (use the id from list_recipes)`);
      out.recipe_id = byMeal.get(asMeal);
    }
    if (isObject(out.nutrition_per_serving)) {
      const n = { ...out.nutrition_per_serving };
      for (const k of ['calories', 'protein_g', 'fiber_g', 'sodium_mg']) number(n, k, `meals.${i}.nutrition_per_serving.${k}`, notes);
      out.nutrition_per_serving = n;
    }
    return out;
  });
  return { value, notes };
}
