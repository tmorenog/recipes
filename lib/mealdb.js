// Checks a submitted recipe against TheMealDB before the coordinator stores
// it: the meal_id must exist, and the name and ingredients must be that
// recipe's own. Matching forgives case, spaces, punctuation and plurals; the
// agent's own fields (estimates, why_chosen) and the free-text measures are
// not compared. If TheMealDB can't be reached, the recipe is accepted with a
// note, so an outage never blocks the class.
import { getStore } from './store/index.js';
import { getSettings } from './settings.js';

const LOOKUP = 'https://www.themealdb.com/api/json/v1/1/lookup.php?i=';
const DAY = 24 * 3600;
const overrides = { fetch: null, enabled: null }; // tests only
export const setMealDbForTests = (o) => Object.assign(overrides, o);

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
// berries → berry, tomatoes → tomato, peaches → peach, limes → lime, eggs → egg; glass stays.
const singular = (w) => {
  if (/ies$/.test(w)) return w.replace(/ies$/, 'y');
  if (/(?:ch|sh|x|z|ss|o)es$/.test(w)) return w.slice(0, -2);
  if (/[^s]s$/.test(w)) return w.slice(0, -1);
  return w;
};
const stem = (s) => norm(s).split(' ').map(singular).join(' ');
// "chicken breasts" ≈ "chicken breast"; "garlic clove" ≈ "garlic".
const same = (a, b) => {
  const x = stem(a);
  const y = stem(b);
  return x === y || (x.length > 3 && y.length > 3 && (x.includes(y) || y.includes(x)));
};

// { status: 'found', meal } | { status: 'missing' } | { status: 'unreachable', error }
export async function lookupMeal(mealId) {
  const id = String(mealId);
  const store = getStore();
  const key = `mealdb:${id}`;
  const hit = await store.cacheGet(key, DAY).catch(() => null);
  if (hit) return hit;
  let res;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    res = await (overrides.fetch ?? fetch)(`${LOOKUP}${encodeURIComponent(id)}`, { signal: ctrl.signal });
    clearTimeout(timer);
  } catch (e) {
    return { status: 'unreachable', error: e.message };
  }
  if (!res.ok) return { status: 'unreachable', error: `HTTP ${res.status}` };
  const body = await res.json().catch(() => null);
  const m = body?.meals?.[0];
  const out = m
    ? {
      status: 'found',
      meal: {
        name: m.strMeal,
        ingredients: Array.from({ length: 20 }, (_, i) => (m[`strIngredient${i + 1}`] || '').trim()).filter(Boolean),
      },
    }
    : { status: 'missing' };
  await store.cacheSet(key, out).catch(() => {});
  return out;
}

// Returns { errors: [...] } (empty when it matches) and { notes: [...] }.
export async function verifyRecipe(recipe) {
  if (overrides.enabled === false || !(await getSettings()).verify_recipes) return { errors: [], notes: [] };
  const found = await lookupMeal(recipe.meal_id);
  if (found.status === 'unreachable') {
    return { errors: [], notes: ['TheMealDB could not be reached, so this recipe was not checked against it.'] };
  }
  if (found.status === 'missing') {
    return { errors: [`meal_id "${recipe.meal_id}" does not exist on TheMealDB: use the idMeal of the recipe you looked up`], notes: [] };
  }
  const { meal } = found;
  const errors = [];
  if (norm(meal.name) !== norm(recipe.name)) {
    errors.push(`meal_id ${recipe.meal_id} is “${meal.name}” on TheMealDB, not “${recipe.name}”: send that recipe’s own name, or the id of the recipe you meant`);
  }
  const sent = recipe.ingredients.map((i) => i.name);
  const missing = meal.ingredients.filter((m) => !sent.some((s) => same(s, m)));
  const extra = sent.filter((s) => !meal.ingredients.some((m) => same(s, m)));
  if (missing.length || extra.length) {
    const parts = [
      missing.length && `missing ${missing.join(', ')}`,
      extra.length && `not in this recipe on TheMealDB: ${extra.join(', ')}`,
    ].filter(Boolean);
    errors.push(`ingredients don’t match TheMealDB’s “${meal.name}”: ${parts.join('; ')}. Send exactly the recipe’s own ingredients`);
  }
  return { errors, notes: [] };
}
