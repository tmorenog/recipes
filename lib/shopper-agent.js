// The Shopper Agent's own tools, like the Recipe Pricer's: the agent decides
// what to buy; this code checks Kroger at the class store today and does the
// arithmetic. The coordinator only serves the plan's ingredients (the Pricer's
// carts) and checks and stores the cart the agent builds here.
//
// A need is one ingredient line of one dinner, scaled to the people shopped
// for. A cart line is one Kroger product bought for one or more needs: the
// amounts are converted into that product's packages, added up, and rounded up
// once, so an ingredient several dinners share is bought once.
import { productAtStore, searchProducts } from './kroger.js';
import { parseSize } from './units.js';
import * as pricer from './pricer.js';

const round2 = (x) => Math.round(x * 100) / 100;
// A line needing this many packages or more may empty a shelf: worth checking,
// and worth a larger size if the store has one.
export const MANY_PACKAGES = 10;
// Why a line is worth checking before buying: Kroger's rough stock level (not a
// count, and not always reliable) or a large number of packages. Null when fine.
function stockCheck(l) {
  const why = [];
  if (l.stock === 'TEMPORARILY_OUT_OF_STOCK') why.push('Kroger says it’s out of stock at the moment');
  else if (l.stock === 'LOW') why.push('Kroger says stock is low');
  if (l.packages >= MANY_PACKAGES) why.push(`${l.packages} packages is a lot for one shelf`);
  return why.length ? why.join('; ') : null;
}
const ids = { type: 'array', items: { type: 'string' }, description: 'need_ids from start_cart' };

