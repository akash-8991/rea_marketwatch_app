/* Development helper: finds layout breakage on the page that is currently open, at the current window size. Run after (0,eval)(await (await fetch('/_seed/layout-check.js')).text()).
 *   await __layoutCheck(['#/', '#/watchlist', ...])  ->  { '#/': [issues...] }   (an empty list means nothing was found)
 * It looks for: sideways page scroll, elements poking out of the window that no scroll box contains, controls whose text wraps onto several lines, text clipped
 * without an ellipsis, overlapping neighbours in the top bar, a sticky header taller than a third of the window, and tap targets under 44 px on touch widths. */
window.__layoutCheck = async (routes, { settle = 1500 } = {}) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms)), out = {}, W = innerWidth, H = innerHeight;
  const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(o.overflowX) && p.scrollWidth <= p.clientWidth + 1 ? false : /(auto|scroll|hidden|clip)/.test(o.overflowX)) return true; } return false; };
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  for (const route of routes) {
    const [hash, action] = Array.isArray(route) ? route : [route, null];
    if (location.hash !== hash) { location.hash = hash; await wait(settle); } else await wait(200);
    if (action) { await action(); await wait(600); }
    const issues = [];
    const cw = Math.max(...[...document.querySelectorAll('header.top, main, footer, .content')].map((e) => e.getBoundingClientRect().right)); if (cw > W + 1) issues.push(`page content is wider than the window: ${Math.round(cw)}px in a ${W}px window`);
    const seen = new Set();
    document.querySelectorAll('body *').forEach((el) => {
      if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') return;
      if (el.closest('nav.main') && matchMedia('(max-width: 860px)').matches && document.getElementById('nav').dataset.open !== 'true') return;   // the closed slide-in menu is off screen on purpose
      if ((r.right > W + 1 || r.left < -1) && !clipped(el) && !el.closest('.sr-only, .skip, svg, dialog:not([open]), .toasts:empty')) { const n = name(el); if (!seen.has(n)) { seen.add(n); issues.push(`pokes out of the window: ${n} (${Math.round(r.left)}..${Math.round(r.right)} of ${W})`); } }
      if (/^(BUTTON|A)$/.test(el.tagName) && el.closest('#app, header.top') && !el.closest('nav.main, .tick, .list, .sr-only') && r.height > 1.9 * parseFloat(cs.lineHeight || 20) + 12 && el.textContent.trim().length > 0 && !el.classList.contains('logo')) issues.push(`control wraps onto ${Math.round(r.height / parseFloat(cs.lineHeight || 20))} lines: ${name(el)} "${el.textContent.trim().slice(0, 30)}"`);
      if (cs.overflow === 'hidden' && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2 && !el.closest('.sr-only') && el.children.length === 0 && el.textContent.trim() && !/(INPUT|SELECT)/.test(el.tagName)) issues.push(`text clipped without an ellipsis: ${name(el)} "${el.textContent.trim().slice(0, 24)}"`);
    });
    const top = [...document.querySelectorAll('header.top .bar > *')].filter((e) => e.offsetParent && e.getBoundingClientRect().width);
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) { const a = top[i].getBoundingClientRect(), b = top[j].getBoundingClientRect(); if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) issues.push(`top bar items overlap: ${name(top[i])} and ${name(top[j])}`); }
    const hd = document.querySelector('header.top'); if (hd && hd.getBoundingClientRect().height > H / 3) issues.push(`sticky header takes ${Math.round(hd.getBoundingClientRect().height)}px of a ${H}px window`);
    if (matchMedia('(pointer: coarse)').matches) document.querySelectorAll('#app button, #app select, #app input:not([type=checkbox]):not([type=radio]), header.top button').forEach((el) => { const r = el.getBoundingClientRect(); if (el.offsetParent && (r.height < 43 || (r.width < 43 && !/INPUT|SELECT/.test(el.tagName)))) issues.push(`tap target ${Math.round(r.width)}x${Math.round(r.height)}: ${name(el)}`); });
    out[hash + (action ? ' (state)' : '')] = [...new Set(issues)].slice(0, 12);
  }
  return out;
};
