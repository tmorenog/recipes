// Shared behaviour for every page: the site address in prompts and examples,
// copy buttons, the group name, the class key check, and the setup status line.
(() => {
  'use strict';
  const SITE = location.origin;

  // "Before you start": the numbered list at the top of the Welcome page
  // (<section data-ready="welcome">).
  // Rendered first so the group box and key check below are wired up like any other.
  for (const box of document.querySelectorAll('[data-ready]')) {
    const page = ['welcome', 'scout', 'planner'].includes(box.dataset.ready) ? box.dataset.ready : 'welcome';
    const h = (tag, props = {}, ...kids) => {
      const n = Object.assign(document.createElement(tag), props);
      n.append(...kids.filter((k) => k != null));
      return n;
    };
    const item = (n, title, ...body) => h('li', { className: 'ready-item' },
      h('span', { className: 'ready-num', ariaHidden: 'true', textContent: String(n) }),
      h('div', {}, h('p', { className: 'ready-title' }, ...[].concat(title)), ...body));
    const lovable = h('a', { href: 'https://lovable.dev', target: '_blank', rel: 'noopener', textContent: 'Lovable' });
    box.className = 'ready';
    box.id = 'before-you-start';
    box.setAttribute('aria-labelledby', 'ready-heading');
    box.replaceChildren(
      h('h2', { id: 'ready-heading', textContent: 'Before you start' }),
      h('ol', { className: 'ready-list' },
        item(1, 'Work in groups of 2–3', h('p', { textContent: 'One person builds on their screen; everyone else watches the same screen and helps.' })),
        item(2, ['Open ', lovable, ' and log in']),
        item(3, 'Choose a unique group name',
          h('div', { className: 'group-box' },
            h('input', { className: 'group-input', id: `group-${page}`, type: 'text', placeholder: 'e.g. team-3', autocomplete: 'off', spellcheck: false, ariaLabel: 'Your group name' }),
            h('p', { className: 'group-note small', ariaLive: 'polite' })),
          h('p', { className: 'small muted', textContent: 'Use the same name for every agent you build. It labels everything your agents save, and the prompts fill it in.' })),
        item(4, 'Check the class key',
          h('form', { className: 'keycheck', id: 'keycheck', autocomplete: 'off' },
            h('input', { type: 'password', placeholder: 'Paste the class key', spellcheck: false, ariaLabel: 'Class key' }),
            h('button', { className: 'btn primary', type: 'submit', textContent: 'Check key' })),
          h('p', { className: 'keycheck-result', id: 'keycheck-result', ariaLive: 'polite' }),
          h('p', { className: 'small muted', textContent: 'The instructor will give you this key. In Lovable it goes into a secret, never into a prompt.' }))),
    );
  }

  // Collapsible steps (Recipe Scout and Meal Planner pages): the step title
  // opens and closes the step. The first step starts open; what a student
  // opens is remembered in this browser, and a link to a step opens it.
  const stepSections = [...document.querySelectorAll('section.step')];
  if (stepSections.length) {
    const memoryKey = `rc-steps:${location.pathname}`;
    let remembered = {};
    try { remembered = JSON.parse(localStorage.getItem(memoryKey)) || {}; } catch { /* storage unavailable */ }
    const remember = () => { try { localStorage.setItem(memoryKey, JSON.stringify(remembered)); } catch { /* ignore */ } };
    const setOpen = (sec, open) => {
      sec.classList.toggle('collapsed', !open);
      sec.querySelector(':scope > .step-title .step-toggle').setAttribute('aria-expanded', String(open));
      sec.querySelector(':scope > .step-body').hidden = !open;
    };
    stepSections.forEach((sec, i) => {
      const title = sec.querySelector(':scope > .step-title');
      if (!title) return;
      const body = document.createElement('div');
      body.className = 'step-body';
      body.id = `${sec.id || `step-${i}`}-body`;
      while (title.nextSibling) body.append(title.nextSibling);
      sec.append(body);
      const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'step-toggle' });
      toggle.setAttribute('aria-controls', body.id);
      toggle.append(...title.childNodes);
      title.append(toggle);
      toggle.addEventListener('click', () => {
        const open = sec.classList.contains('collapsed');
        setOpen(sec, open);
        remembered[sec.id] = open;
        remember();
      });
      setOpen(sec, remembered[sec.id] ?? i === 0);
    });
    const all = (open) => { for (const sec of stepSections) { setOpen(sec, open); remembered[sec.id] = open; } remember(); };
    const bar = document.createElement('p');
    bar.className = 'steps-bar small';
    bar.append(
      Object.assign(document.createElement('button'), { type: 'button', className: 'linklike', textContent: 'Open all steps', onclick: () => all(true) }),
      ' · ',
      Object.assign(document.createElement('button'), { type: 'button', className: 'linklike', textContent: 'Close all', onclick: () => all(false) }),
    );
    stepSections[0].before(bar);
    const openTarget = () => {
      let id = '';
      try { id = decodeURIComponent(location.hash.slice(1)); } catch { /* a malformed link */ }
      const target = id ? document.getElementById(id) : null;
      const sec = target?.closest('section.step');
      if (sec?.classList.contains('collapsed')) {
        setOpen(sec, true);
        target.scrollIntoView();
      }
    };
    window.addEventListener('hashchange', openTarget);
    openTarget();
  }

  // Collapsible sample prompts: "Sample prompt" in the prompt's header shows or
  // hides it, like the steps. Closed at first; remembered in this browser.
  // Copy prompt copies the whole prompt either way.
  const promptMemoryKey = `rc-prompts:${location.pathname}`;
  let promptsOpen = {};
  try { promptsOpen = JSON.parse(localStorage.getItem(promptMemoryKey)) || {}; } catch { /* storage unavailable */ }
  for (const body of document.querySelectorAll('.prompt-body[data-prompt]')) {
    const frame = body.closest('.prompt');
    const label = frame?.querySelector('.prompt-head .prompt-kind');
    if (!label) continue;
    const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'prompt-toggle' });
    toggle.setAttribute('aria-controls', body.id);
    toggle.append(...label.childNodes);
    label.append(toggle);
    // While the instructor edits the prompt, its editor stands in for the text.
    const setOpen = (open) => {
      frame.classList.toggle('collapsed', !open);
      toggle.setAttribute('aria-expanded', String(open));
      const editor = frame.querySelector('.prompt-editor');
      const editing = editor?.dataset.editing === '1';
      body.hidden = !open || editing;
      if (editor) editor.hidden = !open || !editing;
    };
    toggle.addEventListener('click', () => {
      const open = frame.classList.contains('collapsed');
      setOpen(open);
      promptsOpen[body.id] = open;
      try { localStorage.setItem(promptMemoryKey, JSON.stringify(promptsOpen)); } catch { /* ignore */ }
    });
    // The whole header bar opens and closes it too, except its other buttons.
    const head = label.closest('.prompt-head');
    head.classList.add('toggles');
    head.addEventListener('click', (e) => { if (!e.target.closest('button, a, input, textarea')) toggle.click(); });
    setOpen(promptsOpen[body.id] ?? false);
  }

  // Fill in this site's address ({{SITE}}) and the group's name ({{GROUP}})
  // wherever a page uses them. The group name is typed into a .group-input box
  // and remembered in this browser.
  const GROUP_KEY = 'rc-group-name';
  const PLACEHOLDER = 'YOUR-GROUP-NAME';
  const normalize = (raw) => {
    const name = String(raw || '').trim().toLowerCase().replace(/\s+/g, '-');
    return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(name) ? name : '';
  };
  let group = '';
  try { group = normalize(localStorage.getItem(GROUP_KEY)); } catch { /* storage unavailable */ }

  const slots = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (/\{\{(SITE|GROUP)\}\}/.test(n.nodeValue)) slots.push({ node: n, template: n.nodeValue });
  }
  const fill = () => {
    for (const { node, template } of slots) {
      node.nodeValue = template.replaceAll('{{SITE}}', SITE).replaceAll('{{GROUP}}', group || PLACEHOLDER);
    }
  };
  fill();
  // A name typed on the Welcome page in another tab reaches this one too.
  window.addEventListener('storage', (e) => {
    if (e.key !== GROUP_KEY) return;
    group = normalize(e.newValue);
    fill();
  });

  // Sample prompts: the text files under /prompts/ (<div data-prompt="/prompts/scout/step-2.txt" data-step="12">),
  // unless the instructor edited a step on the page; edits come from /api/prompts.
  const boxes = [...document.querySelectorAll('[data-prompt]')].map((box) => {
    // The instructor's edits are stored per step number: data-step when the
    // page gives one (files like step-3a.txt), otherwise the file's number.
    const [, agent, step] = box.dataset.prompt.match(/\/prompts\/(\w+)\/step-(\w+)\.txt$/) || [];
    const key = Number(box.dataset.step ?? step);
    return { box, agent, step: Number.isInteger(key) ? key : null, file: box.dataset.prompt, slot: null, template: null, edited: false };
  });
  const setPrompt = (p, template) => {
    p.template = template;
    const node = document.createTextNode(template);
    p.box.replaceChildren(node);
    if (p.slot) p.slot.node = node;
    else slots.push((p.slot = { node, template }));
    p.slot.template = template;
    fill();
  };
  const agents = [...new Set(boxes.map((p) => p.agent).filter(Boolean))];
  const editsFor = Object.fromEntries(agents.map((a) => [a, fetch(`/api/prompts?agent=${a}`, { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : { steps: {} }))
    .then((body) => body.steps || {})
    .catch(() => ({}))]));
  const loadPrompt = async (p) => {
    p.box.textContent = 'Loading the prompt…';
    const edit = p.agent && p.step ? (await editsFor[p.agent])[p.step] : undefined;
    if (edit) { p.edited = true; return setPrompt(p, edit.trim()); }
    p.edited = false;
    try {
      const res = await fetch(p.file, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      setPrompt(p, (await res.text()).trim());
    } catch {
      p.box.replaceChildren('This prompt didn’t load. Reload the page, or open ', Object.assign(document.createElement('a'), { href: p.file, textContent: p.file }), '.');
    }
  };
  const promptsLoaded = Promise.all(boxes.map(loadPrompt));

  // The instructor, signed in with the admin key (on the Admin or Pricer page,
  // kept for this browser tab), can edit each step's prompt here.
  let adminKey = '';
  try { adminKey = sessionStorage.getItem('rc-admin-key') || ''; } catch { /* storage unavailable */ }
  if (adminKey && boxes.some((p) => p.agent)) {
    Promise.all([promptsLoaded, fetch('/api/admin/check', { headers: { authorization: `Bearer ${adminKey}` }, cache: 'no-store' })])
      .then(([, res]) => { if (res.ok) boxes.filter((p) => p.agent && p.step).forEach(addEditor); })
      .catch(() => {});
  }

  function addEditor(p) {
    const frame = p.box.closest('.prompt');
    const head = frame?.querySelector('.prompt-head');
    if (!head) return;
    const make = (tag, props) => Object.assign(document.createElement(tag), props);
    // Relabel the text only: the label holds the button that opens and closes the prompt.
    const label = head.querySelector('.prompt-kind .prompt-toggle') ?? head.querySelector('.prompt-kind');
    const showLabel = () => { if (label) label.textContent = p.edited ? 'Sample prompt · edited by the instructor' : 'Sample prompt'; };
    showLabel();
    const editBtn = make('button', { type: 'button', className: 'btn', textContent: 'Edit' });
    head.querySelector('[data-copy]')?.before(editBtn);

    const area = make('textarea', { className: 'prompt-edit', rows: 12, spellcheck: true });
    const note = make('p', { className: 'small muted prompt-edit-note', textContent: 'Write {{SITE}} for this site’s address and {{GROUP}} for the group name; students see them filled in.' });
    const msg = make('span', { className: 'small', role: 'status' });
    const save = make('button', { type: 'button', className: 'btn primary', textContent: 'Save' });
    const reset = make('button', { type: 'button', className: 'btn', textContent: 'Back to the default' });
    const cancel = make('button', { type: 'button', className: 'btn', textContent: 'Cancel' });
    const bar = make('div', { className: 'prompt-edit-bar' });
    bar.append(save, reset, cancel, msg);
    const editor = make('div', { className: 'prompt-editor' });
    editor.append(area, note, bar);
    editor.hidden = true;
    p.box.after(editor);

    const open = (on) => {
      editor.dataset.editing = on ? '1' : '';
      editor.hidden = !on;
      p.box.hidden = on || Boolean(frame?.classList.contains('collapsed'));
      editBtn.hidden = on;
      reset.hidden = !p.edited;
      msg.textContent = '';
      if (on) { area.value = p.template || ''; area.focus(); }
    };
    const send = async (body) => {
      msg.textContent = 'Saving…';
      const res = await fetch('/api/prompts', {
        method: 'POST',
        headers: { authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ agent: p.agent, step: p.step, ...body }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { msg.textContent = (out.errors || [`HTTP ${res.status}`]).join(' '); msg.className = 'small bad'; return null; }
      msg.className = 'small';
      return out;
    };
    editBtn.addEventListener('click', () => open(true));
    cancel.addEventListener('click', () => open(false));
    save.addEventListener('click', async () => {
      const out = await send({ text: area.value });
      if (!out) return;
      p.edited = true;
      setPrompt(p, out.text);
      showLabel();
      open(false);
    });
    reset.addEventListener('click', async () => {
      if (!reset.dataset.armed) {
        reset.dataset.armed = '1';
        reset.textContent = 'Click again to go back to the text file';
        setTimeout(() => { delete reset.dataset.armed; reset.textContent = 'Back to the default'; }, 4000);
        return;
      }
      if (!(await send({ reset: true }))) return;
      editsFor[p.agent] = Promise.resolve({});
      await loadPrompt(p);
      showLabel();
      open(false);
    });
  }

  for (const a of document.querySelectorAll('a[href*="%7B%7BSITE%7D%7D"], a[href*="{{SITE}}"]')) {
    a.href = a.getAttribute('href').replace(/%7B%7BSITE%7D%7D|\{\{SITE\}\}/g, SITE);
  }

  // Group names already used by saved recipes or meal plans (fetched once).
  let usedGroups;
  const groupsInUse = () => {
    usedGroups ??= Promise.all([
      fetch('/api/recipes?status=all&limit=500', { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/meal-plans?limit=200', { cache: 'no-store' }).then((r) => r.json()),
    ]).then(([r, p]) => new Set([
      ...(r.recipes || []).flatMap((x) => (x.picked_by?.length ? x.picked_by : [x.group])),
      ...(p.plans || []).map((x) => x.group),
    ])).catch(() => null);
    return usedGroups;
  };

  for (const input of document.querySelectorAll('.group-input')) {
    const note = input.closest('.group-box')?.querySelector('.group-note');
    let timer;
    const show = () => {
      if (!note) return;
      note.className = 'group-note small';
      if (!group) {
        note.textContent = input.value.trim() ? 'Use letters, numbers and dashes, e.g. team-3.' : 'Type your group name; the prompts fill it in.';
        return;
      }
      note.textContent = `The prompts use “${group}”.`;
      // Is the name already taken? Only worth saying if another group might be using it.
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const used = await groupsInUse();
        if (!used || normalize(input.value) !== group) return;
        if (used.has(group)) {
          note.textContent = `“${group}” already has saved work on the Coordinator page. If that isn’t your group, choose another name.`;
          note.classList.add('warn');
        } else {
          note.textContent = `“${group}” is free, and the prompts use it.`;
          note.classList.add('ok');
        }
      }, 400);
    };
    input.value = group;
    show();
    input.addEventListener('input', () => {
      group = normalize(input.value);
      try { group ? localStorage.setItem(GROUP_KEY, group) : localStorage.removeItem(GROUP_KEY); } catch { /* ignore */ }
      for (const other of document.querySelectorAll('.group-input')) if (other !== input) other.value = input.value;
      fill();
      show();
    });
  }

  // Copy buttons: data-copy="<id of the element to copy>".
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const source = document.getElementById(btn.dataset.copy);
      const text = source.textContent.trim(); // the whole text, even when collapsed
      const label = btn.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(source);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = 'Selected: press Ctrl+C';
      }
      btn.classList.add('done');
      setTimeout(() => { btn.textContent = label; btn.classList.remove('done'); }, 2200);
    });
  }

  // Class key check (in "Before you start"). The key goes only to this site's /api/whoami.
  const form = document.getElementById('keycheck');
  if (form) {
    const input = form.querySelector('input');
    const out = document.getElementById('keycheck-result');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = input.value.trim();
      out.className = 'keycheck-result';
      if (!key) { out.textContent = 'Paste the class key first.'; out.classList.add('bad'); return; }
      out.textContent = 'Checking…';
      try {
        const res = await fetch('/api/whoami', { headers: { authorization: `Bearer ${key}` }, cache: 'no-store' });
        const body = await res.json();
        if (res.ok) {
          out.textContent = 'This key works.';
          out.classList.add('ok');
        } else {
          out.textContent = body.errors?.[0] || 'That isn’t the class key.';
          out.classList.add('bad');
        }
      } catch {
        out.textContent = 'Couldn’t reach the coordinator. Check your connection and try again.';
        out.classList.add('bad');
      }
      input.value = '';
    });
  }

  // The coordinator's current checks and limits, where a page lists them.
  const checksList = document.getElementById('plan-checks');
  if (checksList) {
    fetch('/api/settings', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body) return;
        checksList.replaceChildren(...body.plan_checks.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
        const s = body.settings;
        const limits = [s.max_plans_per_group > 0 && `at most ${s.max_plans_per_group} saved plans per group`, s.max_saves_per_minute > 0 && `at most ${s.max_saves_per_minute} save attempts a minute`].filter(Boolean);
        const note = document.getElementById('plan-limits');
        if (note) note.textContent = limits.length ? `Limits set by the instructor: ${limits.join('; ')}. Checking a draft is never limited.` : '';
      })
      .catch(() => {});
  }

  // Setup status line in the footer, mostly for the instructor.
  const strip = document.getElementById('status-strip');
  if (strip) {
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((h) => {
        const item = (ok, text) => Object.assign(document.createElement('span'), { className: ok ? 'ok' : 'bad', textContent: text });
        strip.replaceChildren(
          item(h.database === 'ready', h.database === 'ready' ? 'Database ready' : 'Database not ready'),
          item(h.class_key, h.class_key ? 'Class key set' : 'Class key not set'),
          item(h.kroger, h.kroger ? 'Kroger prices on' : 'Kroger prices off'),
        );
        if (!h.ok || h.warnings.length) strip.title = [...h.problems, ...h.warnings].join('\n');
      })
      .catch(() => { strip.textContent = ''; });
  }
})();
