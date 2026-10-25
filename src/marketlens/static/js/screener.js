/* Stock screener view (lazy-loaded ES module). Layout: filter chips with popovers, view tabs, column chooser, sortable
 * sticky-header table, pagination, saved screens, CSV export, and the plain-language rules at the bottom. */
import { $, $$, esc, money, signed, cls, arrow, chgPct, pos52, compact, symLink, secTag, store, api, debounce, icon, badge, toneKind, sparkline, skeleton, emptyState, errorState, safeUrl } from './lib.js';

const KEY = 'ml.screener2', SAVED = 'ml.screens2';
// A factory, not a shared object: nested filter maps are mutated in place, so every state must own its own copies.
const blank = () => ({ q: '', num: {}, sel: {}, view: 'overview', cols: {}, sort: { key: 'turn', dir: -1 }, page: 0, size: 25 });
const NUM_FILTERS = [['price', 'Price'], ['chg', 'Change %'], ['turn', 'Turnover ₹ cr'], ['p30', '30-day %'], ['pos', '52-week position %'], ['div', 'Dividend yield %']];
const SEL_FILTERS = [['sector', 'Sector'], ['tech', 'Technical'], ['sentL', 'Sentiment'], ['income', 'Income view']];
const OPTIONS = { tech: ['Bullish', 'Neutral', 'Bearish'], sentL: ['Positive', 'Neutral', 'Negative'], income: ['Income-oriented', 'Moderate income', 'Little or no dividend income'] };
const VIEWS = {
  overview: ['price', 'chg', 'vol', 'turn', 'p30', 'pos', 'div', 'sector', 'tech', 'sentL'],
  performance: ['price', 'chg', 'p30', 'fromHi', 'fromLo', 'pos', 'spark'],
  technicals: ['price', 'chg', 'tech', 'techScore', 'rsi', 'sma20', 'sma50', 'macd'],
  sentiment: ['price', 'chg', 'sentL', 'sentScore', 'sentN', 'headline'],
  dividends: ['price', 'div', 'divTtm', 'divYears', 'income', 'secYield'],
};
const pctCell = (v) => (v == null ? '—' : `<span class="${cls(v)}">${signed(v)}%</span>`);
const COLS = {
  price: { label: 'Price', num: true, html: (r) => `<span data-px="${esc(r.sym)}">${money(r.price)}</span>`, csv: (r) => r.price },
  chg: { label: 'Change %', num: true, html: (r) => `<span data-chg="${esc(r.sym)}"></span>`, csv: (r) => +r.chg.toFixed(2) },
  vol: { label: 'Volume', num: true, html: (r) => compact(r.vol), csv: (r) => r.vol },
  turn: { label: 'Turnover ₹ cr', num: true, html: (r) => money(r.turn, 0), csv: (r) => r.turn },
  p30: { label: '30-day %', num: true, html: (r) => pctCell(r.p30), csv: (r) => r.p30 },
  pos: { label: '52w position', num: true, html: (r) => (r.pos == null ? '—' : `<span class="meter" title="${r.pos.toFixed(0)}% of the 52-week range"><i style="width:${r.pos}%"></i></span> ${r.pos.toFixed(0)}%`), csv: (r) => r.pos },
  fromHi: { label: 'From 52w high', num: true, html: (r) => pctCell(r.fromHi), csv: (r) => r.fromHi },
  fromLo: { label: 'From 52w low', num: true, html: (r) => pctCell(r.fromLo), csv: (r) => r.fromLo },
  div: { label: 'Div yield %', num: true, html: (r) => (r.div == null ? '<span class="muted" title="Corporate-action data not loaded yet">…</span>' : r.div.toFixed(2)), csv: (r) => r.div },
  divTtm: { label: 'Dividends 12m ₹', num: true, html: (r) => (r.divTtm == null ? '—' : money(r.divTtm)), csv: (r) => r.divTtm },
  divYears: { label: 'Dividend years (of 3)', num: true, html: (r) => r.divYears ?? '—', csv: (r) => r.divYears },
  secYield: { label: 'Sector index yield %', num: true, html: (r) => r.secYield ?? '—', csv: (r) => r.secYield },
  sector: { label: 'Sector', html: (r) => esc(r.sector === 'Other' ? '—' : r.sector), csv: (r) => r.sector },
  tech: { label: 'Technical', html: (r) => (r.tech ? badge(r.tech + (r.techFull ? '' : '*'), r.techTip, toneKind(r.tech)) : '—'), csv: (r) => r.tech },
  techScore: { label: 'Tech score', num: true, html: (r) => (r.techScore == null ? '—' : r.techScore.toFixed(2)), csv: (r) => r.techScore },
  rsi: { label: 'RSI (14)', num: true, html: (r) => r.rsi ?? '—', csv: (r) => r.rsi },
  sma20: { label: 'SMA 20', num: true, html: (r) => (r.sma20 == null ? '—' : money(r.sma20)), csv: (r) => r.sma20 },
  sma50: { label: 'SMA 50', num: true, html: (r) => (r.sma50 == null ? '—' : money(r.sma50)), csv: (r) => r.sma50 },
  macd: { label: 'MACD hist', num: true, html: (r) => r.macd ?? '—', csv: (r) => r.macd },
  sentL: { label: 'Sentiment', html: (r) => (r.sentL ? (r.sentN ? badge(r.sentL, r.sentTip, toneKind(r.sentL)) : '<span class="muted" title="No recent headlines found">No news</span>') : '<span class="muted">…</span>'), csv: (r) => r.sentL },
  sentScore: { label: 'Sentiment score', num: true, html: (r) => (r.sentScore == null ? '—' : r.sentScore.toFixed(2)), csv: (r) => r.sentScore },
  sentN: { label: 'Headlines (+ / −)', num: true, html: (r) => (r.sentN ? `${r.sentN} (<span class="up">${r.sentPos}</span> / <span class="down">${r.sentNeg}</span>)` : '—'), csv: (r) => r.sentN },
  headline: { label: 'Latest headline', html: (r) => (r.headline ? `<a class="headline" href="${esc(safeUrl(r.headline.link))}" target="_blank" rel="noopener noreferrer">${esc(r.headline.title)}</a>` : '—'), csv: (r) => r.headline?.title },
  income: { label: 'Income view', html: (r) => (r.income ? badge(r.income, r.incTip, toneKind(r.income)) : '<span class="muted" title="Corporate-action data not loaded yet">…</span>'), csv: (r) => r.income },
  spark: { label: '1-month trend', html: (r) => sparkline(r.spark, 90, 24), csv: () => '' },
};
const SORTERS = { sector: 'sector', tech: 'techScore', sentL: 'sentScore', income: 'divYears', spark: 'p30', headline: 'sentScore' };

