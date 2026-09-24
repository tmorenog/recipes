// Database page: recipes, meal plans and activity, filtered in the browser and
// refreshed every 15 seconds. The view and filters are kept in the address.
(() => {
  'use strict';

  const REFRESH_MS = 15000;
  const $ = (id) => document.getElementById(id);
  const VIEWS = ['recipes', 'plans', 'activity'];

  const params = new URLSearchParams(location.search);
  const state = {
    view: VIEWS.includes(params.get('view')) ? params.get('view') : 'recipes',
    group: params.get('group') || '',
    theme: params.get('theme') || '',
    status: params.get('status') || '',
    result: params.get('result') || '',
  };
  const data = { recipes: [], plans: [], activity: [] };
  let lastOk = null;

  // ---------------------------------------------------------------- helpers
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null && c !== false));
    return node;
  };
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
    if (state.view !== 'recipes') p.set('view', state.view);
    for (const k of ['group', 'theme', 'status', 'result']) if (state[k]) p.set(k, state[k]);
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
  }

  function fillSelect(select, values, current, allLabel) {
    const options = [['', allLabel], ...values.map((v) => [v, v])];
    if (current && !values.includes(current)) options.push([current, current]);
    select.replaceChildren(...options.map(([value, label]) => new Option(label, value, false, value === current)));
  }

  // ---------------------------------------------------------------- recipes
  function recipeCard(r) {
    const node = $('recipe-card').content.firstElementChild.cloneNode(true);
    node.dataset.id = r.id;
    node.classList.toggle('is-processed', r.status === 'processed');
    const photo = node.querySelector('.photo');
    const img = photo.querySelector('img');
    const src = safeUrl(r.image_url);
    if (src) {
      img.src = src;
      img.alt = r.name;
      img.addEventListener('error', () => { img.remove(); photo.classList.add('noimg'); }, { once: true });
    } else {
      img.remove();
      photo.classList.add('noimg');
    }
    const pill = node.querySelector('.pill');
    pill.textContent = r.status === 'new' ? 'New' : 'Processed';
    pill.classList.add(r.status);
    node.querySelector('.chip').replaceWith(chip(r.group));
    node.querySelector('.theme').textContent = r.theme;
    const link = node.querySelector('.name a');
    link.textContent = r.name;
    // TheMealDB asks apps to link each meal to its page there.
    if (/^\d+$/.test(r.meal_id)) link.href = `https://www.themealdb.com/meal/${r.meal_id}`;
    else if (safeUrl(r.source_url)) link.href = r.source_url;
    node.querySelector('.meta').textContent = [r.cuisine, r.category, r.est_minutes && `${r.est_minutes} min`, r.est_servings && `serves ${r.est_servings}`]
      .filter(Boolean).join(' · ');
    node.querySelector('.why').textContent = r.why_chosen;
    // What the Pricer agent found: cost per serving and calories, or where it's up to.
    const p = r.pricing || { status: 'pending' };
    const price = node.querySelector('.price');
    price.href = `/pricer#${encodeURIComponent(r.meal_id)}`;
    price.className = `price price-${p.status}`;
    price.textContent = p.status === 'priced'
      ? `$${p.cost_per_serving_usd.toFixed(2)} a serving · ${Math.round(p.nutrition_per_serving.calories ?? 0)} kcal`
      : { pending: 'Waiting to be priced', pricing: 'Being priced…', failed: 'Couldn’t be priced' }[p.status] || p.status;
    const ings = r.ingredients || [];
    node.querySelector('.ingredients summary').textContent = `${ings.length} ingredient${ings.length === 1 ? '' : 's'}`;
    node.querySelector('.ingredients ul').replaceChildren(
      ...ings.map((i) => el('li', { textContent: i.raw && !i.raw.toLowerCase().includes(i.name.toLowerCase()) ? `${i.name}: ${i.raw}` : i.raw || i.name })),
    );
    const note = node.querySelector('.processed-note');
    if (r.status === 'processed') note.textContent = `Processed by ${r.processed_by || 'unknown'} ${r.processed_at ? ago(r.processed_at) : ''}`;
    else note.remove();
    return node;
  }

  function renderRecipes() {
    const shown = data.recipes.filter(
      (r) => (!state.group || r.group === state.group) && (!state.theme || r.theme === state.theme) && (!state.status || r.status === state.status),
    );
    const open = new Set([...$('recipes').querySelectorAll('details[open]')].map((d) => d.closest('.card').dataset.id));
    $('recipes').replaceChildren(
      ...shown.map((r) => {
        const node = recipeCard(r);
        if (open.has(r.id)) node.querySelector('details').open = true;
        return node;
      }),
    );
    const fresh = data.recipes.filter((r) => r.status === 'new').length;
    $('shown').textContent = `${shown.length} of ${data.recipes.length} recipes · ${fresh} new`;
    return [shown.length, data.recipes.length ? 'No recipes match these filters.' : 'No recipes yet. They appear here as soon as a Scout saves one.'];
  }

  // ---------------------------------------------------------------- plans
  function planCard(p, recipesById) {
    const over = p.budget_usd != null && p.total_cost_usd > p.budget_usd;
    const total = el('span', { className: `plan-total${over ? ' over' : ''}` }, money(p.total_cost_usd),
      el('small', { textContent: p.budget_usd != null ? `of ${money(p.budget_usd)} budget${over ? ', over' : ''}` : 'total' }));

    const meals = el('ul', { className: 'meals' },
      ...[...p.meals].sort((a, b) => a.day - b.day).map((m) => {
        const r = recipesById.get(m.recipe_id);
        const src = safeUrl(r?.image_url);
        const n = m.nutrition_per_serving || {};
        return el('li', { className: 'meal' },
          src ? el('img', { src, alt: '', loading: 'lazy' }) : el('span', { className: 'ph' }),
          el('div', {},
            el('div', { className: 'day', textContent: `Day ${m.day}` }),
            el('div', { className: 'mname', textContent: r ? r.name : `Recipe ${m.recipe_id.slice(0, 8)}…` }),
            el('div', { className: 'mfacts', textContent: `${money(m.cost_per_serving_usd)}/serving · ${Math.round(n.calories ?? 0)} kcal · ${Math.round(n.protein_g ?? 0)} g protein` })));
      }));

    const rules = (p.rule_checks || []).length
      ? el('ul', { className: 'rules' }, ...p.rule_checks.map((c) => el('li', { className: c.passed ? 'pass' : 'fail', textContent: `${c.passed ? '✓' : '✗'} ${c.rule}`, title: c.detail || '' })))
      : null;

    const list = p.shopping_list || [];
    const shopping = el('details', {},
      el('summary', { textContent: `Shopping list: ${list.length} item${list.length === 1 ? '' : 's'}` }),
      el('div', { className: 'table-wrap' },
        el('table', {},
          el('thead', {}, el('tr', {}, el('th', { textContent: 'Item' }), el('th', { textContent: 'Kroger product' }), el('th', { className: 'num', textContent: 'Qty' }), el('th', { className: 'num', textContent: 'Price' }), el('th', { className: 'num', textContent: 'Line' }))),
          el('tbody', {}, ...list.map((s) => el('tr', {},
            el('td', { textContent: s.item }),
            el('td', { textContent: [s.description, s.size].filter(Boolean).join(', ') || '–' }),
            el('td', { className: 'num', textContent: s.quantity }),
            el('td', { className: 'num', textContent: money(s.unit_price_usd) }),
            el('td', { className: 'num', textContent: money(s.quantity * s.unit_price_usd) })))))));

    return el('article', { className: 'plan' },
      el('div', { className: 'plan-head' }, chip(p.group), total,
        el('span', { className: 'muted small', textContent: [ago(p.created_at), p.store_id && `Kroger store ${p.store_id}`].filter(Boolean).join(' · ') })),
      el('p', { className: 'plan-summary', textContent: p.summary }),
      meals, rules, shopping);
  }

  function renderPlans() {
    const shown = data.plans.filter((p) => !state.group || p.group === state.group);
    const byId = new Map(data.recipes.map((r) => [r.id, r]));
    $('plans').replaceChildren(...shown.map((p) => planCard(p, byId)));
    $('shown').textContent = `${shown.length} of ${data.plans.length} meal plans`;
    return [shown.length, data.plans.length ? 'No meal plans from this group yet.' : 'No meal plans yet. They appear here when a Meal Planner saves one.'];
  }

  // ---------------------------------------------------------------- activity
  const ACTIONS = { save_recipe: 'Save recipe', mark_processed: 'Mark processed', save_meal_plan: 'Save meal plan' };

  function renderActivity() {
    const shown = data.activity.filter(
      (a) => (!state.group || a.group === state.group) && (!state.result || (state.result === 'accepted') === a.ok),
    );
    $('activity').replaceChildren(...shown.map((a) => {
      const details = el('td', {});
      if (!a.ok && a.detail) details.append(el('ul', { className: 'reasons' }, ...a.detail.split('; ').map((d) => el('li', { textContent: d }))));
      else if (a.input?.name) details.append(a.input.name);
      else if (a.input?.recipe_id) details.append(`Recipe ${String(a.input.recipe_id).slice(0, 8)}…`);
      else if (a.action === 'save_meal_plan' && a.ok) details.append('Plan saved');
      if (a.input) {
        details.append(el('details', {}, el('summary', { textContent: 'What was sent' }), el('pre', { textContent: JSON.stringify(a.input, null, 2) })));
      }
      return el('tr', {},
        el('td', { className: 'when', textContent: when(a.at) }),
        el('td', {}, chip(a.group || 'unknown')),
        el('td', { textContent: `${ACTIONS[a.action] || a.action} · ${a.channel === 'mcp' ? 'MCP' : 'REST'}` }),
        el('td', {}, el('span', { className: `pill ${a.ok ? 'accepted' : 'rejected'}`, textContent: a.ok ? 'Accepted' : 'Rejected' })),
        details);
    }));
    const rejected = data.activity.filter((a) => !a.ok).length;
    $('shown').textContent = `${shown.length} of ${data.activity.length} latest attempts · ${rejected} rejected`;
    return [shown.length, data.activity.length ? 'Nothing matches these filters.' : 'No activity yet.'];
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
    $('n-activity').textContent = data.activity.length || '';

    const groups = [...new Set([...data.recipes, ...data.plans, ...data.activity].map((x) => x.group).filter(Boolean))].sort();
    fillSelect($('f-group'), groups, state.group, 'All groups');
    fillSelect($('f-theme'), [...new Set(data.recipes.map((r) => r.theme))].sort(), state.theme, 'All themes');

    const [count, emptyText] = state.view === 'recipes' ? renderRecipes() : state.view === 'plans' ? renderPlans() : renderActivity();
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
      const [r, p, a] = await Promise.all([
        getJson('/api/recipes?status=all&limit=500'),
        getJson('/api/meal-plans?limit=200'),
        getJson('/api/activity?limit=300'),
      ]);
      data.recipes = r.recipes;
      data.plans = p.plans;
      data.activity = a.activity;
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
  for (const name of ['status', 'result']) {
    for (const radio of document.querySelectorAll(`input[name="${name}"]`)) {
      radio.checked = radio.value === state[name];
      radio.addEventListener('change', () => { state[name] = radio.value; syncUrl(); render(); });
    }
  }

  render();
  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
