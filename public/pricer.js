// Pricer page: try the agent on a sample recipe, edit its instructions, and
// follow the class's recipes through the queue. Instructor tools need the
// admin key (shared with the Admin page, kept for this browser tab).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORE = 'rc-admin-key';
  const hashId = () => { try { return decodeURIComponent(location.hash.slice(1)); } catch { return ''; } };
  let key = '';
  try { key = sessionStorage.getItem(STORE) || ''; } catch { /* storage unavailable */ }

  let overview = null;
  let selected = hashId() || null;
  let detail = null;
  let test = null;
  let promptDirty = false;
  let timer = null;

  // ---------------------------------------------------------------- helpers
  // Props with a dash (aria-expanded, aria-label) are attributes; the rest are properties.
  const el = (tag, { dataset, ...props } = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (k.includes('-')) node.setAttribute(k, v); else node[k] = v;
    if (dataset) Object.assign(node.dataset, dataset);
    node.append(...children.flat().filter((c) => c != null && c !== false));
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

  const money = (n) => (n == null ? '–' : `$${Number(n).toFixed(2)}`);
  const num = (n, digits = 0) => (n == null ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
  const STATUS = { unpriced: 'Not priced', pending: 'Waiting', pricing: 'Being priced', priced: 'Priced', failed: 'Couldn’t price' };
  // TheMealDB serves a small thumbnail at <image>/small; other images are shown as they are.
  const thumb = (u) => (/^https:\/\/www\.themealdb\.com\/images\//i.test(u) ? `${u}/small` : u);
  const pill = (status) => el('span', { className: `pill price-${status}`, textContent: STATUS[status] || status });

  async function getJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error((body.errors || [`HTTP ${res.status}`]).join(' ')), { status: res.status });
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
    if (res.status === 401) signOut('Your admin key was rejected. Sign in again.');
    return { ok: res.ok, body: out, errors: out.errors || (res.ok ? [] : [`HTTP ${res.status}`]) };
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
    $('signed-in').hidden = !on;
    $('prompt-actions').hidden = !on;
    $('prompt').readOnly = !on;
    $('prompt-kind').textContent = on ? 'Prompt · you can edit it' : 'Prompt';
    $('run-test').disabled = !on || test?.status === 'running';
    // Students watch; the instructor's controls appear only once signed in.
    for (const n of document.querySelectorAll('.instructor-only')) n.hidden = !on;
    if (overview) renderQueue();
    window.showInstructor?.(on);
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

  // One step, in a few words, for the "What the agent is doing" panels.
  function feedWhat(s) {
    if (s.kind === 'tool_call') {
      if (s.tool === 'search_kroger') return `→ searches Kroger for “${s.input?.term ?? ''}”`;
      if (s.tool === 'finish') return '→ finishes the cart';
      return `→ ${s.tool} ${Object.values(s.input || {}).filter((v) => typeof v !== 'object').slice(0, 3).join(', ')}`;
    }
    if (s.kind === 'tool_result') {
      const o = s.output || {};
      if (s.tool === 'search_kroger') return o.count ? `← ${o.count} products, e.g. ${o.products[0].description} ${money(o.products[0].promo_price_usd ?? o.products[0].price_usd)}` : '← no products found';
      if (s.tool === 'record_ingredient') return `← line ${o.recorded}: buy ${o.packages_to_buy} for ${money(o.cost_to_buy_usd)}`;
      if (s.tool === 'estimate_ingredient') return `← line ${o.estimated}: estimated ${money(o.cost_to_buy_usd)}`;
      if (s.tool === 'skip_ingredient') return `← line ${o.skipped} skipped`;
      return `← ${s.tool}`;
    }
    if (s.kind === 'final') return '✓ Finished the cart';
    if (s.kind === 'error') return `✗ ${s.text}`;
    return s.text;
  }
  const feedItem = (s, label) => el('li', { className: `feed-${s.kind}` },
    el('span', { className: 'feed-time', textContent: time(s.at) }),
    label,
    el('span', { className: 'feed-what' }, moreText(feedWhat(s))));

  // ---------------------------------------------------------------- 1. test runs
  async function runTest() {
    const ingredients = $('test-lines').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const body = { name: $('test-name').value.trim() || undefined, ingredients, serves: Number($('test-serves').value) || 4 };
    if (promptDirty) body.prompt = $('prompt').value; // unsaved instructions are tried as they are
    $('run-test').disabled = true;
    const r = await control('test', body);
    if (!r.ok) {
      $('run-test').disabled = false;
      return toast(r.errors.join(' '), true);
    }
    $('try').open = true;
    $('try').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await loadTest(r.body.id);
    schedule();
  }
  $('run-test').addEventListener('click', runTest);

  async function loadTest(id = 'latest') {
    try {
      test = await getJson(`/api/pricer?test=${encodeURIComponent(id)}`);
    } catch (e) {
      if (e.status === 404) {
        $('test-now').replaceChildren(el('span', { className: 'dot' }), 'Idle: no test yet.');
        $('test-feed').replaceChildren(el('li', { className: 'muted small', textContent: 'The Pricer Agent’s steps appear here while a test runs.' }));
      }
      if (e.status !== 404) $('test-result').replaceChildren(el('p', { className: 'errors', textContent: e.message }));
      return;
    }
    renderTest();
  }

  function tiles(cart, used, people, estimated = 0) {
    return el('div', { className: 'cart-tiles' },
      el('div', { className: 'tile' }, el('span', { textContent: 'Cart total' }), el('strong', { textContent: money(cart) }),
        el('small', { textContent: [people ? `for ${people} people` : '', estimated ? `includes ${estimated} estimated price${estimated === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') })),
      el('div', { className: 'tile' }, el('span', { textContent: 'Cost per serving' }), el('strong', { textContent: money(people ? used / people : null) }), el('small', { textContent: `ingredients used: ${money(used)}` })),
    );
  }

  function trace(steps, { open = false, toolCalls } = {}) {
    return el('details', { className: 'trace', open },
      el('summary', {}, el('strong', { textContent: 'What the Pricer Agent did' }), el('span', { className: 'small muted', textContent: ` · ${steps.length} steps${toolCalls != null ? `, ${toolCalls} tool calls` : ''}` })),
      steps.length ? el('ol', { className: 'trace-list' }, steps.map(stepCard)) : el('p', { className: 'muted', textContent: 'No steps yet.' }),
    );
  }

  function renderTest() {
    const t = test;
    if (!t) return;
    const byLine = new Map((t.basket || []).map((e) => [e.line, e]));
    const running = t.status === 'running';
    const seconds = Math.round((new Date(t.updated_at) - new Date(t.created_at)) / 1000);
    const title = el('h3', { className: 'test-title', textContent: t.name || 'Sample recipe' });
    const status = running
      ? el('p', { className: 'test-status running' }, pill('pricing'), ` Working… ${byLine.size} of ${t.ingredients.length} ingredients done`)
      : t.status === 'done'
        ? el('p', { className: 'test-status' }, pill('priced'), ` Finished in ${seconds} s · ${ago(t.created_at)}${t.draft ? ' · with unsaved instructions' : ''}`)
        : el('p', { className: 'test-status' }, pill('failed'), ` ${t.error || 'The test failed.'}`);
    $('test-result').replaceChildren(...[
      title,
      status,
      t.status === 'done' ? tiles(t.totals?.cart_usd, t.totals?.cost_used_usd, t.people, t.totals?.estimated_lines) : null,
      t.summary ? el('p', { className: 'cart-summary' }, el('strong', { textContent: 'The Pricer Agent’s summary: ' }), t.summary) : null,
      cartTable(t.ingredients.map((line) => ({ name: line })), byLine, {
        running, priced: t.status === 'done', people: t.people, toBuy: t.totals?.cart_usd, used: t.totals?.cost_used_usd,
      }),
    ].filter(Boolean));

    // The agent's output for this test, on the right, newest first.
    const now = running
      ? `Pricing ${t.name || 'the sample recipe'}: ${byLine.size} of ${t.ingredients.length} ingredients done, ${t.tool_calls} tool calls so far.`
      : t.status === 'done' ? `Finished ${t.name || 'the sample recipe'} in ${seconds} s with ${t.tool_calls} tool calls: cart ${money(t.totals?.cart_usd)} for ${t.people} people.`
        : `Stopped: ${t.error || 'the test failed'}`;
    $('test-now').replaceChildren(el('span', { className: `dot ${running ? 'on' : ''}` }), now);
    const steps = [...(t.steps || [])].reverse();
    $('test-feed').replaceChildren(...(steps.length ? steps.map((st) => feedItem(st, null)) : [el('li', { className: 'muted small', textContent: 'No steps yet.' })]));
    $('run-test').disabled = !key || running;
    if (!$('test-lines').dataset.touched && t.ingredients) $('test-lines').value = t.ingredients.join('\n');
    if (!$('test-name').dataset.touched && t.name) $('test-name').value = t.name;
  }
  $('test-lines').addEventListener('input', () => { $('test-lines').dataset.touched = '1'; });
  $('test-name').addEventListener('input', () => { $('test-name').dataset.touched = '1'; });

  // ---------------------------------------------------------------- 2. instructions
  function showPromptState() {
    const o = overview;
    const state = $('prompt-state');
    state.className = `small ${promptDirty ? 'unsaved' : 'muted'}`;
    state.textContent = promptDirty ? 'Unsaved changes' : o?.prompt_is_default ? 'The default instructions' : 'Edited by the instructor';
  }
  $('prompt').addEventListener('input', () => {
    promptDirty = $('prompt').value !== overview?.prompt;
    showPromptState();
  });
  $('save-prompt').addEventListener('click', async () => {
    const r = await control('prompt', { prompt: $('prompt').value });
    if (!r.ok) return toast(r.errors.join(' '), true);
    promptDirty = false;
    toast('Saved. Recipes priced from now on use these instructions; Reprice all, under View how the Pricer Agent works, applies them to the rest.');
    refresh();
  });

  // ---------------------------------------------------------------- 3. recipe carts
  const busy = new Set(); // recipes whose button was just pressed
  async function priceOne(mealId) {
    busy.add(mealId);
    renderQueue();
    const r = await control('price', { meal_id: mealId });
    if (!r.ok) toast(r.errors.join(' '), true);
    setTimeout(() => { busy.delete(mealId); refresh(); }, 1200);
  }
  $('price-unpriced').addEventListener('click', async () => {
    const r = await control('price-unpriced');
    toast(r.ok ? (r.body.queued ? `${r.body.queued} recipe${r.body.queued === 1 ? ' is' : 's are'} queued to be priced.` : 'Every recipe already has a price or is in the queue.') : r.errors.join(' '), !r.ok);
    setTimeout(refresh, 1200);
  });
  $('reprice-all').addEventListener('click', async (e) => {
    if (!confirmed(e.currentTarget)) return;
    const r = await control('reprice-all', { confirm: 'REPRICE' });
    toast(r.ok ? `${r.body.queued} recipes queued to be priced again.` : r.errors.join(' '), !r.ok);
    setTimeout(refresh, 1200);
  });
  $('clear-all').addEventListener('click', async (e) => {
    if (!confirmed(e.currentTarget)) return;
    const r = await control('clear-all', { confirm: 'CLEAR' });
    toast(r.ok ? `Prices removed from ${r.body.cleared} recipes. They stay unpriced until someone asks.` : r.errors.join(' '), !r.ok);
    selected = null;
    refresh();
  });

  function renderOverview() {
    const o = overview;
    $('facts').replaceChildren(
      'Model ', el('code', { textContent: o.model }), /haiku/i.test(o.model) ? ' (a small, low-cost model)' : '',
      ' · Kroger store near ZIP ', el('code', { textContent: o.zip }),
      ' · up to ', String(o.limits.tool_calls), ' tool calls per recipe',
    );
    const problem = $('problem');
    problem.hidden = !o.problem;
    if (o.problem) problem.replaceChildren(el('h2', { textContent: 'The Pricer Agent isn’t running yet' }), el('p', { textContent: o.problem }));
    if (!promptDirty && document.activeElement !== $('prompt')) $('prompt').value = o.prompt;
    showPromptState();
    if (!$('test-lines').value) $('test-lines').value = (o.sample_ingredients || []).join('\n');
    if (!$('test-name').value) $('test-name').value = o.sample_recipe || '';

    const c = o.counts;
    $('counts').replaceChildren(...[['priced', 'priced'], ['pricing', 'being priced'], ['pending', 'waiting'], ['unpriced', 'not priced'], ['failed', 'couldn’t price']]
      .filter(([k]) => k !== 'unpriced' || c.unpriced)
      .map(([k, label]) => el('span', { className: `count-chip price-${k}` }, el('strong', { textContent: String(c[k] ?? 0) }), ` ${label}`)));
    renderQueue();
    renderFeed();
  }

  function renderQueue() {
    const o = overview;
    if (!o) return;
    if (!o.pricings.length) {
      $('queue').replaceChildren(el('p', { className: 'empty small', textContent: 'No recipes yet. They appear here as soon as a Scout Agent saves one.' }));
      return;
    }
    keepState($('queue'), () => $('queue').replaceChildren(...o.pricings.map((p) => {
      const img = safeUrl(p.image_url) ? el('img', { src: thumb(p.image_url), alt: '', loading: 'lazy' }) : el('span', { className: 'thumb-blank' });
      const per = p.status === 'priced' && p.people ? p.total_cost_usd / p.people : null;
      const price = p.status === 'priced'
        ? el('div', { className: 'rl-price' }, el('strong', { textContent: `${money(per)}` }), el('span', { textContent: ' a serving' }),
          el('small', { textContent: `cart ${money(p.to_buy_usd)} for ${p.people} · ${ago(p.finished_at)}` }),
          p.estimated_lines ? el('span', { className: 'pill estimated', textContent: `${p.estimated_lines} estimated`, title: 'Prices the agent estimated because Kroger had none' }) : null,
          p.prompt_current === false ? el('span', { className: 'pill older', textContent: 'older instructions' }) : null)
        : el('div', { className: 'rl-price' }, pill(p.status),
          el('small', { textContent: p.status === 'pricing' ? `${p.lines_done ?? 0} of ${p.lines ?? '?'} ingredients` : p.status === 'pending' ? 'in the queue' : p.status === 'failed' ? (p.error || '').slice(0, 70) : 'not in the queue' }));
      const canPrice = Boolean(key) && p.status !== 'pricing' && p.status !== 'pending' && !busy.has(p.meal_id);
      const label = p.status === 'priced' || p.status === 'failed' ? 'Reprice' : 'Price';
      const open = p.meal_id === selected;
      const row = el('article', { className: `rl-row status-${p.status}${open ? ' open' : ''}`, 'data-key': p.meal_id },
        el('div', { className: 'rl-main' },
          img,
          el('div', { className: 'rl-name' }, el('strong', { textContent: p.name || `Recipe ${p.meal_id}` }), el('small', { className: 'muted', textContent: (p.groups || []).join(', ') })),
          price,
          el('div', { className: 'rl-actions' },
            key ? el('button', { type: 'button', className: 'btn small-btn', textContent: busy.has(p.meal_id) ? 'Queued…' : p.status === 'pending' ? 'Queued' : p.status === 'pricing' ? 'Pricing…' : label, disabled: !canPrice, onclick: () => priceOne(p.meal_id) }) : null,
            el('button', { type: 'button', className: 'btn small-btn linklike-btn', textContent: open ? 'Hide cart' : 'Cart', 'aria-expanded': String(open), onclick: () => toggle(p.meal_id) }),
          ),
        ),
        open ? el('div', { className: 'rl-detail', id: 'detail' }, detail && detail.meal_id === p.meal_id ? detailBody(detail) : el('p', { className: 'muted small', textContent: 'Loading…' })) : null,
      );
      return row;
    })));
  }

  function toggle(mealId) {
    selected = selected === mealId ? null : mealId;
    history.replaceState(null, '', selected ? `#${encodeURIComponent(selected)}` : location.pathname);
    detail = null;
    renderQueue();
    if (selected) loadDetail();
  }

  // What the agent is doing: a one-line summary, then its latest steps across recipes.
  function renderFeed() {
    const o = overview;
    const now = o.pricings.filter((p) => p.status === 'pricing');
    const waiting = o.counts.pending;
    const testRunning = test?.status === 'running';
    const line = now.length
      ? `Pricing ${now.map((p) => `${p.name} (${p.lines_done ?? 0} of ${p.lines ?? '?'} ingredients)`).join(' and ')}${waiting ? `; ${waiting} waiting` : ''}.`
      : waiting ? `${waiting} recipe${waiting === 1 ? '' : 's'} waiting; the agent starts within a minute.`
        : testRunning ? 'Running a test on the sample recipe (see it under Learn more).'
          : o.problem ? 'Stopped: see the message at the top of the page.' : 'Idle: nothing to price right now.';
    $('agent-now').replaceChildren(el('span', { className: `dot ${now.length || testRunning ? 'on' : ''}` }), line);
    $('feed').replaceChildren(...(o.activity || []).map((s) => feedItem(s,
      el('button', { type: 'button', className: 'linklike feed-recipe', textContent: s.name || s.meal_id, onclick: () => { if (selected !== s.meal_id) toggle(s.meal_id); } }))));
    if (!(o.activity || []).length) $('feed').append(el('li', { className: 'muted small', textContent: 'No steps yet.' }));
  }

  async function loadDetail() {
    if (!selected) return;
    try {
      detail = await getJson(`/api/pricer?meal_id=${encodeURIComponent(selected)}`);
    } catch (e) {
      detail = null;
    }
    renderQueue();
  }

  function stepCard(s) {
    const head = el('span', { className: 'step-time', textContent: time(s.at) });
    if (s.kind === 'thought') return el('li', { className: 'trace-step thought' }, head, el('p', {}, moreText(s.text, 400)));
    if (s.kind === 'final') return el('li', { className: 'trace-step final' }, head, el('p', {}, el('strong', { textContent: 'Finished. ' }), moreText(s.text, 400)));
    if (s.kind === 'error') {
      return el('li', { className: 'trace-step error' }, head, el('p', {}, s.tool ? el('code', { textContent: s.tool }) : null, s.tool ? ' was rejected: ' : '', moreText(s.text, 400)));
    }
    if (s.kind === 'tool_call') {
      const args = Object.entries(s.input || {}).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${typeof v === 'string' ? `“${v}”` : v}`).join(', ');
      return el('li', { className: 'trace-step call' }, head, el('p', {}, '→ ', el('code', { textContent: s.tool }), ' ', moreText(args)));
    }
    const o = s.output || {};
    let summary = 'Done';
    if (s.tool === 'search_kroger') summary = o.count ? `${o.count} products, e.g. ${o.products[0].description} (${o.products[0].size}) ${money(o.products[0].promo_price_usd ?? o.products[0].price_usd)}` : 'No products found';
    if (s.tool === 'record_ingredient') summary = `Line ${o.recorded}: buy ${o.packages_to_buy} for ${money(o.cost_to_buy_usd)}, uses ${money(o.cost_used_usd)} worth`;
    if (s.tool === 'record_ingredient' && o.substitute) summary += ' (a substitute)';
    if (s.tool === 'skip_ingredient') summary = `Line ${o.skipped} skipped`;
    if (s.tool === 'estimate_ingredient') summary = `Line ${o.estimated}: ESTIMATED, buy ${o.packages_to_buy} for ${money(o.cost_to_buy_usd)}`;
    return el('li', { className: 'trace-step result' }, head,
      el('details', {}, el('summary', { textContent: `← ${summary}` }), moreBlock(JSON.stringify(o, null, 2))));
  }

  function statusSentence(d, lines) {
    const done = (d.basket || []).length;
    if (d.status === 'priced') {
      return `Priced ${ago(d.finished_at)} for ${d.people} people, ${d.prompt_current === false ? 'with an older version of the instructions' : 'with the current instructions'}.`;
    }
    if (d.status === 'pricing') return `Being priced now: ${done} of ${lines} ingredients done.`;
    if (d.status === 'pending') return 'In the queue: the agent will price it within a few minutes.';
    if (d.status === 'unpriced') return key ? 'Not priced. Press Price to add it to the queue.' : 'Not priced yet: the instructor has paused automatic pricing.';
    return `Couldn’t be priced: ${(d.error || 'unknown reason').replace(/\.$/, '')}.`;
  }

  // The cart as a table, one row per ingredient line: used for the recipes'
  // carts and for the test on the sample recipe.
  function cartTable(lines, byLine, { running, priced, people, toBuy, used }) {
    const rows = lines.map((ing, i) => {
      const e = byLine.get(i + 1);
      const what = el('td', {}, el('strong', { textContent: ing.name }), ing.raw !== undefined ? el('br') : null,
        ing.raw !== undefined ? el('span', { className: 'small muted', textContent: ing.raw || 'no amount' }) : null);
      if (!e) return el('tr', { className: 'waiting' }, el('td', { textContent: String(i + 1) }), what, el('td', { colSpan: 4, className: 'muted', textContent: running ? 'Not yet…' : '–' }));
      if (e.status === 'skipped') return el('tr', { className: 'skipped' }, el('td', { textContent: String(i + 1) }), what, el('td', { colSpan: 4, className: 'muted' }, 'Not bought: ', e.reason));
      const p = e.product;
      const img = safeUrl(p.image_url);
      return el('tr', {},
        el('td', { textContent: String(i + 1) }),
        what,
        el('td', { className: 'cart-product' }, img ? el('img', { src: img, alt: '', loading: 'lazy' }) : null,
          el('span', {}, p.description, el('br'), el('span', { className: 'small muted', textContent: [p.size, p.brand].filter(Boolean).join(' · ') }), p.on_sale ? el('span', { className: 'pill sale', textContent: 'On sale' }) : null,
            e.status === 'estimated' ? el('span', { className: 'pill estimated', textContent: 'Estimated', title: `Not from Kroger: ${e.reason}` }) : null,
            e.status === 'estimated' ? el('span', { className: 'small estimated-why', textContent: ` ${e.reason}` }) : null,
            e.substitute_for ? el('span', { className: 'pill substitute', textContent: 'Substitute', title: `Instead of ${e.substitute_for}` }) : null,
            e.substitute_for ? el('span', { className: 'small substitute-why', textContent: ` Instead of ${e.substitute_for}` }) : null)),
        el('td', { className: 'num' }, el('strong', { textContent: `× ${e.packages}` }), el('br'), el('span', { className: 'small muted', textContent: `at ${money(p.price_usd)}` })),
        el('td', { className: 'num' }, el('strong', { textContent: money(e.cost_to_buy_usd) })),
        el('td', { className: 'num' }, `${num(e.amount_used, 2)} ${e.unit_used}`, el('br'), el('span', { className: 'small muted', textContent: `${money(e.cost_used_usd)} used` })),
      );
    });
    return el('div', { className: 'table-wrap cart' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['#', 'Ingredient', 'Kroger product', 'Buy', 'Line total', 'Recipe uses'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, rows),
      priced ? el('tfoot', {}, el('tr', {}, el('td', {}), el('td', { colSpan: 3, textContent: `Cart for ${people} people` }),
        el('td', { className: 'num' }, el('strong', { textContent: money(toBuy) })), el('td', { className: 'num', textContent: `${money(used)} used` }))) : null));
  }

  // One recipe's cart and steps, shown under its row.
  function detailBody(d) {
    const r = d.recipe || {};
    const lines = r.ingredients || [];
    const byLine = new Map((d.basket || []).map((e) => [e.line, e]));
    return [
      el('p', { className: 'detail-status' }, pill(d.status), ' ', statusSentence(d, lines.length),
        /^\d+$/.test(d.meal_id) ? el('a', { className: 'small', href: `https://www.themealdb.com/meal/${d.meal_id}`, target: '_blank', rel: 'noopener', textContent: ' Recipe on TheMealDB' }) : null),
      d.status === 'priced' ? tiles(d.to_buy_usd, d.total_cost_usd, d.people, (d.basket || []).filter((x) => x.status === 'estimated').length) : null,
      d.summary ? el('p', { className: 'cart-summary' }, el('strong', { textContent: 'The Pricer Agent’s summary: ' }), d.summary) : null,
      cartTable(lines, byLine, { running: d.status === 'pricing', priced: d.status === 'priced', people: d.people, toBuy: d.to_buy_usd, used: d.total_cost_usd }),
      trace(d.steps, { open: d.status === 'pricing', toolCalls: d.tool_calls }),
    ].filter(Boolean);
  }

  // ---------------------------------------------------------------- refresh
  function schedule() {
    clearTimeout(timer);
    const busy = (overview && (overview.counts.pricing > 0 || overview.counts.pending > 0)) || test?.status === 'running';
    timer = setTimeout(refresh, busy ? 3000 : 15000);
  }
  async function refresh() {
    try {
      overview = await getJson('/api/pricer');
      renderOverview();
      await Promise.all([selected ? loadDetail() : null, loadTest(test?.status === 'running' ? test.id : 'latest')]);
    } catch (e) {
      $('queue').replaceChildren(el('p', { className: 'errors', textContent: `Couldn’t load the Pricer Agent: ${e.message}` }));
    }
    schedule();
  }

  window.addEventListener('hashchange', () => {
    const id = hashId();
    if (id && id !== selected) toggle(id);
  });
  showSignedIn();
  refresh();
})();
