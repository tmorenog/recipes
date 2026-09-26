// Coordinator page: the live exchange log (what agents send to the coordinator
// and what it answers), and the recipes and meal plans they saved. Filtered in
// the browser; the view and filters are kept in the address.
(() => {
  'use strict';

  const REFRESH_MS = 15000;
  const LIVE_MS = 4000; // the exchange log, while it's showing
  const $ = (id) => document.getElementById(id);
  const VIEWS = ['exchanges', 'recipes', 'plans'];

  const params = new URLSearchParams(location.search);
  const state = {
    view: VIEWS.includes(params.get('view')) ? params.get('view') : 'exchanges',
    agent: params.get('agent') || '',
    group: params.get('group') || '',
    theme: params.get('theme') || '',
    status: params.get('status') || '',
    price: params.get('price') || '',
    sort: params.get('sort') || 'newest',
    result: params.get('result') || '',
  };
  const openRows = new Set(); // recipes whose details are showing
  const data = { recipes: [], plans: [], exchanges: [] };
  const openExchanges = new Set();
  let lastOk = null;

  // ---------------------------------------------------------------- helpers
  // Props with a dash (aria-expanded, aria-label) are attributes; the rest are properties.
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (k.includes('-')) node.setAttribute(k, v); else node[k] = v;
    node.append(...children.filter((c) => c != null && c !== false));
    return node;
  };
  // A refresh rebuilds a list: keep the panels the viewer opened and the
  // button they were on. Rows are told apart by data-key.
  function keepState(container, render) {
    const where = (n) => {
      const row = n.closest('[data-key]');
      return `${row?.dataset.key ?? ''}|${n.tagName}|${[...(row || container).querySelectorAll(n.tagName)].indexOf(n)}`;
    };
    const open = new Set([...container.querySelectorAll('details[open]')].map(where));
    const active = container.contains(document.activeElement) ? where(document.activeElement) : null;
    render();
    for (const d of container.querySelectorAll('details')) if (open.has(where(d))) d.open = true;
    if (active) [...container.querySelectorAll('button, a, summary, input')].find((n) => where(n) === active)?.focus({ preventScroll: true });
  }

  const hue = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const chip = (group) => {
    const c = el('span', { className: 'chip', textContent: group });
    c.style.setProperty('--h', hue(group));
    return c;
  };
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const money = (n) => (n == null ? '–' : `$${Number(n).toFixed(2)}`);
  const ago = (iso) => {
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };
  const when = (iso) => {
    const d = new Date(iso);
    return Date.now() - d < 86400000 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : d.toLocaleString();
  };

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.view !== 'exchanges') p.set('view', state.view);
    for (const k of ['group', 'theme', 'status', 'price', 'agent', 'result']) if (state[k]) p.set(k, state[k]);
    if (state.view === 'recipes' && state.sort !== 'newest') p.set('sort', state.sort);
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
  }

  function fillSelect(select, values, current, allLabel) {
    const options = [['', allLabel], ...values.map((v) => [v, v])];
    if (current && !values.includes(current)) options.push([current, current]);
    select.replaceChildren(...options.map(([value, label]) => new Option(label, value, false, value === current)));
  }

  // ---------------------------------------------------------------- recipes
  const PRICE_TEXT = { unpriced: 'Not priced', pending: 'Waiting to be priced', pricing: 'Being priced…', failed: 'Couldn’t be priced' };

  // The Pricer's result: cost per serving, whether any of it is estimated, or where it's up to.
  function priceCell(r) {
    const p = r.pricing || { status: 'pending' };
    const cell = el('div', { className: 'db-price', role: 'cell' });
    if (p.status === 'priced') {
      cell.append(
        el('a', { className: 'db-money', href: `/pricer#${encodeURIComponent(r.meal_id)}`, title: 'See the cart on the Pricer page' },
          el('strong', { textContent: money(p.cost_per_serving_usd) }), el('span', { textContent: ' a serving' })),
        el('small', { className: 'muted', textContent: `cart ${money(p.cart_usd)} for ${p.people}${p.priced_at ? ` · ${ago(p.priced_at)}` : ''}` }),
        p.estimated
          ? el('span', { className: 'pill estimated', textContent: 'Includes estimates', title: `${p.estimated_lines} line${p.estimated_lines === 1 ? '' : 's'} estimated, not Kroger prices` })
          : el('span', { className: 'pill price-priced', textContent: 'Kroger prices' }),
      );
    } else {
      cell.append(el('span', { className: `pill price-${p.status}`, textContent: PRICE_TEXT[p.status] || p.status }));
    }
    return cell;
  }

  function recipeRow(r) {
    const src = safeUrl(r.image_url);
    const thumb = src
      ? el('img', { className: 'db-thumb', src: /themealdb\.com\/images\/media\/meals\/[^/]+\.(jpg|png)$/i.test(src) ? `${src}/small` : src, alt: '', loading: 'lazy' })
      : el('span', { className: 'db-thumb blank', textContent: 'No photo' });
    thumb.addEventListener?.('error', () => thumb.replaceWith(el('span', { className: 'db-thumb blank', textContent: 'No photo' })), { once: true });

    const link = el('a', { textContent: r.name, target: '_blank', rel: 'noopener' });
    // TheMealDB asks apps to link each meal to its page there.
    if (/^\d+$/.test(r.meal_id)) link.href = `https://www.themealdb.com/meal/${r.meal_id}`;
    else if (safeUrl(r.source_url)) link.href = r.source_url;
    const meta = [r.cuisine, r.category, r.est_minutes && `${r.est_minutes} min`, r.est_servings && `serves ${r.est_servings}`].filter(Boolean).join(' · ');

    // Each recipe is stored once; every group that picked it is shown (its popularity).
    const groups = r.picked_by?.length ? r.picked_by : [r.group];
    const themes = [...new Set((r.picks?.length ? r.picks : [{ theme: r.theme }]).map((p) => p.theme))];
    const open = openRows.has(r.id);
    const toggle = el('button', { type: 'button', className: 'btn small-btn linklike-btn', textContent: open ? 'Hide' : 'Details', 'aria-expanded': String(open) });
    toggle.addEventListener('click', () => { if (open) openRows.delete(r.id); else openRows.add(r.id); render(); });

    const row = el('div', { className: `db-row${r.status === 'processed' ? ' is-processed' : ''}${open ? ' open' : ''}`, role: 'row', 'data-key': r.id },
      thumb,
      el('div', { className: 'db-name', role: 'cell' }, el('strong', {}, link), el('small', { className: 'muted', textContent: meta })),
      el('div', { className: 'db-picks', role: 'cell' },
        el('span', { className: 'db-count', textContent: groups.length === 1 ? '1 group' : `${groups.length} groups` }),
        el('span', { className: 'db-chips' }, ...groups.map(chip)),
        el('small', { className: 'muted', textContent: themes.join(' · ') })),
      priceCell(r),
      el('div', { className: 'db-status', role: 'cell' },
        el('span', { className: `pill ${r.status}`, textContent: r.status === 'new' ? 'New' : 'Processed' }),
        r.status === 'processed' ? el('small', { className: 'muted', textContent: `by ${r.processed_by || 'unknown'}${r.processed_at ? ` · ${ago(r.processed_at)}` : ''}` }) : null),
      el('div', { className: 'db-saved small muted', role: 'cell', textContent: ago(r.created_at) }),
      el('div', { className: 'db-actions', role: 'cell' }, toggle));
    if (!open) return row;

    const picks = r.picks?.length ? r.picks : [{ group: r.group, theme: r.theme, why_chosen: r.why_chosen }];
    const ings = r.ingredients || [];
    row.append(el('div', { className: 'db-detail' },
      el('div', {},
        el('h3', { textContent: 'Why the groups picked it' }),
        el('ul', { className: 'db-whys' }, ...picks.map((p) => el('li', {}, chip(p.group), ` ${p.why_chosen} `, el('span', { className: 'muted small', textContent: `(${p.theme})` })))),
        el('p', { className: 'small' },
          el('a', { href: `/pricer#${encodeURIComponent(r.meal_id)}`, textContent: 'Cart on the Pricer page' }),
          link.href ? ' · ' : '', link.href ? el('a', { href: link.href, target: '_blank', rel: 'noopener', textContent: 'Recipe on TheMealDB' }) : '',
          el('span', { className: 'muted mono', textContent: ` · id ${r.id}` }))),
      el('div', {},
        el('h3', { textContent: `${ings.length} ingredient${ings.length === 1 ? '' : 's'}` }),
        el('ul', { className: 'db-ings' }, ...ings.map((i) => el('li', {}, el('span', { textContent: i.name }), el('span', { className: 'muted', textContent: i.raw || '' })))))));
    return row;
  }

  const SORTS = {
    newest: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    popular: (a, b) => (b.pick_count ?? 1) - (a.pick_count ?? 1) || SORTS.newest(a, b),
    cheapest: (a, b) => (a.pricing?.cost_per_serving_usd ?? Infinity) - (b.pricing?.cost_per_serving_usd ?? Infinity) || SORTS.newest(a, b),
    name: (a, b) => a.name.localeCompare(b.name),
  };

  function renderRecipes() {
    const priced = (r) => r.pricing?.status === 'priced';
    const shown = data.recipes.filter(
      (r) => (!state.group || (r.picked_by || [r.group]).includes(state.group))
        && (!state.theme || (r.picks || [{ theme: r.theme }]).some((p) => p.theme === state.theme))
        && (!state.status || r.status === state.status)
        && (!state.price || (state.price === 'priced' ? priced(r) : state.price === 'estimated' ? priced(r) && r.pricing.estimated : !priced(r))),
    ).sort(SORTS[state.sort] || SORTS.newest);
    keepState($('recipes'), () => $('recipes').replaceChildren(...shown.map(recipeRow)));
    const fresh = data.recipes.filter((r) => r.status === 'new').length;
    const nPriced = data.recipes.filter(priced).length;
    $('shown').textContent = `${shown.length} of ${data.recipes.length} recipes · ${nPriced} priced · ${fresh} new`;
    document.querySelector('.db-head').hidden = !shown.length;
    return [shown.length, data.recipes.length ? 'No recipes match these filters.' : 'No recipes yet. They appear here as soon as a Scout Agent saves one.'];
  }

  // ---------------------------------------------------------------- plans
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const dayIndex = (d) => (typeof d === 'number' ? d - 1 : WEEKDAYS.indexOf(d));

  function planCard(p, recipesById) {
    // Plans store the week's cost per person (older plans: the shopping list total).
    const perPerson = p.meals.some((m) => typeof m.day === 'string');
    // The budget is the most a dinner may cost on average, per person (plans
    // checked before that change had a budget for the whole week).
    const perDinner = perPerson && p.meals.length ? p.total_cost_usd / p.meals.length : null;
    const weekly = (p.rule_checks || []).some((c) => /^The week costs/.test(c.rule));
    const over = p.budget_usd != null && perDinner != null && (weekly ? p.total_cost_usd : perDinner) > p.budget_usd + 0.005;
    const budget = p.budget_usd != null && perPerson ? `budget ${money(p.budget_usd)} ${weekly ? 'for the week' : 'a dinner'}${over ? ', over' : ''}` : null;
    const total = el('span', { className: `plan-total${over ? ' over' : ''}` }, money(p.total_cost_usd),
      el('small', { textContent: [perPerson ? 'per person for the week' : 'total', perDinner != null ? `${money(perDinner)} a dinner` : null, budget].filter(Boolean).join(' · ') }));

    const meals = el('ul', { className: 'meals' },
      ...[...p.meals].sort((a, b) => dayIndex(a.day) - dayIndex(b.day)).map((m) => {
        const r = recipesById.get(m.recipe_id);
        const src = safeUrl(m.image_url || r?.image_url);
        const n = m.nutrition_per_serving || {};
        const facts = [`${money(m.cost_per_serving_usd)}/serving`, n.calories != null && `${Math.round(n.calories)} kcal`, n.protein_g != null && `${Math.round(n.protein_g)} g protein`].filter(Boolean);
        // Who found it: saved with the plan, or (older plans) the recipe's picks now.
        const by = m.picked_by || r?.picked_by || [];
        return el('li', { className: 'meal' },
          src ? el('img', { src, alt: '', loading: 'lazy' }) : el('span', { className: 'ph' }),
          el('div', {},
            el('div', { className: 'day', textContent: typeof m.day === 'number' ? `Day ${m.day}` : m.day }),
            el('div', { className: 'mname', textContent: m.name || r?.name || `Recipe ${m.recipe_id.slice(0, 8)}…` }),
            el('div', { className: 'mfacts', textContent: facts.join(' · ') }),
            by.length ? el('div', { className: 'mby', textContent: `Picked by ${by.length} group${by.length === 1 ? '' : 's'}: ${by.join(', ')}` }) : null,
            m.why ? el('div', { className: 'mwhy', textContent: m.why }) : null));
      }));

    const rules = (p.rule_checks || []).length
      ? el('ul', { className: 'rules' }, ...p.rule_checks.map((c) => el('li', { className: c.passed ? 'pass' : 'fail', title: c.detail || '' },
        `${c.passed ? '✓' : '✗'} ${c.rule}`, !c.passed && c.detail ? el('span', { className: 'rule-detail', textContent: `: ${c.detail}` }) : null)))
      : null;

    const list = p.shopping_list || [];
    const shopping = list.length ? el('details', {},
      el('summary', { textContent: `Shopping list: ${list.length} item${list.length === 1 ? '' : 's'}` }),
      el('div', { className: 'table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {}, el('th', { textContent: 'Item' }), el('th', { textContent: 'Kroger product' }), el('th', { className: 'num', textContent: 'Qty' }), el('th', { className: 'num', textContent: 'Price' }), el('th', { className: 'num', textContent: 'Line' }))),
          el('tbody', {}, ...list.map((s) => el('tr', {},
            el('td', { textContent: s.item }),
            el('td', { textContent: [s.description, s.size].filter(Boolean).join(', ') || '–' }),
            el('td', { className: 'num', textContent: s.quantity }),
            el('td', { className: 'num', textContent: money(s.unit_price_usd) }),
            el('td', { className: 'num', textContent: money(s.quantity * s.unit_price_usd) }))))))) : null;

    return el('article', { className: 'plan', 'data-key': p.id },
      el('div', { className: 'plan-head' }, chip(p.group), total,
        el('span', { className: 'muted small', textContent: [ago(p.created_at), p.store_id && `Kroger store ${p.store_id}`].filter(Boolean).join(' · ') })),
      el('p', { className: 'plan-summary', textContent: p.summary }),
      meals, rules, shopping);
  }

  function renderPlans() {
    const shown = data.plans.filter((p) => !state.group || p.group === state.group);
    const byId = new Map(data.recipes.map((r) => [r.id, r]));
    keepState($('plans'), () => $('plans').replaceChildren(...shown.map((p) => planCard(p, byId))));
    $('shown').textContent = `${shown.length} of ${data.plans.length} meal plans`;
    return [shown.length, data.plans.length ? 'No meal plans from this group yet.' : 'No meal plans yet. They appear here when a Meal Planner saves one.'];
  }

  // ---------------------------------------------------------------- exchanges
  const AGENT_NAME = { scout: 'Recipe Scout', planner: 'Meal Planner', pricer: 'Recipe Pricer' };
  const pretty = (v) => (v == null ? '(nothing)' : JSON.stringify(v, null, 2));

  function exchangeRow(x) {
    const open = openExchanges.has(x.id);
    const what = x.method === 'tools/call' ? x.tool : x.method;
    const ask = x.method === 'tools/list' ? 'What tools do you offer?' : x.request_summary || '';
    const toggle = el('button', { type: 'button', className: 'btn small-btn linklike-btn', textContent: open ? 'Hide' : 'Details', 'aria-expanded': String(open) });
    toggle.addEventListener('click', () => { if (open) openExchanges.delete(x.id); else openExchanges.add(x.id); render(); });
    const who = x.agent === 'pricer'
      ? el('span', { className: 'xch-who' }, el('span', { className: 'agent-pill pricer', textContent: AGENT_NAME.pricer }))
      : el('span', { className: 'xch-who' }, x.agent ? el('span', { className: `agent-pill ${x.agent}`, textContent: AGENT_NAME[x.agent] }) : null, x.group_name ? chip(x.group_name) : null);
    const li = el('li', { className: `xch${x.ok ? '' : ' rejected'}${open ? ' open' : ''}`, 'data-key': String(x.id) },
      el('div', { className: 'xch-head' },
        el('span', { className: 'xch-time', textContent: when(x.at) }),
        who,
        x.ms != null ? el('span', { className: 'xch-ms muted small', textContent: `${x.ms} ms` }) : null,
        toggle),
      el('p', { className: 'xch-req' }, el('span', { className: 'xch-arrow', 'aria-label': 'request', textContent: '→' }),
        x.method === 'pricer' ? el('strong', { textContent: 'Priced' }) : el('code', { textContent: what }), ask ? el('span', { textContent: ` ${ask}` }) : null),
      el('p', { className: 'xch-res' }, el('span', { className: 'xch-arrow', 'aria-label': 'answer', textContent: '←' }),
        el('span', { className: `xch-mark ${x.ok ? 'ok' : 'bad'}`, textContent: x.ok ? '✓' : '✗' }), ` ${x.summary || ''}`));
    if (open) {
      li.append(el('div', { className: 'xch-detail' },
        el('div', {}, el('h3', { textContent: x.method === 'pricer' ? 'Recipe' : 'Sent' }), el('pre', { className: 'code', textContent: pretty(x.request) })),
        el('div', {}, el('h3', { textContent: 'Answer' }), el('pre', { className: 'code', textContent: pretty(x.response) }))));
    }
    return li;
  }

  function renderExchanges() {
    const shown = data.exchanges.filter(
      (x) => (!state.group || x.group_name === state.group) && (!state.agent || x.agent === state.agent)
        && (!state.result || (state.result === 'accepted') === x.ok),
    );
    keepState($('exchanges'), () => $('exchanges').replaceChildren(...shown.map(exchangeRow)));
    const rejected = data.exchanges.filter((x) => !x.ok).length;
    $('shown').textContent = `${shown.length} of the latest ${data.exchanges.length} exchanges · ${rejected} rejected`;
    return [shown.length, data.exchanges.length ? 'Nothing matches these filters.' : 'No exchanges yet. They appear here as soon as an agent talks to the coordinator.'];
  }

  // ---------------------------------------------------------------- render
  function render() {
    for (const v of VIEWS) {
      $(`tab-${v}`).setAttribute('aria-selected', String(v === state.view));
      $(`view-${v}`).hidden = v !== state.view;
    }
    for (const f of document.querySelectorAll('.filters [data-for]')) f.hidden = f.dataset.for !== state.view;
    $('n-recipes').textContent = data.recipes.length || '';
    $('n-plans').textContent = data.plans.length || '';
    $('n-exchanges').textContent = 'live';

    const groups = [...new Set([
      ...data.recipes.flatMap((r) => r.picked_by || [r.group]),
      ...data.plans.map((p) => p.group),
      ...data.exchanges.map((x) => x.group_name),
    ].filter(Boolean))].sort();
    fillSelect($('f-group'), groups, state.group, 'All groups');
    fillSelect($('f-theme'), [...new Set(data.recipes.flatMap((r) => (r.picks?.length ? r.picks.map((p) => p.theme) : [r.theme])))].sort(), state.theme, 'All themes');

    const [count, emptyText] = state.view === 'recipes' ? renderRecipes() : state.view === 'plans' ? renderPlans() : renderExchanges();
    $('empty').hidden = count > 0 || !$('notice').hidden;
    $('empty').textContent = emptyText;
  }

  // ---------------------------------------------------------------- data
  async function showSetupProblems() {
    try {
      const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
      if (h.ok) return false;
      $('notice').replaceChildren(
        el('h2', { textContent: 'The database isn’t set up yet' }),
        el('ul', {}, ...h.problems.map((p) => el('li', { textContent: p }))),
      );
      $('notice').hidden = false;
      return true;
    } catch {
      return false;
    }
  }

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.errors?.[0] || `HTTP ${res.status}`);
    return body;
  }

  async function load() {
    try {
      const [r, p, x] = await Promise.all([
        getJson('/api/recipes?status=all&limit=500'),
        getJson('/api/meal-plans?limit=200'),
        getJson('/api/exchanges?limit=300'),
      ]);
      data.recipes = r.recipes;
      data.plans = p.plans;
      data.exchanges = x.exchanges;
      lastOk = new Date();
      $('notice').hidden = true;
      $('stamp').className = '';
      $('stamp').textContent = `Updated ${lastOk.toLocaleTimeString()}`;
    } catch (e) {
      if (!(await showSetupProblems())) {
        $('stamp').className = 'stale';
        $('stamp').textContent = lastOk
          ? `Couldn’t refresh (${e.message}). Showing ${lastOk.toLocaleTimeString()}.`
          : `Couldn’t load: ${e.message}`;
      }
    }
    render();
  }

  // ---------------------------------------------------------------- wiring
  const tabs = VIEWS.map((v) => $(`tab-${v}`));
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => { state.view = tab.dataset.view; syncUrl(); render(); });
    tab.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const next = tabs[(i + d + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });
  $('f-group').addEventListener('change', (e) => { state.group = e.target.value; syncUrl(); render(); });
  $('f-theme').addEventListener('change', (e) => { state.theme = e.target.value; syncUrl(); render(); });
  $('f-agent').value = AGENT_NAME[state.agent] ? state.agent : '';
  $('f-agent').addEventListener('change', (e) => { state.agent = e.target.value; syncUrl(); render(); });
  $('f-sort').value = SORTS[state.sort] ? state.sort : 'newest';
  $('f-sort').addEventListener('change', (e) => { state.sort = e.target.value; syncUrl(); render(); });
  for (const name of ['status', 'price', 'result']) {
    for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
      radio.checked = radio.value === state[name];
      radio.addEventListener('change', () => { state[name] = radio.value; syncUrl(); render(); });
    }
  }

  // New exchanges, every few seconds while that view is showing.
  async function loadNewExchanges() {
    if (document.hidden || state.view !== 'exchanges' || !lastOk) return;
    try {
      const after = data.exchanges[0]?.id ?? 0;
      const x = await getJson(`/api/exchanges?after=${after}&limit=200`);
      // A full refresh may have brought some of these in already.
      const known = new Set(data.exchanges.map((e) => e.id));
      const fresh = x.exchanges.filter((e) => !known.has(e.id));
      if (!fresh.length) return;
      data.exchanges = [...fresh, ...data.exchanges].slice(0, 300);
      render();
    } catch { /* the full refresh reports problems */ }
  }

  render();
  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  setInterval(loadNewExchanges, LIVE_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
