// Units for the Pricer: what share of a package a recipe uses. The AI decides
// which product and how much of it; this code does the arithmetic.

const UNITS = {
  // weight, in grams
  g: ['mass', 1], gram: ['mass', 1], grams: ['mass', 1],
  kg: ['mass', 1000], kilogram: ['mass', 1000], kilograms: ['mass', 1000],
  oz: ['mass', 28.3495], ounce: ['mass', 28.3495], ounces: ['mass', 28.3495],
  lb: ['mass', 453.592], lbs: ['mass', 453.592], pound: ['mass', 453.592], pounds: ['mass', 453.592],
  // volume, in millilitres
  ml: ['volume', 1], millilitre: ['volume', 1], milliliter: ['volume', 1], millilitres: ['volume', 1], milliliters: ['volume', 1],
  l: ['volume', 1000], litre: ['volume', 1000], liter: ['volume', 1000], litres: ['volume', 1000], liters: ['volume', 1000],
  tsp: ['volume', 4.92892], teaspoon: ['volume', 4.92892], teaspoons: ['volume', 4.92892],
  tbsp: ['volume', 14.7868], tablespoon: ['volume', 14.7868], tablespoons: ['volume', 14.7868],
  cup: ['volume', 236.588], cups: ['volume', 236.588],
  'fl oz': ['volume', 29.5735], floz: ['volume', 29.5735], 'fluid ounce': ['volume', 29.5735], 'fluid ounces': ['volume', 29.5735],
  pt: ['volume', 473.176], pint: ['volume', 473.176], pints: ['volume', 473.176],
  qt: ['volume', 946.353], quart: ['volume', 946.353], quarts: ['volume', 946.353],
  gal: ['volume', 3785.41], gallon: ['volume', 3785.41], gallons: ['volume', 3785.41],
  // things you count
  each: ['count', 1], ea: ['count', 1], ct: ['count', 1], count: ['count', 1], piece: ['count', 1], pieces: ['count', 1],
  pk: ['count', 1], pack: ['count', 1], bunch: ['count', 1], head: ['count', 1], clove: ['count', 1], cloves: ['count', 1],
};

export const unitNames = () => [...new Set(Object.keys(UNITS))];

// A unit name to its family and size in the family's base unit.
export function unit(name) {
  const key = String(name ?? '').trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
  const hit = UNITS[key] ?? UNITS[key.replace(/s$/, '')];
  return hit ? { family: hit[0], factor: hit[1] } : null;
}

// Kroger package sizes: "16.9 fl oz", "3 lb", "12 ct", "each", "2 ct / 8 oz", "1/2 gal".
// Returns { family, base } (base in g, ml or items), or null when it can't tell.
export function parseSize(size) {
  const text = String(size ?? '').toLowerCase();
  if (!text.trim()) return null;
  if (/^\s*(each|ea)\s*$/.test(text)) return { family: 'count', base: 1 };
  const re = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+)?)\s*(fl\.?\s*oz|fluid ounces?|[a-z]+)/g;
  for (const m of text.matchAll(re)) {
    const u = unit(m[2].replace(/\./g, '').replace(/fl\s*oz/, 'fl oz'));
    if (!u) continue;
    const n = m[1].includes('/') ? m[1].split('/').map(Number).reduce((a, b) => a / b) : Number(m[1]);
    if (n > 0) return { family: u.family, base: n * u.factor };
  }
  return null;
}

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

// What a recipe's quantity of a product costs.
//   amount, unitName: how much the recipe uses, e.g. 2 "tbsp", or 0.5 "each"
//   grams: the AI's estimate of that quantity's weight, used when the package
//          is sold by weight and the recipe measures by volume (or the other way)
// Returns { fraction, packages, cost_used_usd, cost_to_buy_usd, note } or { error }.
export function priceShare({ amount, unitName, grams, size, price }) {
  const pkg = parseSize(size);
  if (!pkg) return { error: `can't read the package size "${size}"; choose a product whose size is a weight, volume or count` };
  const used = unit(unitName);
  if (!used) return { error: `unknown unit "${unitName}"; use one of g, kg, oz, lb, ml, l, tsp, tbsp, cup, fl oz, each` };
  if (!(amount > 0)) return { error: 'amount_used must be more than 0' };

  let fraction;
  let note = null;
  if (used.family === pkg.family) {
    fraction = (amount * used.factor) / pkg.base;
  } else if (pkg.family !== 'count' && used.family !== 'count' && grams > 0) {
    // Weight against volume: assume 1 ml weighs 1 g.
    fraction = grams / pkg.base;
    note = 'converted between weight and volume using your grams estimate (1 ml ≈ 1 g)';
  } else if (pkg.family !== 'count' && used.family === 'count' && grams > 0) {
    fraction = grams / pkg.base;
    note = 'converted a count to weight using your grams estimate';
  } else if (pkg.family === 'count') {
    return { error: `this product is sold by count (size "${size}"): give amount_used in "each", e.g. 0.5 for half of one` };
  } else {
    return { error: `can't convert ${unitName} to this package's ${pkg.family}: include grams, your estimate of the weight used` };
  }
  const packages = Math.max(1, Math.ceil(fraction - 1e-9));
  return {
    fraction: round(fraction, 4),
    packages,
    cost_used_usd: round(fraction * price),
    cost_to_buy_usd: round(packages * price),
    note,
  };
}
