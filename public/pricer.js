// Pricer page: the agent's prompt (editable when signed in with the admin
// key), the queue of recipes, and for one recipe its shopping cart and every
// step the agent took. Refreshes itself while the agent works.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORE = 'rc-admin-key'; // shared with the Admin page
  let key = '';
  try { key = sessionStorage.getItem(STORE) || ''; } catch { /* storage unavailable */ }

  let overview = null;
  let selected = decodeURIComponent(location.hash.slice(1)) || null;
  let detail = null;
  let promptDirty = false;
  let timer = null;

  // ---------------------------------------------------------------- helpers
  const el = (tag, { dataset, ...props } = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    if (dataset) Object.assign(node.dataset, dataset);
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  };
  const money = (n) => (n == null ? '–' : `$${Number(n).toFixed(2)}`);
  const num = (n, digits = 0) => (n == null ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
  const STATUS = { pending: 'Waiting', pricing: 'Pricing…', priced: 'Priced', failed: 'Couldn’t price' };
  const pill = (status) => el('span', { className: `pill price-${status}`, textContent: STATUS[status] || status });

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body.errors || [`HTTP ${res.status}`]).join(' '));
    return body;
  }

  async function control(action, body = {}) {
    const res = await fetch(`/api/pricer?action=${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 503) signOut(out.errors?.[0] || 'Your admin key was rejected. Sign in again.');
    return { ok: res.ok, body: out, errors: out.errors || (res.ok ? [] : [`HTTP ${res.status}`]) };
  }

  let toastTimer;
  function toast(text, bad = false) {
    const t = $('toast');
    t.textContent = text;
    t.className = `toast${bad ? ' bad' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  // Buttons with data-confirm need a second click within 4 seconds.
  function confirmed(btn) {
    if (!btn.dataset.confirm) return true;
    if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; return true; }
    btn.dataset.label = btn.textContent;
    btn.dataset.armed = '1';
    btn.textContent = btn.dataset.confirm;
    setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = btn.dataset.label; } }, 4000);
    return false;
  }

  // ---------------------------------------------------------------- sign in
  function showSignedIn() {
    const on = Boolean(key);
    $('signin').hidden = on;
    $('controls').hidden = !on;
    $('prompt').readOnly = !on;
    $('prompt-kind').textContent = on ? 'Prompt · editable' : 'Prompt';
    if (detail) renderDetail();
  }
  function signOut(message) {
    key = '';
    try { sessionStorage.removeItem(STORE); } catch { /* ignore */ }
    showSignedIn();
    if (message) { $('signin-result').textContent = message; $('signin-result').className = 'keycheck-result bad'; }
  }
  $('signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const candidate = $('admin-key').value.trim();
    if (!candidate) return;
    const res = await fetch('/api/admin/check', { headers: { authorization: `Bearer ${candidate}` }, cache: 'no-store' });
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      $('signin-result').textContent = out.errors?.[0] || 'That key didn’t work.';
      $('signin-result').className = 'keycheck-result bad';
      return;
    }
    key = candidate;
    try { sessionStorage.setItem(STORE, key); } catch { /* ignore */ }
    $('admin-key').value = '';
    $('signin-result').textContent = '';
    showSignedIn();
  });
  $('signout').addEventListener('click', () => signOut());

  // ---------------------------------------------------------------- prompt
  $('prompt').addEventListener('input', () => {
    promptDirty = $('prompt').value !== overview?.prompt;
    $('prompt-state').textContent = promptDirty ? 'Unsaved changes' : '';
  });
  $('save-prompt').addEventListener('click', async () => {
    const r = await control('prompt', { prompt: $('prompt').value });
    if (!r.ok) return toast(r.errors.join(' '), true);
    promptDirty = false;
    toast('Saved. Recipes priced from now on follow this prompt.');
    refresh();
  });
  $('reset-prompt').addEventListener('click', async (e) => {
    if (!confirmed(e.currentTarget)) return;
    const r = await control('prompt', { reset: true });
    if (!r.ok) return toast(r.errors.join(' '), true);
    promptDirty = false;
    $('prompt').value = r.body.prompt;
    toast('Back to the default prompt.');
    refresh();
  });
  $('run').addEventListener('click', async () => {
    const r = await control('run');
    toast(r.ok ? 'Started: waiting recipes are being priced.' : r.errors.join(' '), !r.ok);
    setTimeout(refresh, 1500);
  });
  $('retry').addEventListener('click', async () => {
    const r = await control('retry-failed');
    toast(r.ok ? `${r.body.queued} failed recipe${r.body.queued === 1 ? '' : 's'} queued again.` : r.errors.join(' '), !r.ok);
    refresh();
  });
  $('reprice-all').addEventListener('click', async (e) => {
    if (!confirmed(e.currentTarget)) return;
    const r = await control('reprice-all', { confirm: 'REPRICE' });
    toast(r.ok ? `${r.body.queued} recipes queued to be priced again.` : r.errors.join(' '), !r.ok);
    refresh();
  });

  // ---------------------------------------------------------------- overview
  function renderOverview() {
    const o = overview;
    $('facts').replaceChildren(
      'Model ', el('code', { textContent: o.model }),
      ' · Kroger store near ZIP ', el('code', { textContent: o.zip }),
      ' · up to ', String(o.limits.tool_calls), ' tool calls per recipe',
    );
    const problem = $('problem');
    problem.hidden = !o.problem;
    if (o.problem) problem.replaceChildren(el('h2', { textContent: 'The Pricer isn’t running yet' }), el('p', { textContent: o.problem }));

    if (!promptDirty && document.activeElement !== $('prompt')) $('prompt').value = o.prompt;
    $('prompt-state').textContent = promptDirty ? 'Unsaved changes' : o.prompt_is_default ? 'The default prompt' : 'Edited by the instructor';

    const c = o.counts;
    $('counts').replaceChildren(
      ...[['pricing', 'being priced'], ['pending', 'waiting'], ['priced', 'priced'], ['failed', 'couldn’t be priced']]
        .map(([s, label]) => el('span', { className: `count-chip price-${s}` }, el('strong', { textContent: String(c[s]) }), ` ${label}`)),
    );

    $('queue-empty').hidden = o.pricings.length > 0;
    $('queue').replaceChildren(...o.pricings.map((p) => {
      const perServing = p.status === 'priced' && p.people ? p.total_cost_usd / p.people : null;
      const img = safeUrl(p.image_url) ? el('img', { src: `${p.image_url}/small`, alt: '', loading: 'lazy' }) : el('span', { className: 'thumb-blank' });
      return el('li', {},
        el('button', { type: 'button', className: `queue-item${p.meal_id === selected ? ' selected' : ''}`, onclick: () => select(p.meal_id) },
          img,
          el('span', { className: 'queue-text' },
            el('span', { className: 'queue-name', textContent: p.name || `Recipe ${p.meal_id}` }),
            el('span', { className: 'queue-meta' },
              pill(p.status),
              p.status === 'priced' ? ` ${money(p.to_buy_usd)} cart · ${money(perServing)}/serving` : '',
              p.status === 'pricing' ? ` ${p.lines_done ?? 0} of ${p.lines ?? '?'} ingredients` : '',
            ),
          ),
        ),
      );
    }));

    if (!selected && o.pricings.length) select((o.pricings.find((p) => p.status === 'pricing') || o.pricings[0]).meal_id, { quiet: true });
  }

  function select(mealId, { quiet } = {}) {
    selected = mealId;
    if (!quiet) history.replaceState(null, '', `#${encodeURIComponent(mealId)}`);
    renderOverview();
    loadDetail();
  }

  // ---------------------------------------------------------------- one recipe
  async function loadDetail() {
    if (!selected) return;
    try {
      detail = await getJson(`/api/pricer?meal_id=${encodeURIComponent(selected)}`);
    } catch (e) {
      detail = null;
      $('detail').replaceChildren(el('p', { className: 'empty', textContent: e.message }));
      return;
    }
    renderDetail();
  }

  function stepCard(s) {
    const head = el('p', { className: 'step-head' }, el('span', { className: 'step-time', textContent: time(s.at) }));
    if (s.kind === 'thought') return el('li', { className: 'trace-step thought' }, head, el('p', { textContent: s.text }));
    if (s.kind === 'final') return el('li', { className: 'trace-step final' }, head, el('p', {}, el('strong', { textContent: 'Finished. ' }), s.text));
    if (s.kind === 'error') {
      return el('li', { className: 'trace-step error' }, head, el('p', {}, s.tool ? el('code', { textContent: s.tool }) : null, s.tool ? ' was rejected: ' : '', s.text));
    }
    if (s.kind === 'tool_call') {
      const args = Object.entries(s.input || {}).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${typeof v === 'string' ? `“${v}”` : v}`).join(', ');
      return el('li', { className: 'trace-step call' }, head, el('p', {}, '→ ', el('code', { textContent: s.tool }), ` ${args}`));
    }
    // tool_result: a short summary, with the full answer folded away
    const o = s.output || {};
    let summary = 'Done';
    if (s.tool === 'search_kroger') summary = o.count ? `${o.count} products, e.g. ${o.products[0].description} (${o.products[0].size}) ${money(o.products[0].promo_price_usd ?? o.products[0].price_usd)}` : 'No products found';
    if (s.tool === 'search_usda') summary = o.count ? `${o.count} foods, e.g. ${o.foods[0].description}` : 'No foods found';
    if (s.tool === 'record_ingredient') summary = `Line ${o.recorded}: buy ${o.packages_to_buy}, uses ${money(o.cost_used_usd)} worth`;
    if (s.tool === 'skip_ingredient') summary = `Line ${o.skipped} skipped`;
    return el('li', { className: 'trace-step result' }, head,
      el('details', {}, el('summary', { textContent: `← ${summary}` }), el('pre', { className: 'code', textContent: JSON.stringify(o, null, 2) })));
  }

  function renderDetail() {
    const d = detail;
    if (!d) return;
    const r = d.recipe || {};
    const lines = r.ingredients || [];
    const byLine = new Map((d.basket || []).map((e) => [e.line, e]));
    const people = d.people;
    const perServing = (x) => (x == null || !people ? null : x / people);
    const n = d.nutrition_total || {};

    const head = el('div', { className: 'detail-head' },
      safeUrl(r.image_url) ? el('img', { src: `${r.image_url}/medium`, alt: '' }) : null,
      el('div', {},
        el('h3', {}, /^\d+$/.test(d.meal_id) ? el('a', { href: `https://www.themealdb.com/meal/${d.meal_id}`, target: '_blank', rel: 'noopener', textContent: r.name || d.meal_id }) : (r.name || d.meal_id)),
        el('p', { className: 'small muted' }, pill(d.status), ` TheMealDB ${d.meal_id} · serves about ${r.est_servings ?? '?'} as written`, d.store_id ? ` · Kroger store ${d.store_id}` : ''),
        key ? el('button', { type: 'button', className: 'btn small-btn', textContent: 'Price again', onclick: async () => {
          const res = await control('price', { meal_id: d.meal_id });
          toast(res.ok ? 'Queued: it will be priced again with the current prompt.' : res.errors.join(' '), !res.ok);
          refresh();
        } }) : null,
      ),
    );

    const tiles = d.status === 'priced' ? el('div', { className: 'cart-tiles' },
      el('div', { className: 'tile' }, el('span', { textContent: 'Cart total' }), el('strong', { textContent: money(d.to_buy_usd) }), el('small', { textContent: `for ${people} people` })),
      el('div', { className: 'tile' }, el('span', { textContent: 'Cost per serving' }), el('strong', { textContent: money(perServing(d.total_cost_usd)) }), el('small', { textContent: `ingredients used: ${money(d.total_cost_usd)}` })),
      el('div', { className: 'tile' }, el('span', { textContent: 'Per serving' }), el('strong', { textContent: `${num(perServing(n.calories))} kcal` }),
        el('small', { textContent: `${num(perServing(n.protein_g), 1)} g protein · ${num(perServing(n.fiber_g), 1)} g fibre · ${num(perServing(n.sodium_mg))} mg sodium` })),
    ) : null;

    const rows = lines.map((ing, i) => {
      const e = byLine.get(i + 1);
      const what = el('td', {}, el('strong', { textContent: ing.name }), el('br'), el('span', { className: 'small muted', textContent: ing.raw || 'no amount' }));
      if (!e) return el('tr', { className: 'waiting' }, el('td', { textContent: String(i + 1) }), what, el('td', { colSpan: 5, className: 'muted', textContent: d.status === 'pricing' ? 'Not yet…' : '–' }));
      if (e.status === 'skipped') {
        return el('tr', { className: 'skipped' }, el('td', { textContent: String(i + 1) }), what,
          el('td', { colSpan: 4, className: 'muted' }, 'Not bought: ', e.reason),
          el('td', { className: 'num', textContent: e.nutrition ? `${num(e.nutrition.calories)} kcal` : '–' }));
      }
      const p = e.product;
      return el('tr', {},
        el('td', { textContent: String(i + 1) }),
        what,
        el('td', {}, p.description, el('br'), el('span', { className: 'small muted', textContent: [p.size, p.brand].filter(Boolean).join(' · ') }), p.on_sale ? el('span', { className: 'pill sale', textContent: 'On sale' }) : null),
        el('td', { className: 'num' }, el('strong', { textContent: `× ${e.packages}` }), el('br'), el('span', { className: 'small muted', textContent: `at ${money(p.price_usd)}` })),
        el('td', { className: 'num' }, el('strong', { textContent: money(e.cost_to_buy_usd) })),
        el('td', { className: 'num' }, `${num(e.amount_used, 2)} ${e.unit_used}`, el('br'), el('span', { className: 'small muted', textContent: `${money(e.cost_used_usd)} used` })),
        el('td', { className: 'num', textContent: e.nutrition ? `${num(e.nutrition.calories)} kcal` : '–', title: e.usda ? `USDA: ${e.usda.description}` : 'No USDA match' }),
      );
    });
    const cart = el('div', { className: 'table-wrap cart' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['#', 'Ingredient', 'Kroger product', 'Buy', 'Line total', 'Recipe uses', 'Nutrition'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, rows),
      d.status === 'priced' ? el('tfoot', {}, el('tr', {}, el('td', {}), el('td', { colSpan: 3, textContent: `Cart for ${people} people` }), el('td', { className: 'num' }, el('strong', { textContent: money(d.to_buy_usd) })),
        el('td', { className: 'num', textContent: `${money(d.total_cost_usd)} used` }), el('td', { className: 'num', textContent: `${num(n.calories)} kcal` }))) : null,
    ));

    const notes = [
      d.summary ? el('p', { className: 'cart-summary' }, el('strong', { textContent: 'The agent’s summary: ' }), d.summary) : null,
      d.error ? el('p', { className: 'errors', textContent: `Stopped: ${d.error}` }) : null,
      d.status === 'pending' ? el('p', { className: 'muted', textContent: 'Waiting for its turn. The agent prices recipes one or two at a time.' }) : null,
    ];

    const trace = el('div', { className: 'trace' },
      el('h3', {}, 'What the agent is doing ', el('span', { className: 'small muted', textContent: `${d.tool_calls} tool call${d.tool_calls === 1 ? '' : 's'}${d.attempts > 1 ? ` · run ${d.attempts}` : ''}` })),
      d.steps.length ? el('ol', { className: 'trace-list' }, d.steps.map(stepCard)) : el('p', { className: 'muted', textContent: 'No steps yet.' }),
    );

    const promptUsed = d.prompt && overview && d.prompt !== overview.prompt
      ? el('details', { className: 'small' }, el('summary', { textContent: 'Priced with an earlier version of the prompt' }), el('pre', { className: 'code', textContent: d.prompt }))
      : null;

    // Keep open "details" open across refreshes.
    const open = new Set([...$('detail').querySelectorAll('.trace-step details[open]')].map((x) => x.parentElement.dataset.id));
    $('detail').replaceChildren(...[head, tiles, ...notes, promptUsed, el('h3', { textContent: 'Shopping cart' }), cart, trace].filter(Boolean));
    [...$('detail').querySelectorAll('.trace-step')].forEach((li, i) => {
      li.dataset.id = String(d.steps[i]?.id);
      if (open.has(li.dataset.id)) li.querySelector('details')?.setAttribute('open', '');
    });
  }

  // ---------------------------------------------------------------- refresh
  async function refresh() {
    clearTimeout(timer);
    try {
      overview = await getJson('/api/pricer');
      renderOverview();
      if (selected) await loadDetail();
    } catch (e) {
      $('detail').replaceChildren(el('p', { className: 'empty', textContent: `Couldn’t load the Pricer: ${e.message}` }));
    }
    const busy = overview && (overview.counts.pricing > 0 || overview.counts.pending > 0);
    timer = setTimeout(refresh, busy ? 3000 : 15000);
  }

  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && id !== selected) select(id, { quiet: true });
  });
  showSignedIn();
  refresh();
})();
