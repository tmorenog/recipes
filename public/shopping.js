// Draws one shopping plan (the Shopper Agent's choice): who created the plan,
// why it was chosen, its dinners and its Kroger cart. Used by the Shopper
// page and the Coordinator page's Shopping tab: window.shoppingPlan(choice).
(() => {
  'use strict';
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) if (k.includes('-')) node.setAttribute(k, v); else node[k] = v;
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  };
  const money = (n) => (n == null ? '–' : `$${Number(n).toFixed(2)}`);
  const when = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  // A small picture of each product: Kroger's photo, else TheMealDB's picture of
  // the ingredient (for estimated prices and carts saved before photos were kept),
  // else nothing.
  const INGREDIENT_IMG = (name) => `https://www.themealdb.com/images/ingredients/${encodeURIComponent(name.trim().replace(/\b\w/g, (c) => c.toUpperCase()))}-Small.png`;
  function thumb(l) {
    const ingredient = (l.used_for?.[0] || '').split(': ').slice(1).join(': ');
    const last = ingredient.split(',')[0].split(/\s+/).filter(Boolean).pop() || '';
    const sources = [...new Set([/^https:\/\//.test(l.image_url || '') ? l.image_url : null,
      ingredient ? INGREDIENT_IMG(ingredient.split(',')[0]) : null, last ? INGREDIENT_IMG(last) : null].filter(Boolean))];
    const box = el('span', { className: 'cart-thumb', 'aria-hidden': 'true' });
    if (!sources.length) return box;
    const img = el('img', { src: sources.shift(), alt: '', loading: 'lazy' });
    img.addEventListener('error', () => { if (sources.length) img.src = sources.shift(); else img.remove(); });
    box.append(img);
    return box;
  }

  window.shoppingPlan = (choice) => {
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
      el('td', { className: 'cart-product' }, thumb(l), el('span', {}, l.description, l.estimated ? el('span', { className: 'pill estimated', textContent: 'Estimated', title: 'Not from Kroger: the Pricer Agent estimated this price' }) : null)),
      el('td', { textContent: l.size || '' }),
      el('td', { className: 'num', textContent: String(l.packages) }),
      el('td', { className: 'num', textContent: money(l.price_usd) }),
      el('td', { className: 'num', textContent: money(l.cost_usd) }),
      el('td', { className: 'small muted', textContent: l.used_for.join('; ') })));
    return el('article', { className: `plan class-plan${choice.status === 'historical' ? ' historical' : ''}`, 'data-key': choice.id },
      el('div', { className: 'plan-head' },
        el('div', {},
          choice.status ? el('span', { className: `pill plan-status ${choice.status}`, textContent: choice.status === 'active' ? 'Active shopping plan' : 'Earlier choice' }) : null,
          el('strong', { textContent: ` Created by ${plan.group_name}` }),
          el('span', { className: 'small muted', textContent: ` · their Planner Agent saved it ${when(plan.created_at)} · chosen ${when(choice.created_at)}` })),
        el('span', { className: 'plan-total' }, money(plan.total_cost_usd),
          el('small', { textContent: ['per person for the week', perDinner != null ? `${money(perDinner)} a dinner` : null, plan.budget_usd != null ? `budget ${money(plan.budget_usd)} a dinner` : null].filter(Boolean).join(' · ') }))),
      el('blockquote', { className: 'choice-reason', textContent: choice.reason }),
      dinners,
      el('h3', { textContent: `Shopping list: the Kroger cart${cart.people ? ` for ${cart.people} people` : ''}, ${money(cart.total_usd)}` }),
      cart.people ? el('p', { className: 'small', textContent: `Per person, the plan costs ${money(plan.total_cost_usd)} for the week (each dinner pays for the share of each package it uses). Shopping for ${cart.people} people, the cart comes to ${money(cart.total_usd / cart.people)} each, because packages are bought whole.` }) : null,
      el('p', { className: 'small muted', textContent: `${cart.note}${cart.estimated_lines ? ` ${cart.estimated_lines} price${cart.estimated_lines === 1 ? ' is' : 's are'} estimated: Kroger had no match.` : ''}` }),
      el('div', { className: 'table-wrap' }, el('table', { className: 'cart-table' },
        el('thead', {}, el('tr', {}, ...['Product', 'Size', 'Packages', 'Price', 'Cost', 'Used for'].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, rows),
        el('tfoot', {}, el('tr', {}, el('th', { textContent: 'Total', colSpan: 4 }), el('th', { className: 'num', textContent: money(cart.total_usd) }), el('th', {}))))));
  };
})();