let D, ctx, host, st, rules, popFor = null;

const rowOf = (s) => {
  const t = s.tech || s.techSnap, f = s.fund, v = D.sentiment && D.sentiment[s.sym];
  return {
    s, sym: s.sym, sector: s.sector, price: s.price, chg: chgPct(s), vol: s.volume, turn: s.valueCr, p30: s.pct30, pos: pos52(s),
    fromHi: s.hi52 ? (s.price / s.hi52 - 1) * 100 : null, fromLo: s.lo52 ? (s.price / s.lo52 - 1) * 100 : null,
    div: s.div, divTtm: s.divTtm, divYears: f && f.score != null ? f.dividendYears : null, income: f && f.score != null ? f.label : null,
    incTip: f ? `${f.basis}. ${f.signals.map((g) => g.note).join('; ')}` : '', secYield: f ? f.sectorYield : null,
    tech: t ? t.label : null, techScore: t ? t.score : null, techFull: !!s.tech, rsi: t ? t.rsi : null, sma20: t ? t.sma20 : null, sma50: t ? t.sma50 : null, macd: t ? t.macdHist : null,
    techTip: t ? `${t.basis}. ${t.signals.map((g) => g.note).join('; ')}` : '',
    sentL: v ? v.label : null, sentScore: v ? v.score : null, sentN: v ? v.n : null, sentPos: v ? v.pos : 0, sentNeg: v ? v.neg : 0, headline: v && v.top && v.top[0],
    sentTip: v ? `${v.n} headlines, ${v.pos} positive, ${v.neg} negative. ${(v.top || []).map((h) => h.title).join(' | ')}` : '', spark: s.spark,
  };
};

