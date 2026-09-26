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
  // Props with a dash (aria-live, aria-label) are attributes; the rest are properties.
  const el = (tag, { dataset, ...props } = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (k.includes('-')) node.setAttribute(k, v); else node[k] = v;
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
    loadSettings();
    loadNotes();
    loadPrompts();
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
    renderUsage();
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
      $('restore').disabled = false;
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

  // ---------------------------------------------------------------- coordinator limits and checks
  let settings = null;
  const form = $('settings-form');
  const field = (name) => form.elements.namedItem(name);
  function fillSettings(s) {
    settings = s;
    for (const [k, v] of Object.entries(s)) {
      if (k === 'checks') for (const [ck, cv] of Object.entries(v)) setField(`checks.${ck}`, cv);
      else setField(k, v);
    }
    renderUsage();
  }
  function setField(name, value) {
    const el = field(name);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(value); else el.value = String(value);
  }
  function readSettings() {
    const out = { checks: {} };
    for (const el of form.querySelectorAll('input[name]')) {
      const value = el.type === 'checkbox' ? el.checked : Number(el.value);
      if (el.name.startsWith('checks.')) out.checks[el.name.slice(7)] = value; else out[el.name] = value;
    }
    return out;
  }
  async function loadSettings() {
    const r = await api('GET', 'settings');
    if (r.ok) fillSettings(r.body.settings);
  }
  function settingsResult(text, bad = false) {
    $('settings-result').textContent = text;
    $('settings-result').className = `small ${bad ? 'bad' : 'good'}`;
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('POST', 'settings', { body: readSettings() });
    if (!r.ok) return settingsResult(r.errors.join(' '), true);
    fillSettings(r.body.settings);
    settingsResult('Saved. Agents get the new limits and checks from their next call.');
  });
  confirmClick($('settings-reset'), async () => {
    const r = await api('POST', 'settings', { body: { reset: true } });
    if (!r.ok) return settingsResult(r.errors.join(' '), true);
    fillSettings(r.body.settings);
    settingsResult('Back to the defaults.');
  });

  // How much each group has saved, against the limits.
  function renderUsage() {
    const tbody = $('usage');
    if (!tbody) return;
    const usage = new Map();
    const row = (g) => usage.get(g) ?? usage.set(g, { recipes: 0, plans: 0 }).get(g);
    for (const r of data.recipes) for (const p of r.picks?.length ? r.picks : [{ group: r.group }]) row(p.group).recipes += 1;
    for (const p of data.plans) row(p.group).plans += 1;
    const cell = (n, max) => el('td', { className: max > 0 && n >= max ? 'at-limit' : '', textContent: max > 0 ? `${n} of ${max}` : String(n) });
    const groups = [...usage.keys()].sort();
    tbody.replaceChildren(...groups.map((g) => el('tr', {}, el('td', { textContent: g }),
      cell(usage.get(g).recipes, settings?.max_recipes_per_group ?? 0), cell(usage.get(g).plans, settings?.max_plans_per_group ?? 0))));
    if (!groups.length) tbody.append(el('tr', {}, el('td', { colSpan: 3, className: 'muted', textContent: 'No group has saved anything yet.' })));
  }

  // ---------------------------------------------------------------- sample database
  $('sample-word').addEventListener('input', () => { $('load-sample').disabled = $('sample-word').value.trim() !== 'SAMPLE'; });
  $('load-sample').addEventListener('click', async () => {
    $('load-sample').disabled = true;
    const prices = $('sample-prices').checked;
    const res = await api('POST', 'load-sample', { body: { confirm: 'SAMPLE', prices } });
    $('sample-word').value = '';
    if (res.ok) {
      toast(`Loaded the sample database: ${res.body.counts.recipes} recipes, ${prices ? 'with ready-made (estimated) prices' : 'queued for the Pricer Agent'}.`);
    } else {
      toast(res.errors.join('; '), true);
    }
    await load();
  });
  async function describeSample() {
    const r = await api('GET', 'sample');
    if (r.ok) $('sample-what').textContent = `${r.body.recipes} real TheMealDB recipes picked by ${r.body.groups.length} groups (${r.body.groups.join(', ')}), ${r.body.picks - r.body.recipes} of them by two groups`;
  }

  // ---------------------------------------------------------------- class notes (shown on the FAQ page)
  async function loadNotes() {
    try {
      const { notes } = await (await fetch('/api/settings?notes', { cache: 'no-store' })).json();
      $('notes-text').value = notes.text || '';
      $('notes-updated').textContent = notes.updated_at && notes.text ? `· published ${when(notes.updated_at)}` : '· none published';
    } catch { /* shown as empty */ }
  }
  async function publishNotes(text) {
    const r = await api('POST', 'notes', { body: { text } });
    $('notes-result').textContent = r.ok ? (text ? 'Published: students see it on the FAQ page within half a minute.' : 'Removed.') : r.errors.join(' ');
    $('notes-result').className = `small ${r.ok ? 'good' : 'bad'}`;
    if (r.ok) loadNotes();
  }
  $('notes-form').addEventListener('submit', (e) => { e.preventDefault(); publishNotes($('notes-text').value); });
  confirmClick($('notes-clear'), () => { $('notes-text').value = ''; return publishNotes(''); });

  // ---------------------------------------------------------------- every prompt, in one place
  // Students' steps default to their text files; the site agents' to the code.
  // Edits are stored in the database and replace the default for everyone.
  const PROMPTS = [
    { group: 'Recipe Scout (students’ sample prompts)', items: [
      ['scout', 10, 'Step 0 · Build your first page', '/prompts/scout/step-0.txt'],
      ['scout', 11, 'Step 1 · Connect to real recipe information', '/prompts/scout/step-1.txt'],
      ['scout', 12, 'Step 2 · Add the Recipe Scout agent', '/prompts/scout/step-2.txt'],
      ['scout', 13, 'Step 3a · Connect to the coordinator', '/prompts/scout/step-3a.txt'],
      ['scout', 14, 'Step 3b · Let the Scout Agent use the coordinator', '/prompts/scout/step-3b.txt'],
    ] },
    { group: 'Meal Planner (students’ sample prompts)', items: [
      ['planner', 10, 'Step 1 · Build the interface', '/prompts/planner/step-1.txt'],
      ['planner', 11, 'Step 2 · Connect to the coordinator', '/prompts/planner/step-2.txt'],
      ['planner', 12, 'Step 3 · Add the Planner Agent', '/prompts/planner/step-3.txt'],
    ] },
    { group: 'Agents that run on the site (their instructions)', items: [
      ['pricer', 1, 'Recipe Pricer', null],
      ['shopper', 1, 'Shopper Agent', null],
      ['backup_scout', 1, 'Backup Scout Agent', null],
      ['backup_planner', 1, 'Backup Planner Agent', null],
    ] },
  ];

  async function promptState(agent, step, file) {
    if (agent === 'pricer') {
      const b = await (await fetch('/api/pricer', { cache: 'no-store' })).json();
      return { text: b.prompt, fallback: b.default_prompt, edited: !b.prompt_is_default, updated: null };
    }
    const b = await (await fetch(`/api/prompts?agent=${agent}`, { cache: 'no-store' })).json();
    const fallback = file ? (await (await fetch(file, { cache: 'no-cache' })).text()).trim() : b.defaults?.[step] ?? '';
    const edit = b.steps?.[step];
    return { text: edit ?? fallback, fallback, edited: edit != null, updated: b.updated_at?.[step] ?? null };
  }

  async function savePrompt(agent, step, text) {
    const reset = text == null;
    const res = agent === 'pricer'
      ? await fetch('/api/pricer?action=prompt', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(reset ? { reset: true } : { prompt: text }) })
      : await fetch('/api/prompts', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(reset ? { agent, step, reset: true } : { agent, step, text }) });
    const out = await res.json().catch(() => ({}));
    return { ok: res.ok, errors: out.errors || (res.ok ? [] : [`HTTP ${res.status}`]) };
  }

  function promptEditor([agent, step, label, file]) {
    const status = el('span', { className: 'small muted' });
    const area = el('textarea', { rows: 16, spellcheck: true, className: 'prompt-edit' });
    area.setAttribute('aria-label', `${label} prompt`);
    const msg = el('span', { className: 'small', 'aria-live': 'polite' });
    const save = el('button', { type: 'button', className: 'btn primary', textContent: 'Save' });
    const reset = el('button', { type: 'button', className: 'btn', textContent: 'Back to the default', dataset: { confirm: 'Click again to go back to the default' } });
    const badge = el('span', { className: 'pill' });
    const item = el('details', { className: 'prompt-item' },
      el('summary', {}, el('strong', { textContent: label }), ' ', badge),
      el('div', { className: 'prompt-item-body' }, area, el('div', { className: 'row-actions' }, save, reset, msg, status)));
    let loaded = false;
    const refresh = async () => {
      const st = await promptState(agent, step, file);
      area.value = st.text;
      badge.textContent = st.edited ? 'Edited' : 'Default';
      badge.className = `pill ${st.edited ? 'prompt-edited' : 'prompt-default'}`;
      status.textContent = st.edited && st.updated ? `Saved ${when(st.updated)}` : '';
      reset.hidden = !st.edited;
      loaded = true;
    };
    item.addEventListener('toggle', () => { if (item.open && !loaded) refresh().catch((e) => { msg.textContent = `Couldn’t load: ${e.message}`; }); });
    save.addEventListener('click', async () => {
      msg.textContent = 'Saving…';
      const r = await savePrompt(agent, step, area.value);
      msg.textContent = r.ok ? 'Saved: everyone gets this version now.' : r.errors.join(' ');
      msg.className = `small ${r.ok ? 'good' : 'bad'}`;
      if (r.ok) await refresh();
    });
    confirmClick(reset, async () => {
      const r = await savePrompt(agent, step, null);
      msg.textContent = r.ok ? 'Back to the default.' : r.errors.join(' ');
      msg.className = `small ${r.ok ? 'good' : 'bad'}`;
      if (r.ok) await refresh();
    });
    // The badge is known without opening: load it in the background.
    refresh().catch(() => { badge.textContent = ''; });
    return item;
  }

  function loadPrompts() {
    $('prompt-editors').replaceChildren(...PROMPTS.map((g) => el('div', { className: 'prompt-group' },
      el('h4', { textContent: g.group }), ...g.items.map(promptEditor))));
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
