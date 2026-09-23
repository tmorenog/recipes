// Shared behaviour for every page: the site address in prompts and examples,
// copy buttons, the group key check, and the setup status line.
(() => {
  'use strict';
  const SITE = location.origin;

  // Fill in this site's real address wherever a page says {{SITE}}.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.includes('{{SITE}}')) n.nodeValue = n.nodeValue.replaceAll('{{SITE}}', SITE);
  }
  for (const a of document.querySelectorAll('a[href*="%7B%7BSITE%7D%7D"], a[href*="{{SITE}}"]')) {
    a.href = a.getAttribute('href').replace(/%7B%7BSITE%7D%7D|\{\{SITE\}\}/g, SITE);
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

  // Group key check (Welcome page). The key goes only to this site's /api/whoami.
  const form = document.getElementById('keycheck');
  if (form) {
    const input = form.querySelector('input');
    const out = document.getElementById('keycheck-result');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = input.value.trim();
      out.className = 'keycheck-result';
      if (!key) { out.textContent = 'Paste your group key first.'; out.classList.add('bad'); return; }
      out.textContent = 'Checking…';
      try {
        const res = await fetch('/api/whoami', { headers: { authorization: `Bearer ${key}` }, cache: 'no-store' });
        const body = await res.json();
        if (res.ok) {
          out.textContent = `This key works. It belongs to “${body.group}”.`;
          out.classList.add('ok');
        } else {
          out.textContent = body.errors?.[0] || 'That key doesn’t match any group.';
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
          item(h.groups.length > 0, `${h.groups.length} group${h.groups.length === 1 ? '' : 's'} set up`),
          item(h.kroger, h.kroger ? 'Kroger prices on' : 'Kroger prices off'),
        );
        if (!h.ok || h.warnings.length) strip.title = [...h.problems, ...h.warnings].join('\n');
      })
      .catch(() => { strip.textContent = ''; });
  }
})();
