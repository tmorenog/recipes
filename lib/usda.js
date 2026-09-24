// Nutrition from USDA FoodData Central (free; key from https://api.data.gov/signup/).
// Values are per 100 g of the food. Without USDA_API_KEY the shared DEMO_KEY is
// used, which is heavily rate-limited: fine for a quick try, not for a class.
import { setting } from './env.js';

const API = 'https://api.nal.usda.gov/fdc/v1';

export const usdaKey = (env = process.env) => setting(['USDA_API_KEY', 'FDC_API_KEY'], env);

export class UsdaError extends Error {}

// Nutrient numbers in FoodData Central. Foundation foods sometimes give energy
// only as Atwater factors (957/958), so those are fallbacks for 208.
const ENERGY = ['208', '957', '958'];
const PROTEIN = '203';
const FIBER = '291';
const SODIUM = '307';

function per100g(food) {
  const byNumber = new Map();
  for (const n of food.foodNutrients || []) {
    const num = String(n.nutrientNumber ?? n.nutrient?.number ?? '');
    const value = n.value ?? n.amount;
    if (num && typeof value === 'number' && !byNumber.has(num)) byNumber.set(num, { value, unit: (n.unitName ?? n.nutrient?.unitName ?? '').toLowerCase() });
  }
  const energy = ENERGY.map((k) => byNumber.get(k)).find((e) => e && e.unit !== 'kj');
  const get = (k) => byNumber.get(k)?.value ?? null;
  return { calories: energy?.value ?? null, protein_g: get(PROTEIN), fiber_g: get(FIBER), sodium_mg: get(SODIUM) };
}

// Generic foods first (Foundation, SR Legacy): they describe "onion, raw"
// rather than one brand's product.
export async function searchFoods(query, { fetchImpl = fetch, limit = 5 } = {}) {
  const q = new URLSearchParams({
    query,
    pageSize: String(limit),
    dataType: 'Foundation,SR Legacy',
    api_key: usdaKey() || 'DEMO_KEY',
  });
  const res = await fetchImpl(`${API}/foods/search?${q}`);
  if (res.status === 429) throw new UsdaError('USDA is limiting requests right now (add USDA_API_KEY in Vercel for a higher limit).');
  if (!res.ok) throw new UsdaError(`USDA answered HTTP ${res.status}.`);
  const body = await res.json();
  if (body.error) throw new UsdaError(`USDA: ${body.error.message || body.error.code}`);
  return (body.foods || []).slice(0, limit).map((f) => ({
    fdc_id: f.fdcId,
    description: f.description,
    category: f.foodCategory || null,
    per_100g: per100g(f),
  }));
}