export const SHOPPER_TOOLS = [
  {
    name: 'start_cart',
    description:
      'Start the week’s cart for one plan: reads its ingredients from the coordinator and lists every need (one ingredient of one dinner) ' +
      'scaled to the people you shop for, sorted by ingredient so ones several dinners share sit together, with the product the Recipe Pricer chose. ' +
      'Starting again empties the cart.',
    input_schema: { type: 'object', properties: { plan_id: { type: 'string' } }, required: ['plan_id'], additionalProperties: false },
  },
  {
    name: 'buy_as_priced',
    description:
      'Buy needs with the product the Recipe Pricer chose for each (default: every need not in the cart yet). Needs that share a product are bought together. ' +
      'Each product is checked at the class Kroger store today; ones it no longer carries are left out and listed, for you to replace with buy. ' +
      'Estimated prices are kept as estimates.',
    input_schema: { type: 'object', properties: { needs: ids }, additionalProperties: false },
  },
  {
    name: 'search_kroger',
    description: 'Search the class Kroger store. Returns up to 5 products with product_id, description, size and today’s price.',
    input_schema: { type: 'object', properties: { term: { type: 'string' } }, required: ['term'], additionalProperties: false },
  },
  {
    name: 'buy',
    description:
      'Buy one Kroger product for one or more needs: to replace a product the store no longer carries or an estimate, or to buy an ingredient several dinners share once ' +
      '(e.g. one bag size of yellow onions for three dinners). A need already in the cart moves to this product. Code checks the product today, converts the amounts into its packages, ' +
      'adds them up and rounds up once. Several items per call.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string', description: 'A product_id from search_kroger or start_cart' },
              needs: ids,
              packages: { type: 'integer', description: 'Only when the amounts can’t be converted into this product’s size (e.g. a count and a weight): how many to buy' },
              note: { type: 'string', description: 'Why, in a few words, e.g. "no longer carried" or "one bag for three dinners"' },
            },
            required: ['product_id', 'needs'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'review_cart',
    description: 'The cart so far: each line with its packages, cost and needs; needs not in the cart yet; the total.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// Amounts in words, for the agent: "about 3.4 lb", "about 25 fl oz", "about 6".
function amount(base, family) {
  if (base == null) return null;
  if (family === 'mass') return base >= 453.592 ? `about ${round2(base / 453.592)} lb` : `about ${round2(base / 28.3495)} oz`;
  if (family === 'volume') return base >= 946 ? `about ${round2(base / 3785.41)} gal` : `about ${round2(base / 29.5735)} fl oz`;
  return `about ${round2(base)}`;
}

// One run's shopping. coordCall(name, input) → { text, isError } calls the coordinator.
export function createShopper({ people, coordCall, fetchImpl = () => pricer.krogerFetch() }) {
  let plan = null; // { plan_id, group }
  let needs = new Map(); // need_id → need
  let lines = new Map(); // product_id → line
  let store; // the class store, or null when Kroger can't be reached
  let krogerProblem = null;
  const today = new Map(); // product_id → Kroger's product today (null: not carried)
  const changed = new Set();

  async function classStore() {
    if (store !== undefined) return store;
    try {
      store = await pricer.classStore();
    } catch (e) {
      store = null;
      krogerProblem = e.message;
    }
    return store;
  }
  // Kroger's product at the class store today: { product } (null when not
  // carried or no price), or { error } when Kroger can't be asked.
  async function lookup(productId) {
    if (today.has(productId)) return { product: today.get(productId) };
    const s = await classStore();
    if (!s) return { error: krogerProblem };
    const res = await productAtStore({ product_id: productId, store_id: s.store_id }, fetchImpl());
    if (!res.ok) return { error: res.errors.join(' ') };
    const p = res.product && (res.product.promo_price_usd ?? res.product.price_usd) != null ? res.product : null;
    today.set(productId, p);
    return { product: p };
  }

  const uncovered = () => [...needs.values()].filter((n) => !n.line).map((n) => n.need_id);
  function detach(needId) {
    const n = needs.get(needId);
    if (!n?.line) return;
    const line = lines.get(n.line);
    line.shares.delete(needId);
    n.line = null;
    if (!line.shares.size) lines.delete(line.product_id);
    else price(line);
  }
  function price(line) {
    const share = [...line.shares.values()].reduce((s, x) => s + x, 0);
    // Packages given for needs that couldn't be converted, plus the others' shares rounded up once.
    line.packages = Math.max(1, (line.extra ?? 0) + Math.ceil(share - 1e-9));
    line.cost_usd = round2(line.packages * line.price_usd);
  }
  // Adds needs to the line for a product (made if new), each with its share of one package.
  function put(product, shares, { estimated = false, note, extra, pricedAt } = {}) {
    const line = lines.get(product.product_id) ?? {
      product_id: product.product_id, description: product.description, brand: product.brand ?? null, size: product.size,
      price_usd: product.price_usd, image_url: product.image_url ?? null, estimated, stock: product.stock ?? null, shares: new Map(), notes: [],
    };
    if (pricedAt != null && Math.abs(pricedAt - product.price_usd) >= 0.01) line.priced_at_usd = pricedAt;
    if (note) line.notes.push(note);
    if (extra) line.extra = (line.extra ?? 0) + extra;
    for (const [id, share] of shares) {
      detach(id);
      line.shares.set(id, share);
      needs.get(id).line = product.product_id;
    }
    lines.set(product.product_id, line);
    price(line);
    return line;
  }
  const lineView = (l) => ({
    product_id: l.product_id, description: l.description, size: l.size, price_usd: l.price_usd, packages: l.packages, cost_usd: l.cost_usd,
    needs: [...l.shares.keys()], ...(l.estimated && { estimated: true }), ...(l.priced_at_usd != null && { priced_at_usd: l.priced_at_usd }),
    ...(stockCheck(l) && { check_stock: stockCheck(l) }),
  });
  // Lines worth a look: many packages, or a low or out-of-stock level.
  const toCheck = () => [...lines.values()].filter((l) => stockCheck(l)).map((l) => ({ product_id: l.product_id, description: l.description, size: l.size, packages: l.packages, why: stockCheck(l) }));
  const CHECK_HINT = `For a line needing ${MANY_PACKAGES} packages or more, search for a larger size of the same product and buy it for the same needs if it means fewer packages at a similar price. Kroger’s stock levels are rough: note them, don’t rely on them.`;
  const total = () => round2([...lines.values()].reduce((s, l) => s + l.cost_usd, 0));
  const unknownNeeds = (list) => list.filter((id) => !needs.has(id));

  const tools = {
    async start_cart({ plan_id }) {
      const res = await coordCall('get_plan_ingredients', { plan_id });
      if (res.isError) return { error: res.text };
      const data = JSON.parse(res.text);
      plan = { plan_id: data.plan_id, group: data.group };
      needs = new Map();
      lines = new Map();
      for (const d of data.dinners) {
        for (const n of d.needs) {
          const scaled = n.packages_for_pricer_people * (d.pricer_people > 0 ? people / d.pricer_people : 1); // packages of the Pricer's product
          const pkg = parseSize(n.product.size);
          needs.set(n.need_id, {
            ...n, day: d.day, dinner: d.name, scaled, family: pkg?.family ?? null, base: pkg ? scaled * pkg.base : null, line: null,
          });
        }
      }
      const list = [...needs.values()].sort((a, b) => a.ingredient.localeCompare(b.ingredient) || a.need_id.localeCompare(b.need_id));
      const byProduct = new Map();
      for (const n of list) byProduct.set(n.product.id, [...(byProduct.get(n.product.id) ?? []), n.need_id]);
      return {
        plan_id: plan.plan_id, group: plan.group, people, needs_count: list.length,
        needs: list.map((n) => ({
          need_id: n.need_id, day: n.day, ingredient: n.ingredient, needed: amount(n.base, n.family) ?? `${round2(n.scaled)} × ${n.product.size}`,
          pricer_product: { product_id: n.product.id, description: n.product.description, size: n.product.size, price_usd: n.product.price_usd },
          ...(n.estimated && { estimated: true, estimate_reason: n.estimate_reason }), ...(n.substitute_for && { pricer_substitute_for: n.substitute_for }),
        })),
        same_pricer_product: [...byProduct.values()].filter((v) => v.length > 1),
        next: 'buy_as_priced buys the Pricer’s products; then look for the same ingredient bought as different products, and for products the store no longer carries, and use buy.',
      };
    },

    async buy_as_priced({ needs: which } = {}) {
      if (!plan) return { error: 'start_cart first' };
      const list = which?.length ? which : uncovered();
      const unknown = unknownNeeds(list);
      if (unknown.length) return { error: `not need_ids of this plan: ${unknown.join(', ')}` };
      const groups = new Map();
      for (const id of list) {
        const n = needs.get(id);
        groups.set(n.product.id, [...(groups.get(n.product.id) ?? []), n]);
      }
      const notCarried = [];
      const unchecked = [];
      for (const [productId, group] of groups) {
        const p = group[0].product;
        const shares = group.map((n) => [n.need_id, n.scaled]);
        if (group[0].estimated) {
          for (const n of group) put({ ...p, product_id: `estimate-${n.need_id}` }, [[n.need_id, n.scaled]], { estimated: true });
          continue;
        }
        const t = await lookup(productId);
        if (t.error) {
          unchecked.push(productId);
          put({ ...p, product_id: productId }, shares);
          continue;
        }
        if (!t.product) {
          notCarried.push({ product_id: productId, description: p.description, size: p.size, needs: group.map((n) => n.need_id) });
          for (const n of group) detach(n.need_id);
          continue;
        }
        const now = t.product.promo_price_usd ?? t.product.price_usd;
        if (Math.abs(now - p.price_usd) >= 0.01) changed.add(productId);
        put({ ...p, product_id: productId, price_usd: now, image_url: t.product.image_url ?? p.image_url, stock: t.product.stock ?? null }, shares, { pricedAt: p.price_usd });
      }
      return {
        lines: [...lines.values()].filter((l) => l.shares.size && [...l.shares.keys()].some((id) => list.includes(id))).map(lineView),
        ...(notCarried.length && { not_carried_today: notCarried, hint: 'search_kroger for each and buy a replacement' }),
        ...(unchecked.length && { not_checked: `Kroger couldn’t be asked (${krogerProblem ?? 'error'}): the Pricer’s prices are used` }),
        ...(toCheck().length && { check_stock: toCheck(), check_stock_hint: CHECK_HINT }),
        still_needed: uncovered(),
        total_usd: total(),
      };
    },

    async search_kroger({ term }) {
      const s = await classStore();
      if (!s) return { error: `Kroger can’t be searched now: ${krogerProblem}` };
      const res = await searchProducts({ term: String(term ?? ''), store_id: s.store_id, limit: 5 }, fetchImpl());
      if (!res.ok) return { error: res.errors.join(' ') };
      const found = res.products.filter((p) => (p.promo_price_usd ?? p.price_usd) != null);
      for (const p of found) today.set(p.product_id, p);
      return {
        count: found.length,
        products: found.map((p) => ({ product_id: p.product_id, description: p.description, brand: p.brand, size: p.size, price_usd: p.promo_price_usd ?? p.price_usd })),
        ...(found.length ? {} : { hint: 'Nothing with a price: try a simpler term.' }),
      };
    },

    async buy({ items }) {
      if (!plan) return { error: 'start_cart first' };
      if (!Array.isArray(items) || !items.length) return { error: 'items: at least one product to buy' };
      const results = [];
      for (const item of items) {
        const list = Array.isArray(item?.needs) ? item.needs : [];
        const unknown = unknownNeeds(list);
        if (!list.length || unknown.length) { results.push({ product_id: item?.product_id, error: unknown.length ? `not need_ids of this plan: ${unknown.join(', ')}` : 'needs: at least one need_id' }); continue; }
        const t = await lookup(String(item.product_id));
        if (t.error) { results.push({ product_id: item.product_id, error: `can’t check it with Kroger: ${t.error}` }); continue; }
        if (!t.product) { results.push({ product_id: item.product_id, error: 'the store doesn’t carry it today (or it has no price): search for another' }); continue; }
        const p = { ...t.product, price_usd: t.product.promo_price_usd ?? t.product.price_usd };
        const pkg = parseSize(p.size);
        const given = Number.isInteger(item.packages) && item.packages > 0 ? item.packages : null;
        const shares = [];
        const mismatched = [];
        for (const id of list) {
          const n = needs.get(id);
          if (n.product.id === p.product_id) shares.push([id, n.scaled]);
          else if (pkg && n.base != null && n.family === pkg.family) shares.push([id, n.base / pkg.base]);
          else if (given) shares.push([id, 0]);
          else mismatched.push(`${id} (${n.product.size ?? '?'})`);
        }
        if (mismatched.length) {
          results.push({ product_id: p.product_id, error: `can’t convert ${mismatched.join(', ')} into this product’s size (${p.size ?? '?'}): give packages, how many to buy for them` });
          continue;
        }
        const line = put(p, shares, { note: item.note, extra: shares.some(([, x]) => x === 0) ? given : 0 });
        results.push({ product_id: p.product_id, description: p.description, size: p.size, price_usd: p.price_usd, packages: line.packages, cost_usd: line.cost_usd, needs: [...line.shares.keys()], ...(stockCheck(line) && { check_stock: stockCheck(line) }) });
      }
      return { results, still_needed: uncovered(), total_usd: total() };
    },

    async review_cart() {
      if (!plan) return { error: 'start_cart first' };
      return { plan_id: plan.plan_id, people, lines: [...lines.values()].map(lineView), ...(toCheck().length && { check_stock: toCheck(), check_stock_hint: CHECK_HINT }), still_needed: uncovered(), total_usd: total() };
    },
  };

  return {
    names: new Set(Object.keys(tools)),
    async run(name, input) {
      return tools[name](input ?? {});
    },
    planId: () => plan?.plan_id ?? null,
    complete: () => Boolean(plan) && !uncovered().length,
    // The cart as the coordinator's save_choice takes it.
    cart() {
      const count = (f) => [...lines.values()].filter(f).length;
      const s = store ?? null;
      return {
        people,
        lines: [...lines.values()].map((l) => {
          const ns = [...l.shares.keys()].map((id) => needs.get(id));
          const insteadOf = [...new Set(ns.filter((n) => n.product.id !== l.product_id && !l.estimated).map((n) => `${n.product.description}${n.product.size ? ` (${n.product.size})` : ''}`))];
          const subs = ns.filter((n) => n.substitute_for).map((n) => `${n.day}: instead of ${n.substitute_for}`);
          return {
            product_id: l.product_id, description: l.description, brand: l.brand, size: l.size, price_usd: l.price_usd,
            packages: l.packages, cost_usd: l.cost_usd, needs: ns.map((n) => n.need_id), used_for: ns.map((n) => `${n.day}: ${n.ingredient}`),
            image_url: l.image_url, ...(l.estimated && { estimated: true }), ...(l.priced_at_usd != null && { priced_at_usd: l.priced_at_usd }),
            ...(stockCheck(l) && { stock_check: stockCheck(l) }),
            ...(insteadOf.length && { instead_of: insteadOf }), ...(subs.length && { substitutes: subs }), ...(l.notes.length && { note: l.notes.join('; ').slice(0, 500) }),
          };
        }).sort((a, b) => b.cost_usd - a.cost_usd),
        total_usd: total(),
        store: s ? { store_id: s.store_id, name: s.name ?? null } : null,
        checked_at: s ? new Date().toISOString() : null,
        kroger_check: s
          ? `The Shopper Agent checked every product with Kroger at ${s.name ?? 'the class store'} today${changed.size ? `; ${changed.size} price${changed.size === 1 ? '' : 's'} changed since pricing` : ''}. ${count((l) => l.shares.size > 1)} product${count((l) => l.shares.size > 1) === 1 ? ' is' : 's are'} shared by several dinners and bought once. ${count((l) => stockCheck(l)) ? `${count((l) => stockCheck(l))} line${count((l) => stockCheck(l)) === 1 ? ' is' : 's are'} marked “Check stock”. ` : ''}Kroger’s stock levels are rough and can be unreliable: double-check quantities before shopping, since buying for many people can empty a shelf.`
          : `Not checked with Kroger today (${krogerProblem ?? 'not reached'}): the prices are the Recipe Pricer’s. Double-check stock quantities before shopping.`,
      };
    },
  };
}