const load = () => { const s = store.get(KEY, null) || {}, b = blank(); return { ...b, ...s, num: { ...b.num, ...(s.num || {}) }, sel: { ...b.sel, ...(s.sel || {}) }, cols: { ...b.cols, ...(s.cols || {}) }, sort: { ...b.sort, ...(s.sort || {}) } }; };
const save = () => store.set(KEY, st);
const cols = () => (st.cols[st.view] || VIEWS[st.view]).filter((k) => COLS[k]);

function filtered() {
  const q = st.q.trim().toUpperCase();
  return D.stocks.map(rowOf).filter((r) => {
    if (q && !r.sym.includes(q)) return false;
    for (const [k] of NUM_FILTERS) {
      const [lo, hi] = st.num[k] || [];
      if ((lo != null || hi != null) && (r[k] == null || (lo != null && r[k] < lo) || (hi != null && r[k] > hi))) return false;
    }
    for (const [k] of SEL_FILTERS) { const a = st.sel[k]; if (a && a.length && !a.includes(r[k])) return false; }
    return true;
  });
}
function sorted(rows) {
  const key = SORTERS[st.sort.key] || st.sort.key, d = st.sort.dir;
  return [...rows].sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d;
  });
}

/* ---------- chips ---------- */
function chipSummary(kind, key, label) {
  if (kind === 'num') { const [lo, hi] = st.num[key] || []; if (lo == null && hi == null) return label; return `${label} ${lo != null && hi != null ? `${lo} – ${hi}` : lo != null ? `≥ ${lo}` : `≤ ${hi}`}`; }
  const a = st.sel[key] || []; return a.length ? `${label}: ${a.length > 2 ? `${a.length} selected` : a.map((x) => (x.length > 14 ? x.slice(0, 13) + '…' : x)).join(', ')}` : label;
}
const isActive = (kind, key) => (kind === 'num' ? (st.num[key] || []).some((v) => v != null) : (st.sel[key] || []).length > 0);
function chipsHtml() {
  const chip = (kind, key, label) => `<button type="button" class="chip ${isActive(kind, key) ? 'on' : ''}" data-chip="${kind}:${key}" aria-haspopup="dialog" aria-expanded="false">${esc(chipSummary(kind, key, label))} ${icon('chevron', 12)}</button>`;
  return NUM_FILTERS.map(([k, l]) => chip('num', k, l)).join('') + SEL_FILTERS.map(([k, l]) => chip('sel', k, l)).join('');
}
function popoverHtml(kind, key) {
  if (kind === 'num') {
    const [lo, hi] = st.num[key] || [], label = NUM_FILTERS.find((f) => f[0] === key)[1];
    return `<div class="pop-body"><h3>${esc(label)}</h3><div class="pair"><label>Min<input type="number" inputmode="decimal" step="any" data-num="${key}:0" value="${lo ?? ''}"></label><label>Max<input type="number" inputmode="decimal" step="any" data-num="${key}:1" value="${hi ?? ''}"></label></div>
      <div class="pop-actions"><button type="button" class="btn small" data-clear="${kind}:${key}">Clear</button><button type="button" class="btn small on" data-close>Done</button></div></div>`;
  }
  const label = SEL_FILTERS.find((f) => f[0] === key)[1], opts = key === 'sector' ? D.sectors : OPTIONS[key], cur = st.sel[key] || [];
  return `<div class="pop-body"><h3>${esc(label)}</h3><div class="checks">${opts.map((o) => `<label><input type="checkbox" data-sel="${key}" value="${esc(o)}" ${cur.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div>
    <div class="pop-actions"><button type="button" class="btn small" data-clear="${kind}:${key}">Clear</button><button type="button" class="btn small on" data-close>Done</button></div></div>`;
}

/* ---------- shell and updates ---------- */
function shell() {
  return `<div class="screener">
    <div class="sc-head"><h1>Stock screener</h1><p class="muted">NSE · the ${D.stocks.length} most-traded stocks</p>
      <div class="sc-tools"><button type="button" class="btn" data-menu="saved" aria-haspopup="dialog" aria-expanded="false">${icon('bookmark')} Saved screens</button>
        <button type="button" class="btn" data-menu="cols" aria-haspopup="dialog" aria-expanded="false">${icon('columns')} Columns</button>
        <button type="button" class="btn" data-export>${icon('download')} Export CSV</button><button type="button" class="btn" data-reset>Reset</button></div></div>
    <div class="filterbar"><label class="searchbox">${icon('search')}<span class="sr-only">Filter by symbol</span><input type="search" id="sc-q" placeholder="Symbol" value="${esc(st.q)}" autocomplete="off" maxlength="24"></label>
      <div class="chips" id="sc-chips" role="group" aria-label="Filters">${chipsHtml()}</div></div>
    <div class="popover" id="sc-pop" role="dialog" hidden></div>
    <div class="viewtabs" role="tablist" aria-label="Screener views">${Object.keys(VIEWS).map((v) => `<button type="button" role="tab" class="vt ${v === st.view ? 'on' : ''}" aria-selected="${v === st.view}" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
    <div class="status" id="sc-status" role="status" aria-live="polite"></div>
    <div class="table-wrap" id="sc-table" tabindex="0" role="region" aria-label="Screener results, scrollable"></div>
    <div class="pager" id="sc-pager"></div>
    <section class="card rules" aria-labelledby="rules-h" id="sc-rules"></section></div>`;
}

function update() {
  save();
  $$('#sc-chips .chip').forEach((b) => { const [kind, key] = b.dataset.chip.split(':'); const label = (kind === 'num' ? NUM_FILTERS : SEL_FILTERS).find((f) => f[0] === key)[1]; b.classList.toggle('on', isActive(kind, key)); b.firstChild.textContent = chipSummary(kind, key, label) + ' '; });
  $$('.vt').forEach((b) => { b.classList.toggle('on', b.dataset.view === st.view); b.setAttribute('aria-selected', b.dataset.view === st.view); });
  const all = sorted(filtered()), total = D.stocks.length, pages = Math.max(1, Math.ceil(all.length / st.size));
  st.page = Math.min(st.page, pages - 1);
  const from = st.page * st.size, rows = all.slice(from, from + st.size), cs = cols();
  const need = [];
  if (!D.extrasReady && (cs.includes('div') || cs.includes('income') || st.num.div || (st.sel.income || []).length)) need.push('dividend data');
  if (!D.sentimentReady && (cs.includes('sentL') || (st.sel.sentL || []).length)) need.push('news sentiment');
  $('#sc-status').innerHTML = `${all.length} of ${total} stocks match${need.length ? ` · <span class="muted">still loading ${need.join(' and ')}; stocks without it are left out of those filters for now</span>` : ''}`;
  const th = (k) => { const c = COLS[k], active = (SORTERS[st.sort.key] || st.sort.key) === (SORTERS[k] || k) && st.sort.key === k; return `<th scope="col" class="${c.num ? 'num' : ''}" aria-sort="${active ? (st.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-btn" data-sort="${k}">${esc(c.label)}${active ? ` <span aria-hidden="true">${st.sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</button></th>`; };
  const wl = store.get('ml.watchlist', []);
  $('#sc-table').innerHTML = rows.length ? `<table class="tbl screener-table"><caption class="sr-only">Stocks matching the current filters</caption><thead><tr><th scope="col" class="sym-col" aria-sort="${st.sort.key === 'sym' ? (st.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-btn" data-sort="sym">Symbol</button></th>${cs.map(th).join('')}</tr></thead><tbody>
    ${rows.map((r) => `<tr><th scope="row" class="sym-col"><button type="button" class="star ${wl.includes(r.sym) ? 'on' : ''}" data-star="${esc(r.sym)}" aria-pressed="${wl.includes(r.sym)}" aria-label="${wl.includes(r.sym) ? 'Remove' : 'Add'} ${esc(r.sym)} ${wl.includes(r.sym) ? 'from' : 'to'} watchlist">${icon('star', 14)}</button> ${symLink(r.s)}${secTag(r.s)}</th>${cs.map((k) => `<td class="${COLS[k].num ? 'num' : ''}">${COLS[k].html(r)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
    : emptyState('No stocks match', 'Widen a range, remove a filter, or reset the screen.', '<button type="button" class="btn" data-reset>Reset filters</button>');
  $('#sc-pager').innerHTML = all.length ? `<label>Rows <select id="sc-size">${[10, 25, 50, 100].map((n) => `<option ${n === st.size ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <span class="muted">${from + 1}–${from + rows.length} of ${all.length}</span><button type="button" class="btn small" data-page="-1" ${st.page === 0 ? 'disabled' : ''}>Previous</button><button type="button" class="btn small" data-page="1" ${st.page >= pages - 1 ? 'disabled' : ''}>Next</button>` : '';
  ctx.paintLive();
}

/* ---------- popovers (filters, columns, saved screens) ---------- */
function openPop(anchor, html, id) {
  const pop = $('#sc-pop');
  if (popFor === id) return closePop();
  closePop(false);
  pop.innerHTML = html; pop.hidden = false; popFor = id; anchor.setAttribute('aria-expanded', 'true'); pop.dataset.anchor = id;
  pop.setAttribute('aria-label', anchor.textContent.trim());
  const box = host.querySelector('.screener').getBoundingClientRect(), a = anchor.getBoundingClientRect();
  pop.style.setProperty('--left', `${Math.max(0, Math.min(a.left - box.left, box.width - 300))}px`);
  pop.style.setProperty('--top', `${a.bottom - box.top + 6}px`);
  const first = pop.querySelector('input,button'); if (first) first.focus();
}
function closePop(refocus = true) {
  const pop = $('#sc-pop'); if (!pop || pop.hidden) { popFor = null; return; }
  pop.hidden = true; $$('[aria-expanded="true"]', host).forEach((b) => { b.setAttribute('aria-expanded', 'false'); if (refocus && (b.dataset.chip === popFor || b.dataset.menu === popFor)) b.focus(); });
  popFor = null;
}
const colsPop = () => `<div class="pop-body"><h3>Columns · ${esc(st.view)}</h3><div class="checks">${Object.keys(COLS).map((k) => `<label><input type="checkbox" data-col="${k}" ${cols().includes(k) ? 'checked' : ''}> ${esc(COLS[k].label)}</label>`).join('')}</div>
  <div class="pop-actions"><button type="button" class="btn small" data-cols-default>Default</button><button type="button" class="btn small on" data-close>Done</button></div></div>`;
function savedPop() {
  const list = store.get(SAVED, []);
  return `<div class="pop-body"><h3>Saved screens</h3>${list.length ? `<ul class="saved">${list.map((x, i) => `<li><button type="button" class="link" data-load="${i}">${esc(x.name)}</button><button type="button" class="icon-btn" data-del="${i}" aria-label="Delete ${esc(x.name)}">${icon('x', 12)}</button></li>`).join('')}</ul>` : '<p class="muted">Nothing saved yet.</p>'}
  <form class="save-form" data-save><label>Save current screen as<input name="name" maxlength="40" required placeholder="e.g. Bullish + income"></label><button class="btn small on" type="submit">Save</button></form>
  <div class="pop-actions"><button type="button" class="btn small" data-close>Close</button></div></div>`;
}

/* ---------- CSV export (client-side, user-initiated) ---------- */
function exportCsv() {
  const cs = cols(), rows = sorted(filtered());
  const cell = (v) => { if (v == null) return ''; const s = String(v); const safe = typeof v === 'string' && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return `"${safe.replace(/"/g, '""')}"`; };   // neutralise spreadsheet formulas in text
  const csv = [['Symbol', ...cs.map((k) => COLS[k].label)].map(cell).join(','), ...rows.map((r) => [cell(r.sym), ...cs.map((k) => cell(COLS[k].csv(r)))].join(','))].join('\r\n');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `marketlens-screener-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- the rules, in plain language, built from the server's thresholds ---------- */
export function rulesHtml(R) {
  return `<h2 id="rules-h">How the ratings are decided</h2><div class="rules-grid">
    <article><h3>Technical rating</h3>
      <p>We look at about three months of daily closing prices and run up to four yes/no checks. Each scores +1 (bullish) or −1 (bearish):</p>
      <ol><li>Is the price above its ${R.smaFast}-day average? Above is +1, below is −1.</li>
        <li>Is the ${R.smaFast}-day average above the ${R.smaSlow}-day average? Above is +1, below is −1 (skipped if there are fewer than ${R.smaSlow} days of prices).</li>
        <li>RSI, a 0–100 momentum gauge over ${R.rsiPeriod} days: from ${R.rsiBullLow} up to ${R.rsiBullHigh} is +1; from ${R.rsiBearLow} up to ${R.rsiBearHigh} is −1; anything else is 0, because a very high or very low reading means the move may already be stretched.</li>
        <li>Is the MACD line above its signal line? Above is +1, below is −1.</li></ol>
      <p>The checks are averaged into a score from −1 to +1. <b>Bullish</b> if the score is ${R.techBand} or more, <b>Bearish</b> if it is −${R.techBand} or less, otherwise <b>Neutral</b>.</p>
      <p>With fewer than ${R.histMinCloses} days of prices we make a quick estimate instead (marked *): 30-day change above +${R.snapMomentumPct}% is +1 and below −${R.snapMomentumPct}% is −1 (counted ${R.snapMomentumWeight} times); position in the 52-week range at ${R.snapRangeHigh}% or higher is +1 and at ${R.snapRangeLow}% or lower is −1; today's change above +${R.snapDayPct}% is +1 and below −${R.snapDayPct}% is −1 (counted ${R.snapDayWeight} times). The same ${R.techBand} cut-offs apply.</p></article>
    <article><h3>Sentiment</h3>
      <p>For each stock we collect up to ${R.sentMaxHeadlines} recent headlines that mention its symbol, from Yahoo Finance and Google News.</p>
      <p>Each headline is scored by counting words from two fixed lists: positive words such as “surge”, “profit”, “upgrade” and “beats”, and negative words such as “fall”, “loss”, “probe” and “misses”. A positive word right after “not”, “no” or “fails” counts as negative, and the other way round. Routine notices such as “record date” are ignored. Headline score = (positive − negative) ÷ (positive + negative), from −1 to +1; a headline with none of these words scores 0.</p>
      <p>The stock's score is the average of its headline scores. It is <b>Positive</b> only if the average is ${R.sentBand} or higher <em>and</em> at least ${R.sentNet} more headlines are positive than negative. <b>Negative</b> is the mirror image. Everything else is <b>Neutral</b>, and <b>No news</b> means none were found.</p>
      <p class="muted">This is simple word counting. It cannot read context or sarcasm and may match unrelated stories, so treat it as a rough hint.</p></article>
    <article><h3>Income view</h3>
      <p>Not a full fundamental analysis (NSE does not publish earnings, debt or growth). Two checks, each from −1 to +1:</p>
      <ol><li>Dividend yield (last 12 months' dividends ÷ price) against the Nifty 50's yield: at least ${R.incYieldMult} times the index is +1, any dividend is 0, none is −1.</li>
        <li>Dividends in all of the last ${R.incYearsFull} calendar years is +1, in ${R.incYearsFull - 1} of them +0.5, in 1 of them 0, none −1.</li></ol>
      <p>Average of ${R.incHigh} or more is <b>Income-oriented</b>; ${R.incLow} or more is <b>Moderate income</b>; below that is <b>Little or no dividend income</b>.</p></article></div>
    <p class="muted">Hover or focus any badge to see the exact signals behind it. These ratings are simple rules, not predictions or advice.</p>`;
}

/* ---------- events ---------- */
function onClick(e) {
  const t = e.target.closest('button, a, [data-chip]'); if (!t) return;
  if (t.dataset.chip) { const [kind, key] = t.dataset.chip.split(':'); return openPop(t, popoverHtml(kind, key), t.dataset.chip); }
  if (t.dataset.menu) return openPop(t, t.dataset.menu === 'cols' ? colsPop() : savedPop(), t.dataset.menu);
  if (t.hasAttribute('data-close')) return closePop();
  if (t.dataset.clear) { const [kind, key] = t.dataset.clear.split(':'); if (kind === 'num') delete st.num[key]; else delete st.sel[key]; st.page = 0; $('#sc-pop').innerHTML = popoverHtml(kind, key); return update(); }
  if (t.dataset.view) { st.view = t.dataset.view; st.page = 0; return update(); }
  if (t.dataset.sort) { st.sort = st.sort.key === t.dataset.sort ? { key: t.dataset.sort, dir: -st.sort.dir } : { key: t.dataset.sort, dir: COLS[t.dataset.sort]?.num || t.dataset.sort === 'sentL' || t.dataset.sort === 'tech' ? -1 : 1 }; st.page = 0; return update(); }
  if (t.dataset.page) { st.page = Math.max(0, st.page + Number(t.dataset.page)); return update(); }
  if (t.dataset.star) { const wl = store.get('ml.watchlist', []), s = t.dataset.star; store.set('ml.watchlist', wl.includes(s) ? wl.filter((x) => x !== s) : [...wl, s]); return update(); }
  if (t.hasAttribute('data-export')) return exportCsv();
  if (t.hasAttribute('data-reset')) { st = { ...blank(), view: st.view, cols: st.cols }; $('#sc-q').value = ''; closePop(false); return update(); }
  if (t.hasAttribute('data-cols-default')) { delete st.cols[st.view]; $('#sc-pop').innerHTML = colsPop(); return update(); }
  if (t.dataset.load != null) { const x = store.get(SAVED, [])[Number(t.dataset.load)]; if (x) { st = { ...blank(), ...JSON.parse(JSON.stringify(x.state)), cols: st.cols }; $('#sc-q').value = st.q; closePop(false); update(); } return; }
  if (t.dataset.del != null) { const l = store.get(SAVED, []); l.splice(Number(t.dataset.del), 1); store.set(SAVED, l); $('#sc-pop').innerHTML = savedPop(); }
}
function onInput(e) {
  const t = e.target;
  if (t.id === 'sc-q') { st.q = t.value; st.page = 0; return update(); }
  if (t.dataset.num) { const [k, i] = t.dataset.num.split(':'); const cur = st.num[k] || [null, null]; cur[Number(i)] = t.value === '' || Number.isNaN(parseFloat(t.value)) ? null : parseFloat(t.value); st.num[k] = cur; st.page = 0; return update(); }
}
function onChange(e) {
  const t = e.target;
  if (t.dataset.sel) { const k = t.dataset.sel, cur = new Set(st.sel[k] || []); t.checked ? cur.add(t.value) : cur.delete(t.value); st.sel[k] = [...cur]; st.page = 0; return update(); }
  if (t.dataset.col) { const cur = new Set(cols()); t.checked ? cur.add(t.dataset.col) : cur.delete(t.dataset.col); st.cols[st.view] = Object.keys(COLS).filter((k) => cur.has(k)); return update(); }
  if (t.id === 'sc-size') { st.size = Number(t.value); st.page = 0; update(); }
}
function onSubmit(e) {
  if (!e.target.matches('[data-save]')) return;
  e.preventDefault();
  const name = new FormData(e.target).get('name').toString().trim().slice(0, 40); if (!name) return;
  const list = store.get(SAVED, []).filter((x) => x.name !== name);
  list.unshift({ name, state: { q: st.q, num: st.num, sel: st.sel, view: st.view, sort: st.sort, size: st.size } });
  store.set(SAVED, list.slice(0, 20)); $('#sc-pop').innerHTML = savedPop();
}
function onKey(e) { if (e.key === 'Escape' && popFor) { e.preventDefault(); closePop(); } }
function onDocClick(e) { if (popFor && !e.target.closest('#sc-pop, [data-chip], [data-menu]')) closePop(false); }

export async function mount(el, context) {
  host = el; ctx = context; D = ctx.D; st = load(); popFor = null;
  host.innerHTML = skeleton(8);
  try { rules = rules || (await api('/api/config')).rules; } catch (e) { rules = null; }
  host.innerHTML = shell();
  $('#sc-rules').innerHTML = rules ? rulesHtml(rules) : errorState('Rating rules unavailable', 'Could not load the thresholds from the local server.');
  host.addEventListener('click', onClick); host.addEventListener('input', onInput); host.addEventListener('change', onChange); host.addEventListener('submit', onSubmit); host.addEventListener('keydown', onKey);
  document.addEventListener('click', onDocClick);
  D.onAnalysis = debounce(() => { if ($('#sc-table')) update(); }, 150);
  update();
  return () => { document.removeEventListener('click', onDocClick); D.onAnalysis = null; };   // unmount
}
