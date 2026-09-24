// Pricer page: try the agent on a sample list, edit its instructions, and
// follow the class's recipes through the queue. Instructor tools need the
// admin key (shared with the Admin page, kept for this browser tab).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORE = 'rc-admin-key';
  let key = '';
  try { key = sessionStorage.getItem(STORE) || ''; } catch { /* storage unavailable */ }

  let overview = null;
  let selected = decodeURIComponent(location.hash.slice(1)) || null;
  let detail = null;
  let test = null;
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
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  };
  const safeUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);
  const STAGES = [
    ['pricing', 'Being priced now'],
    ['pending', 'Waiting'],
    ['priced', 'Priced'],
    ['failed', 'Couldn’t price'],
  ];
  const STATUS = { pending: 'Waiting', pricing: 'Being priced', priced: 'Priced', failed: 'Couldn’t price' };
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
    $('queue-actions').hidden = !on;
    $('prompt').readOnly = !on;
    $('prompt-kind').textContent = on ? 'Prompt · you can edit it' : 'Prompt';
    $('run-test').disabled = !on || test?.status === 'running';
    $('test-hint').textContent = on ? 'Uses real AI and Kroger requests; a test takes a minute or two.' : 'Sign in above to run a test.';
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

  // ---------------------------------------------------------------- 1. test runs
  async function runTest(useDraft) {
    const ingredients = $('test-lines').value.split('\n').map((l) => l.trim()).filter(Boolean);
    const body = { ingredients, serves: Number($('test-serves').value) || 4 };
    if (useDraft || promptDirty) body.prompt = $('prompt').value;
    $('run-test').disabled = true;
    const r = await control('test', body);
    if (!r.ok) {
      $('run-test').disabled = false;
      return toast(r.errors.join(' '), true);
    }
    $('try').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await loadTest(r.body.id);
    schedule();
  }
  $('run-test').addEventListener('click', () => runTest(false));
  $('test-draft').addEventListener('click', () => runTest(true));

  async function loadTest(id = 'latest') {
    try {
      test = await getJson(`/api/pricer?test=${encodeURIComponent(id)}`);
    } catch (e) {
      if (e.status !== 404) $('test-result').replaceChildren(el('p', { className: 'errors', textContent: e.message }));
      return;
    }
    renderTest();
  }

  // One card per ingredient: the product the agent chose, with its picture.
  function productCard(line, e, pendingText) {
    if (!e) return el('li', { className: 'product-card waiting' }, el('div', { className: 'pc-img blank' }), el('div', { className: 'pc-body' }, el('p', { className: 'pc-line', textContent: line }), el('p', { className: 'muted small', textContent: pendingText })));
    if (e.status === 'skipped') {
      return el('li', { className: 'product-card skipped' }, el('div', { className: 'pc-img blank', textContent: '—' }),
        el('div', { className: 'pc-body' }, el('p', { className: 'pc-line', textContent: line }), el('p', { className: 'muted small', textContent: `Not bought: ${e.reason}` })));
    }
    const p = e.product;
    const img = safeUrl(p.image_url);
    return el('li', { className: 'product-card' },
      img ? el('img', { className: 'pc-img', src: img, alt: '', loading: 'lazy' }) : el('div', { className: 'pc-img blank' }),
      el('div', { className: 'pc-body' },
        el('p', { className: 'pc-line', textContent: line }),
        el('p', { className: 'pc-product' }, p.description, p.on_sale ? el('span', { className: 'pill sale', textContent: 'On sale' }) : null),
        el('p', { className: 'small muted', textContent: [p.size, p.brand].filter(Boolean).join(' · ') }),
        el('p', { className: 'pc-price' }, el('strong', { textContent: `${e.packages} × ${money(p.price_usd)} = ${money(e.cost_to_buy_usd)}` })),
        el('p', { className: 'small muted', textContent: `Uses ${num(e.amount_used, 2)} ${e.unit_used} · ${money(e.cost_used_usd)} worth${e.note ? ` · ${e.note}` : ''}` }),
      ),
    );
  }

  function tiles(cart, used, people) {
    return el('div', { className: 'cart-tiles' },
      el('div', { className: 'tile' }, el('span', { textContent: 'Cart total' }), el('strong', { textContent: money(cart) }), el('small', { textContent: people ? `for ${people} people` : '' })),
      el('div', { className: 'tile' }, el('span', { textContent: 'Cost per serving' }), el('strong', { textContent: money(people ? used / people : null) }), el('small', { textContent: `ingredients used: ${money(used)}` })),
    );
  }

  function trace(steps, { open = false, toolCalls } = {}) {
    return el('details', { className: 'trace', open },
      el('summary', {}, el('strong', { textContent: 'What the agent did' }), el('span', { className: 'small muted', textContent: ` · ${steps.length} steps${toolCalls != null ? `, ${toolCalls} tool calls` : ''}` })),
      steps.length ? el('ol', { className: 'trace-list' }, steps.map(stepCard)) : el('p', { className: 'muted', textContent: 'No steps yet.' }),
    );
  }

  function renderTest() {
    const t = test;
    if (!t) return;
    const byLine = new Map((t.basket || []).map((e) => [e.line, e]));
    const running = t.status === 'running';
    const seconds = Math.round((new Date(t.updated_at) - new Date(t.created_at)) / 1000);
    const status = running
      ? el('p', { className: 'test-status running' }, pill('pricing'), ` Working… ${byLine.size} of ${t.ingredients.length} ingredients done`)
      : t.status === 'done'
        ? el('p', { className: 'test-status' }, pill('priced'), ` Finished in ${seconds} s · ${ago(t.created_at)}${t.draft ? ' · with unsaved instructions' : ''}`)
        : el('p', { className: 'test-status' }, pill('failed'), ` ${t.error || 'The test failed.'}`);
    $('test-result').replaceChildren(
      status,
      t.status === 'done' ? tiles(t.totals?.cart_usd, t.totals?.cost_used_usd, t.people) : null,
      el('ul', { className: 'product-cards' }, t.ingredients.map((line, i) => productCard(line, byLine.get(i + 1), running ? 'Not yet…' : '–'))),
      t.summary ? el('p', { className: 'cart-summary' }, el('strong', { textContent: 'The agent’s summary: ' }), t.summary) : null,
      trace(t.steps || [], { open: running, toolCalls: t.tool_calls }),
    );
    $('run-test').disabled = !key || running;
    if (!$('test-lines').dataset.touched && t.ingredients) $('test-lines').value = t.ingredients.join('\n');
  }
  $('test-lines').addEventListener('input', () => { $('test-lines').dataset.touched = '1'; });

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
  async function savePrompt({ reprice }) {
    const r = await control('prompt', { prompt: $('prompt').value });
    if (!r.ok) return toast(r.errors.join(' '), true);
    promptDirty = false;
    if (reprice) {
      const q = await control('reprice-all', { confirm: 'REPRICE' });
      toast(q.ok ? `Saved. ${q.body.queued} recipe${q.body.queued === 1 ? ' is' : 's are'} queued to be priced again with these instructions.` : q.errors.join(' '), !q.ok);
      $('carts').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      toast('Saved. Recipes priced from now on use these instructions.');
    }
    refresh();
  }
  $('save-prompt').addEventListener('click', () => savePrompt({ reprice: false }));
  $('save-reprice').addEventListener('click', (e) => { if (confirmed(e.currentTarget)) savePrompt({ reprice: true }); });
  $('reset-prompt').addEventListener('click', async (e) => {
    if (!confirmed(e.currentTarget)) return;
    const r = await control('prompt', { reset: true });
    if (!r.ok) return toast(r.errors.join(' '), true);
    promptDirty = false;
    $('prompt').value = r.body.prompt;
    toast('Back to the default instructions.');
    refresh();
  });

  // ---------------------------------------------------------------- 3. recipe carts
  $('run').addEventListener('click', async () => {
    const r = await control('run');
    toast(r.ok ? 'Started: waiting recipes are being priced.' : r.errors.join(' '), !r.ok);
    setTimeout(refresh, 1500);
  });
  $('retry').addEventListener('click', async () => {
    const r = await control('retry-failed');
    toast(r.ok ? `${r.body.queued} recipe${r.body.queued === 1 ? '' : 's'} queued again.` : r.errors.join(' '), !r.ok);
    refresh();
  });

  function queueMeta(p) {
    if (p.status === 'priced') {
      const per = p.people ? p.total_cost_usd / p.people : null;
      return [`${money(per)} a serving · priced ${ago(p.finished_at)}`, p.prompt_current === false ? el('span', { className: 'pill older', textContent: 'older instructions' }) : null];
    }
    if (p.status === 'pricing') return [`${p.lines_done ?? 0} of ${p.lines ?? '?'} ingredients done`];
    if (p.status === 'pending') return [`waiting since ${ago(p.created_at)}`];
    return [p.error ? p.error.slice(0, 80) : 'see why'];
  }

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
    showPromptState();
    if (!$('test-lines').value) $('test-lines').value = (o.sample_ingredients || []).join('\n');

    const c = o.counts;
    $('counts').replaceChildren(...STAGES.map(([s, label]) => el('span', { className: `count-chip price-${s}` }, el('strong', { textContent: String(c[s]) }), ` ${label.toLowerCase()}`)));

    const groups = STAGES.map(([status, label]) => {
      const items = o.pricings.filter((p) => p.status === status);
      if (!items.length) return null;
      return el('div', { className: `queue-group ${status}` },
        el('h3', { className: 'queue-heading' }, label, el('span', { className: 'muted', textContent: ` ${items.length}` })),
        el('ul', {}, items.map((p) => {
          const img = safeUrl(p.image_url) ? el('img', { src: `${p.image_url}/small`, alt: '', loading: 'lazy' }) : el('span', { className: 'thumb-blank' });
          return el('li', {},
            el('button', { type: 'button', className: `queue-item${p.meal_id === selected ? ' selected' : ''}`, onclick: () => select(p.meal_id) },
              img,
              el('span', { className: 'queue-text' },
                el('span', { className: 'queue-name', textContent: p.name || `Recipe ${p.meal_id}` }),
                el('span', { className: 'queue-meta' }, queueMeta(p)))));
        })));
    }).filter(Boolean);
    $('queue').replaceChildren(...(groups.length ? groups : [el('p', { className: 'empty small', textContent: 'No recipes yet. They appear here as soon as a Scout saves one.' })]));

    if (!selected && o.pricings.length) select((o.pricings.find((p) => p.status === 'pricing') || o.pricings[0]).meal_id, { quiet: true });
  }

  function select(mealId, { quiet } = {}) {
    selected = mealId;
    if (!quiet) history.replaceState(null, '', `#${encodeURIComponent(mealId)}`);
    renderOverview();
    loadDetail();
  }

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
    const head = el('span', { className: 'step-time', textContent: time(s.at) });
    if (s.kind === 'thought') return el('li', { className: 'trace-step thought' }, head, el('p', { textContent: s.text }));
    if (s.kind === 'final') return el('li', { className: 'trace-step final' }, head, el('p', {}, el('strong', { textContent: 'Finished. ' }), s.text));
    if (s.kind === 'error') {
      return el('li', { className: 'trace-step error' }, head, el('p', {}, s.tool ? el('code', { textContent: s.tool }) : null, s.tool ? ' was rejected: ' : '', s.text));
    }
    if (s.kind === 'tool_call') {
      const args = Object.entries(s.input || {}).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${typeof v === 'string' ? `“${v}”` : v}`).join(', ');
      return el('li', { className: 'trace-step call' }, head, el('p', {}, '→ ', el('code', { textContent: s.tool }), ` ${args}`));
    }
    const o = s.output || {};
    let summary = 'Done';
    if (s.tool === 'search_kroger') summary = o.count ? `${o.count} products, e.g. ${o.products[0].description} (${o.products[0].size}) ${money(o.products[0].promo_price_usd ?? o.products[0].price_usd)}` : 'No products found';
    if (s.tool === 'record_ingredient') summary = `Line ${o.recorded}: buy ${o.packages_to_buy} for ${money(o.cost_to_buy_usd)}, uses ${money(o.cost_used_usd)} worth`;
    if (s.tool === 'skip_ingredient') summary = `Line ${o.skipped} skipped`;
    return el('li', { className: 'trace-step result' }, head,
      el('details', {}, el('summary', { textContent: `← ${summary}` }), el('pre', { className: 'code', textContent: JSON.stringify(o, null, 2) })));
  }

  function statusSentence(d, lines) {
    const done = (d.basket || []).length;
    if (d.status === 'priced') {
      return `Priced ${ago(d.finished_at)} for ${d.people} people, ${d.prompt_current === false ? 'with an older version of the instructions' : 'with the current instructions'}.`;
    }
    if (d.status === 'pricing') return `Being priced now: ${done} of ${lines} ingredients done. This page updates itself.`;
    if (d.status === 'pending') return 'Waiting its turn. It will be priced automatically, usually within a few minutes.';
    return `Couldn’t be priced: ${d.error || 'unknown reason'}.`;
  }

  function renderDetail() {
    const d = detail;
    if (!d) return;
    const r = d.recipe || {};
    const lines = r.ingredients || [];
    const byLine = new Map((d.basket || []).map((e) => [e.line, e]));

    const head = el('div', { className: 'detail-head' },
      safeUrl(r.image_url) ? el('img', { src: `${r.image_url}/medium`, alt: '' }) : null,
      el('div', {},
        el('h3', {}, /^\d+$/.test(d.meal_id) ? el('a', { href: `https://www.themealdb.com/meal/${d.meal_id}`, target: '_blank', rel: 'noopener', textContent: r.name || d.meal_id }) : (r.name || d.meal_id)),
        el('p', { className: 'detail-status' }, pill(d.status), ' ', statusSentence(d, lines.length)),
        el('p', { className: 'small muted', textContent: `Serves about ${r.est_servings ?? '?'} as written${d.store_id ? ` · Kroger store ${d.store_id}` : ''}` }),
        key && d.status !== 'pricing' ? el('button', { type: 'button', className: 'btn small-btn', textContent: d.status === 'pending' ? 'Price it now' : 'Price again', onclick: async () => {
          const res = d.status === 'pending' ? await control('run') : await control('price', { meal_id: d.meal_id });
          toast(res.ok ? 'Queued: it will be priced with the current instructions.' : res.errors.join(' '), !res.ok);
          setTimeout(refresh, 1000);
        } }) : null,
      ),
    );

    const rows = lines.map((ing, i) => {
      const e = byLine.get(i + 1);
      const what = el('td', {}, el('strong', { textContent: ing.name }), el('br'), el('span', { className: 'small muted', textContent: ing.raw || 'no amount' }));
      if (!e) return el('tr', { className: 'waiting' }, el('td', { textContent: String(i + 1) }), what, el('td', { colSpan: 4, className: 'muted', textContent: d.status === 'pricing' ? 'Not yet…' : '–' }));
      if (e.status === 'skipped') {
        return el('tr', { className: 'skipped' }, el('td', { textContent: String(i + 1) }), what, el('td', { colSpan: 4, className: 'muted' }, 'Not bought: ', e.reason));
      }
      const p = e.product;
      const img = safeUrl(p.image_url);
      return el('tr', {},
        el('td', { textContent: String(i + 1) }),
        what,
        el('td', { className: 'cart-product' }, img ? el('img', { src: img, alt: '', loading: 'lazy' }) : null,
          el('span', {}, p.description, el('br'), el('span', { className: 'small muted', textContent: [p.size, p.brand].filter(Boolean).join(' · ') }), p.on_sale ? el('span', { className: 'pill sale', textContent: 'On sale' }) : null)),
        el('td', { className: 'num' }, el('strong', { textContent: `× ${e.packages}` }), el('br'), el('span', { className: 'small muted', textContent: `at ${money(p.price_usd)}` })),
        el('td', { className: 'num' }, el('strong', { textContent: money(e.cost_to_buy_usd) })),
        el('td', { className: 'num' }, `${num(e.amount_used, 2)} ${e.unit_used}`, el('br'), el('span', { className: 'small muted', textContent: `${money(e.cost_used_usd)} used` })),
      );
    });
    const cart = el('div', { className: 'table-wrap cart' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['#', 'Ingredient', 'Kroger product', 'Buy', 'Line total', 'Recipe uses'].map((h) => el('th', { textContent: h })))),
      el('tbody', {}, rows),
      d.status === 'priced' ? el('tfoot', {}, el('tr', {}, el('td', {}), el('td', { colSpan: 3, textContent: `Cart for ${d.people} people` }),
        el('td', { className: 'num' }, el('strong', { textContent: money(d.to_buy_usd) })), el('td', { className: 'num', textContent: `${money(d.total_cost_usd)} used` }))) : null,
    ));

    const open = new Set([...$('detail').querySelectorAll('.trace-step details[open]')].map((x) => x.closest('li').dataset.id));
    const traceOpen = $('detail').querySelector('details.trace')?.open ?? d.status === 'pricing';
    $('detail').replaceChildren(...[
      head,
      d.status === 'priced' ? tiles(d.to_buy_usd, d.total_cost_usd, d.people) : null,
      d.summary ? el('p', { className: 'cart-summary' }, el('strong', { textContent: 'The agent’s summary: ' }), d.summary) : null,
      el('h3', { textContent: 'Shopping cart' }),
      cart,
      trace(d.steps, { open: traceOpen, toolCalls: d.tool_calls }),
    ].filter(Boolean));
    [...$('detail').querySelectorAll('.trace-step')].forEach((li, i) => {
      li.dataset.id = String(d.steps[i]?.id);
      if (open.has(li.dataset.id)) li.querySelector('details')?.setAttribute('open', '');
    });
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
      $('detail').replaceChildren(el('p', { className: 'empty', textContent: `Couldn’t load the Pricer: ${e.message}` }));
    }
    schedule();
  }

  window.addEventListener('hashchange', () => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (id && id !== selected) select(id, { quiet: true });
  });
  showSignedIn();
  refresh();
})();
