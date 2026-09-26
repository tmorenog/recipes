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
  const money = (n) => (n == null ? '–' : `$${Number(n).toFixed(2)}`);
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // ---------------------------------------------------------------- the class's plan
  function renderChoice(choice) {
    if (!choice?.plan) {
      $('choice').replaceChildren(el('p', { className: 'empty small', textContent: 'No plan chosen yet. The instructor runs the Shopper Agent once the Planner Agents have saved their plans.' }));
      return;
    }
    const { plan, cart } = choice;
    const perDinner = plan.meals.length ? plan.total_cost_usd / plan.meals.length : null;
    const dinners = el('ul', { className: 'meals' }, plan.meals.map((m) => el('li', { className: 'meal' },
      /^https:\/\//.test(m.image_url || '') ? el('img', { src: m.image_url, alt: '', loading: 'lazy' }) : el('span', { className: 'ph' }),
      el('div', {},
        el('div', { className: 'day', textContent: m.day }),
        el('div', { className: 'mname', textContent: m.name }),
        el('div', { className: 'mfacts', textContent: [`${money(m.cost_per_serving_usd)}/serving`, m.cuisine].filter(Boolean).join(' · ') }),
        m.picked_by?.length ? el('div', { className: 'mby', textContent: `Picked by ${m.picked_by.length} group${m.picked_by.length === 1 ? '' : 's'}: ${m.picked_by.join(', ')}` }) : null))));
    const rows = cart.lines.map((l) => el('tr', {},
      el('td', {}, l.description, l.estimated ? el('span', { className: 'pill estimated', textContent: 'Estimated', title: 'Not from Kroger: the Pricer Agent estimated this price' }) : null),
      el('td', { textContent: l.size || '' }),
      el('td', { className: 'num', textContent: String(l.packages) }),
      el('td', { className: 'num', textContent: money(l.price_usd) }),
      el('td', { className: 'num', textContent: money(l.cost_usd) }),
      el('td', { className: 'small muted', textContent: l.used_for.join('; ') })));
    $('choice').replaceChildren(el('article', { className: 'plan class-plan' },
      el('div', { className: 'plan-head' },
        el('div', {}, el('strong', { textContent: `${plan.group_name}’s plan` }), el('span', { className: 'small muted', textContent: ` · chosen ${when(choice.created_at)}` })),
        el('span', { className: 'plan-total' }, money(plan.total_cost_usd),
          el('small', { textContent: [`per person for the week`, perDinner != null ? `${money(perDinner)} a dinner` : null, plan.budget_usd != null ? `budget ${money(plan.budget_usd)} a dinner` : null].filter(Boolean).join(' · ') }))),
      el('blockquote', { className: 'choice-reason', textContent: choice.reason }),
      dinners,
      el('h3', { textContent: `The Kroger cart${cart.people ? ` for ${cart.people} people` : ''}: ${money(cart.total_usd)}` }),
      el('p', { className: 'small muted', textContent: `${cart.note}${cart.estimated_lines ? ` ${cart.estimated_lines} price${cart.estimated_lines === 1 ? ' is' : 's are'} estimated: Kroger had no match.` : ''}` }),
      el('div', { className: 'table-wrap' }, el('table', { className: 'cart-table' },
        el('thead', {}, el('tr', {}, ...['Product', 'Size', 'Packages', 'Price', 'Cost', 'Used for'].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, rows),
        el('tfoot', {}, el('tr', {}, el('th', { textContent: 'Total', colSpan: 4 }), el('th', { className: 'num', textContent: money(cart.total_usd) }), el('th', {})))))));
  }

  // ---------------------------------------------------------------- the latest run
  function describe(s) {
    if (s.kind === 'tool_call') return `→ ${s.tool} ${JSON.stringify(s.input ?? {}).slice(0, 140)}`;
    if (s.kind === 'tool_result') return `← ${s.tool}: ${s.text}`;
    if (s.kind === 'error') return `${s.tool ? `✗ ${s.tool}: ` : ''}${s.text}`;
    return s.text;
  }
  function renderRun(run) {
    if (!run) {
      $('now').replaceChildren(el('span', { className: 'dot' }), 'Idle: not run yet.');
      $('feed').replaceChildren(el('li', { className: 'muted small', textContent: 'The Shopper Agent’s steps appear here while it runs.' }));
      return false;
    }
    const running = run.status === 'running';
    $('now').replaceChildren(el('span', { className: `dot${running ? ' on' : ''}` }), running ? `Working: ${run.actions} action${run.actions === 1 ? '' : 's'} so far.` : `Last run ${when(run.created_at)}: ${run.actions} actions.`);
    $('feed').replaceChildren(...[...run.steps].reverse().map((s) => el('li', { className: `feed-${s.kind === 'tool_call' || s.kind === 'tool_result' ? 'tool' : s.kind}` },
      el('span', { className: 'feed-time', textContent: time(s.at) }), el('span', { className: 'feed-what', textContent: describe(s) }))));
    $('outcome').replaceChildren(el('strong', { textContent: running ? 'Running…' : run.outcome || run.status }), run.summary ? el('span', { className: 'outcome-summary', textContent: run.summary }) : null);
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
      renderChoice(body.choice);
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
    $('run').addEventListener('click', async () => {
      $('run').disabled = true;
      $('run-msg').textContent = 'Starting…';
      const res = await fetch('/api/admin/agent-runs', {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'shopper' }),
      });
      const body = await res.json().catch(() => ({}));
      $('run-msg').textContent = res.ok ? 'Running: follow it below.' : (body.errors || [`HTTP ${res.status}`]).join(' ');
      if (!res.ok) $('run').disabled = false;
      load();
    });
  }
  load();
})();
