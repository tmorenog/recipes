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

  // What's special about a line: estimated or substituted when priced; what the
  // Shopper Agent bought instead of the Pricer's products, or for several dinners.
  function labels(l) {
    const combined = l.instead_of?.length && new Set((l.used_for || []).map((u) => u.split(':')[0])).size > 1;
    const pill = (cls, text, title) => el('span', { className: `pill ${cls}`, textContent: text, title: title || '' });
    const note = (text) => el('span', { className: 'small muted line-note', textContent: text });
    return [
      l.estimated ? pill('estimated', 'Estimated', 'Not from Kroger: the Pricer Agent estimated this price') : null,
      l.stock_check ? pill('check-stock', 'Check stock', `${l.stock_check}. Kroger’s stock levels are rough and can be unreliable.`) : null,
      l.stock_check ? note(`${l.stock_check[0].toUpperCase()}${l.stock_check.slice(1)}.`) : null,
      l.availability === 'unavailable' ? pill('unavailable', 'Not carried', `At Kroger today: ${l.unavailable_reason || 'not carried'}`) : null,
      l.instead_of?.length ? pill('replaced', combined ? 'Combined' : 'Replacement', combined ? 'One product for several dinners' : 'Not the Pricer’s product') : null,
      l.instead_of?.length ? note(`Instead of ${l.instead_of.join(', ')}.${l.note ? ` ${l.note[0].toUpperCase()}${l.note.slice(1)}` : ''}`) : null,
      l.replaces ? pill('replaced', 'Replacement') : null,
      l.replaces ? note(`Instead of ${l.replaces.description}${l.replaces.size ? ` (${l.replaces.size})` : ''}: ${l.replaces.why}.${l.replacement_reason ? ` ${l.replacement_reason[0].toUpperCase()}${l.replacement_reason.slice(1)}` : ''}`) : null,
      l.substitutes?.length ? pill('substitute', 'Substitute') : null,
      l.substitutes?.length ? note(l.substitutes.join('; ')) : null,
    ];
  }

  // The class's plan, in reading order: the week, day by day; who planned it;
  // folds for the shopping cart and what the Meal Planner Agent said; and why
  // the Shopper Agent chose it.
  window.shoppingPlan = (choice) => {
    const { plan, cart } = choice;
    const perDinner = plan.meals.length ? plan.total_cost_usd / plan.meals.length : null;
    const checks = plan.rule_checks || [];
    const passed = checks.filter((c) => c.passed).length;

    const week = el('ol', { className: 'week' }, plan.meals.map((m) => el('li', { className: 'week-day' },
      el('span', { className: 'week-dayname', textContent: m.day }),
      /^https:\/\//.test(m.image_url || '') ? el('img', { src: m.image_url, alt: '', loading: 'lazy' }) : el('span', { className: 'ph' }),
      el('span', { className: 'week-recipe' },
        el('strong', { textContent: m.name }),
        el('span', { className: 'small muted', textContent: [m.cuisine, `${money(m.cost_per_serving_usd)} a serving`, m.picked_by?.length ? `picked by ${m.picked_by.join(', ')}` : null].filter(Boolean).join(' · ') })))));

    const planner = el('div', { className: 'planned-by' },
      el('div', {},
        el('span', { className: 'planned-by-label', textContent: 'Planned by' }),
        el('span', { className: 'planned-by-group', textContent: plan.group_name }),
        el('span', { className: 'small muted', textContent: `their Meal Planner Agent saved the plan ${when(plan.created_at)}` })),
      el('div', { className: 'planned-by-facts' },
        el('span', {}, el('strong', { textContent: money(plan.total_cost_usd) }), ' per person for the week'),
        perDinner != null ? el('span', {}, el('strong', { textContent: money(perDinner) }), ` a dinner${plan.budget_usd != null ? ` (budget ${money(plan.budget_usd)})` : ''}`) : null,
        checks.length ? el('span', {}, el('strong', { textContent: `${passed} of ${checks.length}` }), ' checks passed') : null));

    const said = el('details', { className: 'plan-fold', 'data-fold': 'planner' },
      el('summary', {}, 'What the Meal Planner Agent said about the plan'),
      plan.summary ? el('p', { textContent: plan.summary }) : null,
      el('ul', { className: 'plan-whys' }, plan.meals.filter((m) => m.why).map((m) => el('li', {}, el('strong', { textContent: `${m.day}: ` }), m.why))),
      checks.length ? el('ul', { className: 'plan-checks small' }, checks.map((c) => el('li', { className: c.passed ? 'good' : 'bad' }, `${c.passed ? '✓' : '✗'} ${c.rule}${c.detail ? `: ${c.detail}` : ''}`))) : null);

    const rows = cart.lines.map((l) => el('tr', {},
      el('td', { className: 'cart-product' }, thumb(l), el('span', {}, l.description, ...labels(l))),
      el('td', { textContent: l.size || '' }),
      el('td', { className: 'num', textContent: String(l.packages) }),
      el('td', { className: 'num' }, money(l.price_usd), l.priced_at_usd != null ? el('span', { className: 'small muted line-note', textContent: `was ${money(l.priced_at_usd)}`, title: 'The Recipe Pricer’s price; this is Kroger’s today' }) : null),
      el('td', { className: 'num', textContent: money(l.cost_usd) }),
      el('td', { className: 'small muted', textContent: l.used_for.join('; ') })));
    const shopping = el('details', { className: 'plan-fold', 'data-fold': 'cart' },
      el('summary', {}, `The shopping cart${cart.people ? ` for ${cart.people} people` : ''}: ${money(cart.total_usd)}`,
        el('span', { className: 'small muted', textContent: ` · ${cart.lines.length} products at Kroger` })),
      cart.people ? el('p', { className: 'small', textContent: `That’s ${money(cart.total_usd / cart.people)} a person, a little more than the plan’s ${money(plan.total_cost_usd)}, because packages are bought whole.` }) : null,
      cart.kroger_check ? el('p', { className: 'small', textContent: `${cart.kroger_check}${cart.checked_at ? ` (${when(cart.checked_at)})` : ''}` }) : null,
      el('p', { className: 'small muted', textContent: `${cart.note}${cart.estimated_lines ? ` ${cart.estimated_lines} price${cart.estimated_lines === 1 ? ' is' : 's are'} estimated: Kroger had no match.` : ''}` }),
      el('div', { className: 'table-wrap' }, el('table', { className: 'cart-table' },
        el('thead', {}, el('tr', {}, ...['Product', 'Size', 'Packages', 'Price', 'Cost', 'Used for'].map((h) => el('th', { textContent: h })))),
        el('tbody', {}, rows),
        el('tfoot', {}, el('tr', {}, el('th', { textContent: 'Total', colSpan: 4 }), el('th', { className: 'num', textContent: money(cart.total_usd) }), el('th', {}))))));

    return el('article', { className: `plan class-plan${choice.status === 'historical' ? ' historical' : ''}`, 'data-key': choice.id },
      el('p', { className: 'small muted class-plan-status' },
        choice.status ? el('span', { className: `pill plan-status ${choice.status}`, textContent: choice.status === 'active' ? 'Active' : 'An earlier choice' }) : null,
        ` Chosen by the Shopper Agent ${when(choice.created_at)}`),
      week,
      planner,
      el('div', { className: 'plan-folds' }, shopping, said),
      el('div', { className: 'why-chosen' },
        el('h4', { textContent: 'Why the Shopper Agent chose it' }),
        el('blockquote', { className: 'choice-reason', textContent: choice.reason })));
  };
})();
