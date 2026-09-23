// Shared behaviour for every page: the site address in prompts and examples,
// copy buttons, the group name, the class key check, and the setup status line.
(() => {
  'use strict';
  const SITE = location.origin;

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
  for (const a of document.querySelectorAll('a[href*="%7B%7BSITE%7D%7D"], a[href*="{{SITE}}"]')) {
    a.href = a.getAttribute('href').replace(/%7B%7BSITE%7D%7D|\{\{SITE\}\}/g, SITE);
  }

  for (const input of document.querySelectorAll('.group-input')) {
    const note = input.closest('.group-box')?.querySelector('.group-note');
    const show = () => {
      if (!note) return;
      note.textContent = group
        ? `The prompts below use “${group}”.`
        : input.value.trim() ? 'Use letters, numbers and dashes, e.g. team-3.' : 'Type your group name and the prompts below fill it in.';
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
      const text = source.innerText.trim();
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

  // Class key check (Welcome page). The key goes only to this site's /api/whoami.
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
