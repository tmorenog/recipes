// Builds lib/sample-db.js: the fixed sample database the admin can load from
// the Admin page. 20 real TheMealDB recipes picked by five groups, with fixed
// ids and dates so every load is identical. Run it only to change the sample:
//   node scripts/make-sample-db.mjs
import { writeFileSync } from 'node:fs';

const API = 'https://www.themealdb.com/api/json/v1/1';

// group, theme, then the recipes it picked:
//   [meal_id, minutes, servings, sample price per serving (USD), why]
const GROUPS = [
  ['team-1', 'cheap weeknight vegetarian dinners', [
    ['52870', 30, 4, 1.6, 'Chickpeas and peppers make a filling meat-free dinner that costs little.'],
    ['52785', 40, 4, 0.95, 'Lentils and pantry spices: one of the cheapest filling vegetarian dinners there is.'],
    ['53541', 35, 4, 0.85, 'Rice and black beans, cheap staples that cook quickly on a weeknight.'],
    ['53486', 35, 4, 1.1, 'A simple bean soup from cheap tins and vegetables.'],
  ]],
  ['team-2', 'comfort food under 45 minutes', [
    ['52982', 25, 4, 2.1, 'Creamy pasta that is on the table in under half an hour.'],
    ['53064', 25, 4, 2.4, 'Rich, cheesy pasta that feels like comfort food and is quick to make.'],
    ['52834', 40, 4, 3.8, 'A classic creamy beef dish that cooks in about 40 minutes.'],
    ['53159', 25, 4, 2.2, 'Potatoes, cheese and eggs in one pan: comforting and fast.'],
  ]],
  ['team-3', 'high-protein chicken dinners', [
    ['52940', 60, 4, 2.6, 'Chicken pieces braised in a rich sauce: plenty of protein per plate.'],
    ['53367', 30, 4, 1.9, 'Chicken and egg with rice: good protein at a low price.'],
    ['53143', 50, 4, 2.9, 'A one-tray chicken bake with a lot of chicken per serving.'],
    ['52850', 35, 4, 2.3, 'Lean chicken with couscous and vegetables.'],
  ]],
  ['team-4', 'one-pot meals from around the world', [
    ['53161', 50, 4, 2.7, 'A Spanish-style rice pot where everything cooks together.'],
    ['52843', 120, 6, 4.6, 'A Moroccan tagine cooked in a single pot.'],
    ['53166', 30, 4, 1.85, 'A Spanish stew made in one pan.'],
    ['52826', 180, 6, 3.2, 'A slow-cooked chilli: one pot and little washing up.'],
  ]],
  ['team-5', 'seafood for beginners', [
    ['52773', 25, 4, 5.2, 'Salmon with a simple glaze: hard to get wrong.'],
    ['52959', 35, 4, 5.6, 'Salmon baked on a tray with vegetables: an easy first fish dish.'],
    ['52819', 30, 4, 3.9, 'Fish tacos with a spice mix: quick and forgiving.'],
    ['53154', 35, 4, 4.8, 'A tomato and bean stew that introduces clams gently.'],
  ]],
];
// Recipes a second group also picked, which makes them more popular.
const EXTRA_PICKS = [
  ['team-4', 'one-pot meals from around the world', '52785', 'Dal cooks in a single pot and comes from Indian home cooking.'],
  ['team-2', 'comfort food under 45 minutes', '53367', 'Fried rice is quick comfort food.'],
  ['team-3', 'high-protein chicken dinners', '53161', 'Chicken thighs make this rice pot high in protein.'],
  ['team-5', 'seafood for beginners', '52870', 'An easy meat-free night between fish dinners.'],
  ['team-2', 'comfort food under 45 minutes', '52826', 'Chilli is classic comfort food, and it reheats well.'],
];

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (minutes) => new Date(Date.UTC(2026, 0, 12, 15, 0) + minutes * 60000).toISOString();

async function meal(id) {
  const res = await fetch(`${API}/lookup.php?i=${id}`);
  const m = (await res.json()).meals?.[0];
  if (!m) throw new Error(`TheMealDB has no meal ${id}`);
  return m;
}

// "2 tbsp chopped" → amount 2, unit "tbsp"; "1/2 cup" → 0.5; "to taste" → null.
function parseMeasure(raw) {
  const s = (raw || '').trim();
  const m = s.match(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/);
  if (!m) return { amount: null, unit: null };
  const num = m[1].includes('/')
    ? m[1].split(/\s+/).reduce((sum, part) => sum + (part.includes('/') ? Number(part.split('/')[0]) / Number(part.split('/')[1]) : Number(part)), 0)
    : Number(m[1]);
  const units = ['g', 'kg', 'oz', 'lb', 'lbs', 'ml', 'l', 'tsp', 'tbsp', 'tblsp', 'tbs', 'cup', 'cups', 'pinch', 'clove', 'cloves', 'can', 'cans', 'tin', 'tins', 'slice', 'slices', 'handful', 'bunch', 'sprig', 'sprigs'];
  const unit = m[2] && units.includes(m[2].toLowerCase()) ? m[2].toLowerCase() : null;
  return { amount: num > 0 ? Math.round(num * 1000) / 1000 : null, unit };
}

const recipes = [];
const prices = {};
let n = 0;
for (const [group, theme, picks] of GROUPS) {
  for (const [id, minutes, servings, price, why] of picks) {
    n += 1;
    const m = await meal(id);
    const ingredients = [];
    for (let i = 1; i <= 20; i += 1) {
      const name = (m[`strIngredient${i}`] || '').trim();
      if (!name) continue;
      const raw = (m[`strMeasure${i}`] || '').trim() || null;
      ingredients.push({ name: name.toLowerCase(), ...parseMeasure(raw), raw });
    }
    const extra = EXTRA_PICKS.filter((e) => e[2] === id);
    recipes.push({
      id: uuid(n),
      group_name: group,
      theme,
      meal_id: id,
      name: m.strMeal.trim(),
      category: m.strCategory || null,
      cuisine: m.strArea || null,
      ingredients,
      instructions: m.strInstructions.trim(),
      est_minutes: minutes,
      est_servings: servings,
      image_url: m.strMealThumb,
      source_url: /^https?:\/\//.test(m.strSource || '') ? m.strSource : null,
      why_chosen: why,
      status: 'new',
      created_at: at(n * 7),
      processed_at: null,
      processed_by: null,
      picks: [
        { group, theme, why_chosen: why, at: at(n * 7) },
        ...extra.map(([g, t, , w], k) => ({ group: g, theme: t, why_chosen: w, at: at(200 + n * 7 + k) })),
      ],
    });
    prices[id] = price;
  }
}

const out = {
  format: 'recipe-coordinator-backup',
  version: 2,
  exported_at: at(0),
  counts: { recipes: recipes.length, plans: 0, activity: 0 },
  recipes,
  plans: [],
  activity: [],
};

writeFileSync(
  new URL('../lib/sample-db.js', import.meta.url),
  `// The sample database the admin can load from the Admin page. Generated by
// scripts/make-sample-db.mjs from TheMealDB: edit that script, not this file.
// Recipe data and images: TheMealDB (https://www.themealdb.com).

// Ready-made prices per serving (USD), used when the admin loads the sample
// with prices. They are estimates, not Kroger prices, and are labelled so.
export const SAMPLE_PRICES = ${JSON.stringify(prices, null, 2)};

export const SAMPLE_DB = ${JSON.stringify(out, null, 2)};
`,
);
console.log(`Wrote ${recipes.length} recipes with ${recipes.reduce((s, r) => s + r.picks.length, 0)} picks.`);
