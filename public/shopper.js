// Shopper page: the class's plan (the Shopper Agent's choice) with its Kroger
// cart, and the agent's latest run. The instructor, signed in, can run it.
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
      $('choice').replaceChildren(el('p', { className: 'empty small', textContent: 'No plan chosen yet. The instructor runs the Shopper Agent once the Planner Agents have saved their plans.' }));
      return;
    }
    $('choice').replaceChildren(...[window.shoppingPlan(choice),
      history?.length ? el('p', { className: 'small' }, `${history.length} earlier choice${history.length === 1 ? '' : 's'}: `, el('a', { href: '/coordinator?view=shopping', textContent: 'see them on the Coordinator page' }), '.') : null].filter(Boolean));
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

  // ---------------------------------------------------------------- the instructor
  if (key) {
    $('run-panel').hidden = false;
    const clear = $('clear');
    const label = clear.textContent;
    clear.addEventListener('click', async () => {
      if (!clear.dataset.armed) {
        clear.dataset.armed = '1';
        clear.textContent = clear.dataset.confirm;
        setTimeout(() => { delete clear.dataset.armed; clear.textContent = label; }, 4000);
        return;
      }
      delete clear.dataset.armed;
      clear.textContent = label;
      const res = await fetch('/api/admin/clear-choices', { method: 'POST', headers: { authorization: `Bearer ${key}` } });
      const body = await res.json().catch(() => ({}));
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
      $('run-msg').textContent = res.ok ? 'Running: follow it below.' : (body.errors || [`HTTP ${res.status}`]).join(' ');
      if (!res.ok) $('run').disabled = false;
      load();
    });
  }
  load();
})();
