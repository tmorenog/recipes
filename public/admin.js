// Admin page: sign in with ADMIN_KEY, then edit, delete, back up, restore, reset.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORE = 'rc-admin-key';
  let key = '';
  try { key = sessionStorage.getItem(STORE) || ''; } catch { /* storage unavailable */ }

  const data = { recipes: [], plans: [], activity: [] };
  let backupFile = null;
  let editing = null; // id of the recipe being edited

  // ---------------------------------------------------------------- helpers
  const el = (tag, { dataset, ...props } = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    if (dataset) Object.assign(node.dataset, dataset);
    node.append(...children.filter((c) => c != null && c !== false));
    return node;
  };
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const money = (n) => (n == null ? '–' : `$${Number(n).toFixed(2)}`);
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

  async function api(method, action, { id, body } = {}) {
    const res = await fetch(`/api/admin/${action}${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) signOut('Your admin key was rejected. Sign in again.');
    return { ok: res.ok, status: res.status, body: out, errors: out.errors || (res.ok ? [] : [`HTTP ${res.status}`]) };
  }

  let toastTimer;
  function toast(text, bad = false) {
    const t = $('toast');
    t.textContent = text;
    t.className = `toast${bad ? ' bad' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  // Buttons with data-confirm need a second click within 4 seconds.
  function confirmClick(btn, action) {
    const label = btn.textContent;
    let armed = false;
    let timer;
    btn.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        btn.textContent = btn.dataset.confirm || 'Click again to confirm';
        btn.classList.add('armed');
        timer = setTimeout(() => { armed = false; btn.textContent = label; btn.classList.remove('armed'); }, 4000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      btn.textContent = label;
      btn.classList.remove('armed');
      btn.disabled = true;
      try { await action(); } finally { btn.disabled = false; }
    });
  }

  // ---------------------------------------------------------------- sign in
  function signOut(message = '') {
    key = '';
    try { sessionStorage.removeItem(STORE); } catch { /* ignore */ }
    $('admin').hidden = true;
    $('signin').hidden = false;
    $('signin-result').textContent = message;
    $('signin-result').className = `keycheck-result${message ? ' bad' : ''}`;
  }

  async function signIn(candidate) {
    key = candidate;
    const res = await api('GET', 'check');
    if (!res.ok) {
      signOut(res.errors[0]);
      return;
    }
    try { sessionStorage.setItem(STORE, key); } catch { /* ignore */ }
    $('signin').hidden = true;
    $('admin').hidden = false;
    describeSample();
    await load();
  }

  $('signin-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('admin-key').value.trim();
    $('admin-key').value = '';
    if (value) signIn(value);
  });
  $('signout').addEventListener('click', () => signOut());

  // ---------------------------------------------------------------- data
  async function load() {
    const get = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.json());
    try {
      const [r, p, a] = await Promise.all([get('/api/recipes?status=all&limit=500'), get('/api/meal-plans?limit=200'), get('/api/activity?limit=500')]);
      data.recipes = r.recipes || [];
      data.plans = p.plans || [];
      data.activity = a.activity || [];
      if (r.errors) toast(r.errors[0], true);
    } catch {
      toast('Couldn’t load the data. Check the database on the Coordinator page.', true);
    }
    render();
  }

  // ---------------------------------------------------------------- recipes
  const EDITABLE = ['name', 'theme', 'group', 'status', 'meal_id', 'category', 'cuisine', 'est_minutes', 'est_servings', 'image_url', 'source_url', 'why_chosen', 'instructions', 'ingredients'];

  function editor(r) {
    const fields = Object.fromEntries(EDITABLE.map((k) => [k, r[k] ?? null]));
    const area = el('textarea', { className: 'json-edit', rows: 16, spellcheck: false, value: JSON.stringify(fields, null, 2) });
    const errors = el('ul', { className: 'errors' });
    const save = el('button', { className: 'btn primary', type: 'button', textContent: 'Save changes' });
    const cancel = el('button', { className: 'btn', type: 'button', textContent: 'Cancel' });
    cancel.addEventListener('click', () => { editing = null; render(); });
    save.addEventListener('click', async () => {
      let edited;
      try { edited = JSON.parse(area.value); } catch (e) { errors.replaceChildren(el('li', { textContent: `Not valid JSON: ${e.message}` })); return; }
      // Send only what changed; empty strings for optional fields become null.
      const changes = {};
      for (const [k, v] of Object.entries(edited)) {
        if (JSON.stringify(v) !== JSON.stringify(fields[k])) changes[k] = v;
      }
      if (!Object.keys(changes).length) { editing = null; render(); return; }
      save.disabled = true;
      const res = await api('POST', 'recipe', { id: r.id, body: changes });
      save.disabled = false;
      if (!res.ok) { errors.replaceChildren(...res.errors.map((t) => el('li', { textContent: t }))); return; }
      editing = null;
      toast(`Saved “${res.body.recipe.name}”.`);
      await load();
    });
    return el('tr', { className: 'edit-row' }, el('td', { colSpan: 6 },
      el('p', { className: 'small muted', textContent: 'Edit the fields below, then save. The same rules as saving a recipe apply. Setting status to "new" makes it available to Meal Planners again.' }),
      area, errors, el('div', { className: 'row-actions' }, save, cancel)));
  }

  function recipeRow(r) {
    const edit = el('button', { className: 'btn small-btn', type: 'button', textContent: 'Edit' });
    edit.addEventListener('click', () => { editing = r.id; render(); });
    const flip = el('button', { className: 'btn small-btn', type: 'button', textContent: r.status === 'new' ? 'Mark processed' : 'Set back to new' });
    flip.addEventListener('click', async () => {
      flip.disabled = true;
      const res = await api('POST', 'recipe', { id: r.id, body: { status: r.status === 'new' ? 'processed' : 'new' } });
      if (!res.ok) toast(res.errors.join('; '), true);
      await load();
    });
    const del = el('button', { className: 'btn small-btn danger', type: 'button', textContent: 'Delete', dataset: { confirm: 'Confirm delete' } });
    confirmClick(del, async () => {
      const res = await api('POST', 'delete-recipe', { id: r.id });
      if (res.ok) toast(`Deleted “${r.name}”.`); else toast(res.errors.join('; '), true);
      await load();
    });
    const src = safeUrl(r.image_url);
    const groups = r.picked_by?.length ? r.picked_by : [r.group];
    const themes = [...new Set((r.picks?.length ? r.picks : [{ theme: r.theme }]).map((p) => p.theme))];
    return el('tr', {},
      el('td', {}, el('div', { className: 'admin-recipe' },
        src ? el('img', { src: /themealdb\.com\/images\/media\/meals\/[^/]+\.(jpg|png)$/i.test(src) ? `${src}/small` : src, alt: '', loading: 'lazy' }) : el('span', { className: 'thumb-blank' }),
        el('div', {}, el('strong', { textContent: r.name }), el('div', { className: 'small muted', textContent: [r.cuisine, r.category, `meal ${r.meal_id}`].filter(Boolean).join(' · ') }),
          el('div', { className: 'small muted mono', textContent: r.id })))),
      el('td', {}, el('div', { className: 'small', textContent: groups.join(', ') }), el('div', { className: 'small muted', textContent: themes.join(' · ') })),
      el('td', {}, priceText(r)),
      el('td', {}, el('span', { className: `pill ${r.status}`, textContent: r.status === 'new' ? 'New' : `Processed${r.processed_by ? ` by ${r.processed_by}` : ''}` })),
      el('td', { className: 'nowrap', textContent: when(r.created_at) }),
      el('td', {}, el('div', { className: 'row-actions' }, edit, flip, del)));
  }

  const PRICE_TEXT = { unpriced: 'Not priced', pending: 'Waiting', pricing: 'Being priced', failed: 'Couldn’t price' };
  function priceText(r) {
    const p = r.pricing || { status: 'pending' };
    if (p.status !== 'priced') return el('span', { className: `pill price-${p.status}`, textContent: PRICE_TEXT[p.status] || p.status });
    return el('div', {}, el('strong', { textContent: `${money(p.cost_per_serving_usd)}` }), el('span', { className: 'small', textContent: ' a serving' }),
      el('div', { className: 'small muted', textContent: `cart ${money(p.cart_usd)} for ${p.people}` }),
      p.estimated ? el('span', { className: 'pill estimated', style: 'margin-left:0', textContent: 'Includes estimates', title: `${p.estimated_lines} line${p.estimated_lines === 1 ? '' : 's'} estimated, not Kroger prices` }) : null);
  }

  function renderRecipes() {
    const group = $('f-group').value;
    const q = $('f-search').value.trim().toLowerCase();
    const price = $('f-price').value;
    const priced = (r) => r.pricing?.status === 'priced';
    const groups = [...new Set(data.recipes.flatMap((r) => r.picked_by?.length ? r.picked_by : [r.group]))].sort();
    const current = group;
    $('f-group').replaceChildren(new Option('All groups', ''), ...groups.map((g) => new Option(g, g, false, g === current)));
    const shown = data.recipes.filter((r) => (!group || (r.picked_by?.length ? r.picked_by : [r.group]).includes(group))
      && (!q || `${r.name} ${(r.picks || []).map((p) => p.theme).join(' ')} ${r.theme}`.toLowerCase().includes(q))
      && (!price || (price === 'priced' ? priced(r) : price === 'estimated' ? priced(r) && r.pricing.estimated : !priced(r))));
    $('n-recipes').textContent = `${shown.length} of ${data.recipes.length}`;
    $('recipes').replaceChildren(...shown.flatMap((r) => (editing === r.id ? [recipeRow(r), editor(r)] : [recipeRow(r)])));
    if (!shown.length) $('recipes').append(el('tr', {}, el('td', { colSpan: 6, className: 'muted', textContent: data.recipes.length ? 'No recipes match.' : 'No recipes yet.' })));
  }

  // ---------------------------------------------------------------- plans
  function renderPlans() {
    $('n-plans').textContent = String(data.plans.length);
    $('plans').replaceChildren(...data.plans.map((p) => {
      const del = el('button', { className: 'btn small-btn danger', type: 'button', textContent: 'Delete', dataset: { confirm: 'Confirm delete' } });
      confirmClick(del, async () => {
        const res = await api('POST', 'delete-plan', { id: p.id });
        if (res.ok) toast(`Deleted ${p.group}’s meal plan.`); else toast(res.errors.join('; '), true);
        await load();
      });
      return el('tr', {},
        el('td', { textContent: p.group }),
        el('td', { className: 'nowrap', textContent: when(p.created_at) }),
        el('td', { className: 'nowrap', textContent: money(p.total_cost_usd) }),
        el('td', { className: 'small', textContent: p.summary.length > 140 ? `${p.summary.slice(0, 140)}…` : p.summary }),
        el('td', {}, del));
    }));
    if (!data.plans.length) $('plans').append(el('tr', {}, el('td', { colSpan: 5, className: 'muted', textContent: 'No meal plans yet.' })));
  }

  function render() {
    renderRecipes();
    renderPlans();
    $('n-activity').textContent = `${data.activity.length}${data.activity.length === 500 ? '+' : ''} entries`;
  }

  $('f-group').addEventListener('change', renderRecipes);
  $('f-search').addEventListener('input', renderRecipes);
  $('f-price').addEventListener('change', renderRecipes);

  // ---------------------------------------------------------------- backup
  $('backup').addEventListener('click', async () => {
    const btn = $('backup');
    btn.disabled = true;
    try {
      const res = await fetch('/api/admin/backup', { headers: { authorization: `Bearer ${key}` }, cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errors?.[0] || `HTTP ${res.status}`);
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'recipes-backup.json';
      const a = el('a', { href: URL.createObjectURL(blob), download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast(`Downloaded ${name}.`);
    } catch (e) {
      toast(`Backup failed: ${e.message}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------------------------------------------------------- restore
  $('restore-file').addEventListener('change', async (e) => {
    backupFile = null;
    $('restore-errors').replaceChildren();
    $('restore-confirm').hidden = true;
    const file = e.target.files[0];
    if (!file) { $('restore-summary').textContent = ''; return; }
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.format !== 'recipe-coordinator-backup') throw new Error('this isn’t a Meal Squad backup file');
      backupFile = parsed;
      const c = { recipes: parsed.recipes?.length ?? 0, plans: parsed.plans?.length ?? 0, activity: parsed.activity?.length ?? 0 };
      $('restore-summary').textContent = `Backup from ${parsed.exported_at ? when(parsed.exported_at) : 'an unknown date'}: ${c.recipes} recipes, ${c.plans} meal plans, ${c.activity} activity entries. The database now has ${data.recipes.length} recipes and ${data.plans.length} meal plans.`;
      $('restore-confirm').hidden = false;
    } catch (err) {
      $('restore-summary').textContent = `Can’t use this file: ${err.message}.`;
    }
  });
  $('restore-word').addEventListener('input', () => { $('restore').disabled = !(backupFile && $('restore-word').value.trim() === 'RESTORE'); });
  $('restore').addEventListener('click', async () => {
    $('restore').disabled = true;
    const res = await api('POST', 'restore', { body: backupFile });
    if (!res.ok) {
      $('restore-errors').replaceChildren(el('li', { textContent: 'Nothing was changed. Problems in the file:' }), ...res.errors.map((t) => el('li', { textContent: t })));
      return;
    }
    const c = res.body.counts;
    toast(`Restored ${c.recipes} recipes, ${c.plans} meal plans and ${c.activity} activity entries.`);
    $('restore-word').value = '';
    $('restore-file').value = '';
    $('restore-summary').textContent = '';
    $('restore-confirm').hidden = true;
    backupFile = null;
    await load();
  });

  // ---------------------------------------------------------------- clear, reset
  confirmClick($('clear-exchanges'), async () => {
    const res = await api('POST', 'clear-exchanges');
    if (res.ok) toast('Exchange log cleared.'); else toast(res.errors.join('; '), true);
  });
  confirmClick($('clear-activity'), async () => {
    const res = await api('POST', 'clear-activity');
    if (res.ok) toast('Activity log cleared.'); else toast(res.errors.join('; '), true);
    await load();
  });
  $('reset-word').addEventListener('input', () => { $('reset').disabled = $('reset-word').value.trim() !== 'RESET'; });
  $('reset').addEventListener('click', async () => {
    $('reset').disabled = true;
    const res = await api('POST', 'reset', { body: { confirm: 'RESET' } });
    $('reset-word').value = '';
    if (res.ok) toast('Everything was deleted. The database is empty.'); else toast(res.errors.join('; '), true);
    await load();
  });

  // ---------------------------------------------------------------- sample database
  $('sample-word').addEventListener('input', () => { $('load-sample').disabled = $('sample-word').value.trim() !== 'SAMPLE'; });
  $('load-sample').addEventListener('click', async () => {
    $('load-sample').disabled = true;
    const prices = $('sample-prices').checked;
    const res = await api('POST', 'load-sample', { body: { confirm: 'SAMPLE', prices } });
    $('sample-word').value = '';
    if (res.ok) {
      toast(`Loaded the sample database: ${res.body.counts.recipes} recipes, ${prices ? 'with ready-made (estimated) prices' : 'queued for the Pricer'}.`);
    } else {
      toast(res.errors.join('; '), true);
    }
    await load();
  });
  async function describeSample() {
    const r = await api('GET', 'sample');
    if (r.ok) $('sample-what').textContent = `${r.body.recipes} real TheMealDB recipes picked by ${r.body.groups.length} groups (${r.body.groups.join(', ')}), ${r.body.picks - r.body.recipes} of them by two groups`;
  }

  if (key) signIn(key);
  // ---------------------------------------------------------------- Kroger
  $('kroger-check').addEventListener('click', async () => {
    const out = $('kroger-result');
    out.textContent = 'Checking…';
    out.className = 'small';
    const r = await api('GET', 'kroger-check');
    if (!r.ok) { out.textContent = r.errors.join(' '); out.className = 'small bad'; return; }
    const b = r.body;
    out.textContent = b.ok
      ? `Works: signed in to ${new URL(b.server).host} and found ${b.stores_found} store${b.stores_found === 1 ? '' : 's'} near 45202.`
      : b.errors.join(' ');
    out.className = `small ${b.ok ? 'good' : 'bad'}`;
  });
})();
