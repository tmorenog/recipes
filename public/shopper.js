// Shopper page: the Shopper Agent's instructions, the class's plan (its choice)
// with its Kroger cart, and its latest run. The instructor, signed in, can edit
// the instructions, run it and clear the class's plan.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let key = '';
  try { key = sessionStorage.getItem('rc-admin-key') || ''; } catch { /* storage unavailable */ }

  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (k.includes('-')) node.setAttribute(k, v); else node[k] = v;
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  };
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ---------------------------------------------------------------- the class's plan
  function renderChoice(choice, history) {
    if (!choice?.plan) {
      $('choice').replaceChildren(el('p', { className: 'empty small', textContent: 'No plan chosen yet. The instructor runs the Shopper Agent once the Meal Planner Agents have saved their plans.' }));
      return;
    }
    // The page refreshes every few seconds: folds a student opened stay open.
    const open = new Set([...$('choice').querySelectorAll('details[open]')].map((d) => d.dataset.fold));
    $('choice').replaceChildren(...[window.shoppingPlan(choice),
      history?.length ? el('p', { className: 'small' }, `${history.length} earlier choice${history.length === 1 ? '' : 's'}: `, el('a', { href: '/coordinator?view=shopping', textContent: 'see them on the Coordinator page' }), '.') : null].filter(Boolean));
    for (const d of $('choice').querySelectorAll('details')) if (open.has(d.dataset.fold)) d.open = true;
  }

  // ---------------------------------------------------------------- the latest run
  function describe(s) {
    if (s.kind === 'tool_call') return `→ ${s.tool} ${JSON.stringify(s.input ?? {})}`;
    if (s.kind === 'tool_result') return `← ${s.tool}: ${s.text}`;
    if (s.kind === 'error') return `${s.tool ? `✗ ${s.tool}: ` : ''}${s.text}`;
    return s.text;
  }
  function renderRun(run) {
    $('outcome').hidden = !run;
    if (!run) {
      $('now').replaceChildren(el('span', { className: 'dot' }), 'Idle: not run yet.');
      $('feed').replaceChildren(el('li', { className: 'muted small', textContent: 'The Shopper Agent’s steps appear here while it runs.' }));
      return false;
    }
    const running = run.status === 'running';
    $('now').replaceChildren(el('span', { className: `dot${running ? ' on' : ''}` }), running ? `Working: ${run.actions} action${run.actions === 1 ? '' : 's'} so far.` : `Last run ${when(run.created_at)}: ${run.actions} actions.`);
    $('feed').replaceChildren(...[...run.steps].reverse().map((s) => el('li', { className: `feed-${s.kind === 'tool_call' || s.kind === 'tool_result' ? 'tool' : s.kind}` },
      el('span', { className: 'feed-time', textContent: time(s.at) }), el('span', { className: 'feed-what' }, moreText(describe(s))))));
    $('outcome').replaceChildren(...[el('strong', { textContent: running ? 'Running…' : run.outcome || run.status }), run.summary ? el('span', { className: 'outcome-summary' }, moreText(run.summary, 400)) : null].filter(Boolean));
    $('outcome').className = `outcome ${running ? '' : run.status === 'done' ? 'good' : 'bad'}`;
    // Once a plan is chosen, the plan says it all; the box is for a run in
    // progress, or one that chose nothing.
    $('outcome').hidden = !running && run.outcome === 'Plan chosen';
    return running;
  }

  let timer;
  async function load() {
    clearTimeout(timer);
    let running = false;
    try {
      const res = await fetch('/api/meal-plans?choice=latest', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error((body.errors || [`HTTP ${res.status}`]).join(' '));
      renderChoice(body.choice, body.history);
      running = renderRun(body.run);
    } catch (e) {
      $('choice').replaceChildren(el('p', { className: 'errors', textContent: `Couldn’t load the class’s plan: ${e.message}` }));
    }
    $('run').disabled = running;
    timer = setTimeout(load, running ? 2000 : 20000);
  }

  // ---------------------------------------------------------------- the instructions
  // Students read them; the instructor, signed in, edits and saves them.
  let saved = '';
  let dirty = false;
  async function loadPrompt() {
    try {
      const body = await (await fetch('/api/prompts?agent=shopper', { cache: 'no-store' })).json();
      const edited = body.steps?.[1];
      saved = (edited ?? body.defaults?.[1] ?? '').trim();
      $('prompt-state').textContent = edited ? 'Edited by the instructor' : 'The default instructions';
      $('prompt-state').className = 'small muted';
      if (!dirty && document.activeElement !== $('prompt')) $('prompt').value = saved;
    } catch {
      $('prompt-state').textContent = 'Couldn’t load the instructions.';
    }
  }
  $('prompt').addEventListener('input', () => {
    dirty = $('prompt').value.trim() !== saved;
    $('prompt-state').textContent = dirty ? 'Unsaved changes' : '';
    $('prompt-state').className = `small ${dirty ? 'unsaved' : 'muted'}`;
  });
  $('save-prompt').addEventListener('click', async () => {
    const res = await fetch('/api/prompts', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'shopper', step: 1, text: $('prompt').value }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return signOut('Your admin key was rejected. Sign in again.');
    $('prompt-msg').textContent = res.ok ? 'Saved.' : (body.errors || [`HTTP ${res.status}`]).join(' ');
    $('prompt-msg').className = `small ${res.ok ? 'good' : 'bad'}`;
    if (res.ok) { dirty = false; await loadPrompt(); }
  });

  // ---------------------------------------------------------------- the instructor
  function showSignedIn() {
    const on = Boolean(key);
    $('signin').hidden = on;
    $('signed-in').hidden = !on;
    $('prompt-actions').hidden = !on;
    $('prompt').readOnly = !on;
    $('prompt-kind').textContent = on ? 'Prompt · you can edit it' : 'Prompt';
    for (const n of document.querySelectorAll('.instructor-only')) n.hidden = !on;
    window.showInstructor?.(on);
  }
  function signOut(message) {
    key = '';
    try { sessionStorage.removeItem('rc-admin-key'); } catch { /* ignore */ }
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
    try { sessionStorage.setItem('rc-admin-key', key); } catch { /* ignore */ }
    $('admin-key').value = '';
    $('signin-result').textContent = '';
    showSignedIn();
  });
  $('signout').addEventListener('click', () => signOut());

  const clear = $('clear');
  const clearLabel = clear.textContent;
  clear.addEventListener('click', async () => {
    if (!clear.dataset.armed) {
      clear.dataset.armed = '1';
      clear.textContent = clear.dataset.confirm;
      setTimeout(() => { delete clear.dataset.armed; clear.textContent = clearLabel; }, 4000);
      return;
    }
    delete clear.dataset.armed;
    clear.textContent = clearLabel;
    const res = await fetch('/api/admin/clear-choices', { method: 'POST', headers: { authorization: `Bearer ${key}` } });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return signOut('Your admin key was rejected. Sign in again.');
    $('run-msg').textContent = res.ok ? 'The class’s plan is cleared.' : (body.errors || [`HTTP ${res.status}`]).join(' ');
    load();
  });
  $('run').addEventListener('click', async () => {
    $('run').disabled = true;
    $('run-msg').textContent = 'Starting…';
    const res = await fetch('/api/admin/agent-runs', {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'shopper', people: Number($('people').value) || 50 }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) return signOut('Your admin key was rejected. Sign in again.');
    $('run-msg').textContent = res.ok ? 'Running: follow it below.' : (body.errors || [`HTTP ${res.status}`]).join(' ');
    if (!res.ok) $('run').disabled = false;
    load();
  });

  showSignedIn();
  loadPrompt();
  load();
})();
