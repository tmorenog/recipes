// Backup agents page: sign in with ADMIN_KEY, start a Scout or Planner Agent
// run, and follow it step by step. Runs happen on the server (/api/admin/agent-runs).
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORE = 'rc-admin-key';
  let key = '';
  try { key = sessionStorage.getItem(STORE) || ''; } catch { /* storage unavailable */ }

  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null && c !== false));
    return node;
  };
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
  const NAMES = { scout: 'Scout Agent', planner: 'Planner Agent' };

  async function api(method, { id, body } = {}) {
    const res = await fetch(`/api/admin/agent-runs${id ? `?id=${encodeURIComponent(id)}` : ''}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    const out = await res.json().catch(() => ({}));
    if (res.status === 401) signOut('Your admin key was rejected. Sign in again.');
    return { ok: res.ok, body: out, error: (out.errors || [`HTTP ${res.status}`])[0] };
  }

  // ---------------------------------------------------------------- sign in
  function signOut(message = '') {
    key = '';
    try { sessionStorage.removeItem(STORE); } catch { /* ignore */ }
    $('backup').hidden = true;
    $('signin').hidden = false;
    $('signin-result').textContent = message;
    $('signin-result').className = `keycheck-result${message ? ' bad' : ''}`;
  }
  async function signIn(candidate) {
    key = candidate;
    const res = await api('GET');
    if (!res.ok) return signOut(res.error);
    try { sessionStorage.setItem(STORE, key); } catch { /* ignore */ }
    $('signin').hidden = true;
    $('backup').hidden = false;
    showOverview(res.body);
  }
  $('signin-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('admin-key').value.trim();
    $('admin-key').value = '';
    if (value) signIn(value);
  });
  $('signout').addEventListener('click', () => signOut());

  // ---------------------------------------------------------------- overview
  function showOverview({ problem, model, runs }) {
    $('problem').hidden = !problem;
    $('problem').textContent = problem || '';
    $('model-note').textContent = `The agents use ${model}.`;
    for (const b of document.querySelectorAll('.backup-forms button')) b.disabled = Boolean(problem);
    $('runs').replaceChildren(...(runs.length ? runs.map((r) => el('li', {},
      el('button', { type: 'button', className: 'linklike', textContent: `${NAMES[r.agent]} · ${r.group_name} · ${when(r.created_at)}`, onclick: () => follow(r.id) }),
      el('span', { className: `small ${r.status === 'failed' ? 'bad' : 'muted'}`, textContent: ` ${r.status === 'running' ? 'running…' : r.outcome || r.status}` })))
      : [el('li', { className: 'muted small', textContent: 'No runs yet.' })]));
  }
  const refreshOverview = async () => { const res = await api('GET'); if (res.ok) showOverview(res.body); };

  // ---------------------------------------------------------------- one run
  let timer = null;
  function describe(s) {
    if (s.kind === 'tool_call') return `→ ${s.tool} ${JSON.stringify(s.input ?? {}).slice(0, 160)}`;
    if (s.kind === 'tool_result') return `← ${s.tool}: ${s.text}`;
    if (s.kind === 'error') return `${s.tool ? `✗ ${s.tool}: ` : ''}${s.text}`;
    return s.text;
  }
  function render(run) {
    $('feed-title').textContent = `What the ${NAMES[run.agent]} is doing`;
    const running = run.status === 'running';
    $('now').replaceChildren(el('span', { className: `dot${running ? ' on' : ''}` }),
      running ? `Working for ${run.group_name}: ${run.actions} action${run.actions === 1 ? '' : 's'} so far.` : `Finished: ${run.actions} action${run.actions === 1 ? '' : 's'}.`);
    $('feed').replaceChildren(...[...run.steps].reverse().map((s) => el('li', { className: `feed-${s.kind === 'tool_call' || s.kind === 'tool_result' ? 'tool' : s.kind}` },
      el('span', { className: 'feed-time', textContent: time(s.at) }),
      el('span', { className: 'feed-what', textContent: describe(s) }))));
    const input = run.agent === 'scout' ? `theme “${run.input.theme}”` : `budget $${run.input.budget_usd} a dinner`;
    $('outcome').replaceChildren(...[
      el('strong', { textContent: running ? `${NAMES[run.agent]} running…` : run.outcome || run.status }),
      el('span', { className: 'small muted', textContent: ` · ${run.group_name} · ${input}` }),
      run.summary ? el('span', { className: 'outcome-summary', textContent: run.summary }) : null,
      !running ? el('a', { href: `/coordinator?group=${encodeURIComponent(run.group_name)}`, className: 'small', textContent: 'See it on the Coordinator page' }) : null,
    ].filter(Boolean));
    $('outcome').className = `outcome ${running ? '' : run.status === 'done' ? 'good' : 'bad'}`;
  }
  async function follow(id) {
    clearTimeout(timer);
    const res = await api('GET', { id });
    if (!res.ok) { $('outcome').textContent = res.error; return; }
    render(res.body);
    if (res.body.status === 'running') timer = setTimeout(() => follow(id), 2000);
    else refreshOverview();
  }

  async function start(form, body) {
    const button = form.querySelector('button');
    button.disabled = true;
    const res = await api('POST', { body });
    button.disabled = false;
    if (!res.ok) { $('outcome').textContent = res.error; $('outcome').className = 'outcome bad'; return; }
    $('run').scrollIntoView({ behavior: 'smooth' });
    await refreshOverview();
    follow(res.body.id);
  }
  $('scout-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    start(e.target, { agent: 'scout', group: f.group.value, theme: f.theme.value });
  });
  $('planner-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    start(e.target, { agent: 'planner', group: f.group.value, budget_usd: Number(f.budget_usd.value), requirements: f.requirements.value, preferences: f.preferences.value });
  });

  if (key) signIn(key);
})();
