// Recipe Board: loads every recipe once, filters in the browser, refreshes
// every 15 seconds. Filters are kept in the address so a view can be shared.
(() => {
  'use strict';

  const REFRESH_MS = 15000;
  const $ = (id) => document.getElementById(id);
  const els = {
    theme: $('f-theme'), group: $('f-group'), grid: $('grid'), empty: $('empty'),
    notice: $('notice'), count: $('count'), stamp: $('stamp'), tpl: $('card'),
  };

  let recipes = [];
  let lastOk = null;

  const params = new URLSearchParams(location.search);
  const filters = { theme: params.get('theme') || '', group: params.get('group') || '', status: params.get('status') || '' };

  // ---------------------------------------------------------------- helpers
  const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
  const ago = (iso) => {
    const s = Math.round((Date.now() - new Date(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };

  function syncUrl() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
  }

  function fillSelect(select, values, current, allLabel) {
    const options = [['', allLabel], ...values.map((v) => [v, v])];
    if (current && !values.includes(current)) options.push([current, current]);
    select.replaceChildren(...options.map(([value, label]) => new Option(label, value, false, value === current)));
  }

  // ---------------------------------------------------------------- render
  function card(r) {
    const node = els.tpl.content.firstElementChild.cloneNode(true);
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

    const chip = node.querySelector('.chip');
    chip.textContent = r.group;
    chip.style.setProperty('--h', hue(r.group));
    node.querySelector('.theme').textContent = r.theme;

    const link = node.querySelector('.name a');
    link.textContent = r.name;
    const source = safeUrl(r.source_url);
    if (source) link.href = source;

    const meta = [r.cuisine, r.category, r.est_minutes && `${r.est_minutes} min`, r.est_servings && `serves ${r.est_servings}`]
      .filter(Boolean);
    node.querySelector('.meta').textContent = meta.join(' · ');
    node.querySelector('.why').textContent = r.why_chosen;

    const ings = r.ingredients || [];
    node.querySelector('.ingredients summary').textContent = `${ings.length} ingredient${ings.length === 1 ? '' : 's'}`;
    node.querySelector('.ingredients ul').replaceChildren(
      ...ings.map((i) => {
        const li = document.createElement('li');
        li.textContent = i.raw && !i.raw.toLowerCase().includes(i.name.toLowerCase()) ? `${i.name}: ${i.raw}` : i.raw || i.name;
        return li;
      }),
    );

    const processed = node.querySelector('.processed-note');
    if (r.status === 'processed') processed.textContent = `Processed by ${r.processed_by || 'unknown'} ${r.processed_at ? ago(r.processed_at) : ''}`;
    else processed.remove();
    return node;
  }

  function render() {
    const themes = [...new Set(recipes.map((r) => r.theme))].sort((a, b) => a.localeCompare(b));
    const groups = [...new Set(recipes.map((r) => r.group))].sort((a, b) => a.localeCompare(b));
    fillSelect(els.theme, themes, filters.theme, 'All themes');
    fillSelect(els.group, groups, filters.group, 'All groups');

    const shown = recipes.filter(
      (r) =>
        (!filters.theme || r.theme === filters.theme) &&
        (!filters.group || r.group === filters.group) &&
        (!filters.status || r.status === filters.status),
    );
    const open = new Set([...els.grid.querySelectorAll('details[open]')].map((d) => d.closest('.card').dataset.id));
    els.grid.replaceChildren(
      ...shown.map((r) => {
        const node = card(r);
        node.dataset.id = r.id;
        if (open.has(r.id)) node.querySelector('details').open = true;
        return node;
      }),
    );

    const fresh = recipes.filter((r) => r.status === 'new').length;
    els.count.textContent = `${shown.length} of ${recipes.length} shown · ${fresh} new`;
    els.empty.hidden = shown.length > 0 || !els.notice.hidden;
    els.empty.textContent = recipes.length
      ? 'No recipes match these filters.'
      : 'No recipes yet. They appear here as soon as an agent saves one.';
  }

  // ---------------------------------------------------------------- data
  async function showSetupProblems() {
    try {
      const h = await (await fetch('/api/health', { cache: 'no-store' })).json();
      if (h.ok) return false;
      const title = document.createElement('h2');
      title.textContent = 'This board isn’t set up yet';
      const list = document.createElement('ul');
      list.replaceChildren(...h.problems.map((p) => Object.assign(document.createElement('li'), { textContent: p })));
      els.notice.replaceChildren(title, list);
      els.notice.hidden = false;
      return true;
    } catch {
      return false;
    }
  }

  async function load() {
    try {
      const res = await fetch('/api/recipes?status=all&limit=500', { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).errors?.[0] || `HTTP ${res.status}`);
      recipes = (await res.json()).recipes;
      lastOk = new Date();
      els.notice.hidden = true;
      els.stamp.classList.remove('stale');
      els.stamp.textContent = `Updated ${lastOk.toLocaleTimeString()}`;
    } catch (e) {
      if (!(await showSetupProblems())) {
        els.stamp.classList.add('stale');
        els.stamp.textContent = lastOk
          ? `Couldn’t refresh (${e.message}). Showing data from ${lastOk.toLocaleTimeString()}.`
          : `Couldn’t load recipes: ${e.message}`;
      }
    }
    render();
  }

  // ---------------------------------------------------------------- wiring
  els.theme.addEventListener('change', () => { filters.theme = els.theme.value; syncUrl(); render(); });
  els.group.addEventListener('change', () => { filters.group = els.group.value; syncUrl(); render(); });
  for (const radio of document.querySelectorAll('input[name="status"]')) {
    radio.checked = radio.value === filters.status;
    radio.addEventListener('change', () => { filters.status = radio.value; syncUrl(); render(); });
  }

  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
