/* Chart analysis page (lazy-loaded): candlestick chart for 5 min, 15 min, hourly, daily, weekly, monthly and yearly candles, with overlays (moving averages,
 * Bollinger bands, Supertrend, VWAP, support and resistance, pivot points, Fibonacci), indicator panels (volume, RSI, MACD, stochastic, ADX) and a written technical
 * read. Maths lives in ta.js (unit-tested); this file is layout and wiring.
 * Data: daily and longer candles come from NSE's daily history (open, high, low, close, volume). NSE keeps no intraday history, so 5 min, 15 min and hourly
 * candles are built from the live prices MarketLens records while it is open (see ticks.py / ticks.js); the page says so when they are missing. */
import { $, $$, esc, money, signed, api, icon, store, fmtDate, debounce } from './lib.js';
import { alert, skeletonBlock, badge } from './ui.js';
import { TIMEFRAMES, INTRADAY, candlesFor, applyTick, indicators, analyse } from './ta.js';

const OVERLAYS = [['ema', 'EMA 9 / 21'], ['sma20', 'SMA 20'], ['sma50', 'SMA 50'], ['sma200', 'SMA 200'], ['bb', 'Bollinger'], ['st', 'Supertrend'], ['vwap', 'VWAP'], ['sr', 'Support / resistance'], ['piv', 'Pivots'], ['fib', 'Fibonacci']];
const PANELS = [['vol', 'Volume'], ['rsi', 'RSI'], ['macd', 'MACD'], ['stoch', 'Stochastic'], ['adx', 'ADX']];
const COLORS = { ema9: 'var(--series-1)', ema21: 'var(--series-3)', sma20: '#c98a00', sma50: '#7c3aed', sma200: '#0891b2', bb: 'var(--text-muted)', vwap: '#db2777' };
const DEFAULTS = { sym: 'RELIANCE', tf: '1D', on: ['ema', 'sma50', 'bb', 'sr'], panels: ['vol', 'rsi', 'macd'] };
const IST_MS = 5.5 * 3600 * 1000;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const todayIst = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);

function stamp(t, tf) {
  if (INTRADAY.has(tf)) { const d = new Date(t * 1000 + IST_MS); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; }
  const [y, m, d] = String(t).split('-'); return tf === '1Y' ? y : tf === '1M' ? `${MON[+m - 1]} ${y}` : `${+d} ${MON[+m - 1]} ${y.slice(2)}`;
}

export function mount(root, { sym: start, bySym }) {
  const saved = store.get('ml.ta', {}), S = { ...DEFAULTS, ...saved, ...(start ? { sym: start.toUpperCase() } : {}), candles: [], ind: null, an: null, daily: [], bars: [], from: 0, count: 90, live: null, alive: true, ctl: null, timers: [] };
  const persist = () => store.set('ml.ta', { sym: S.sym, tf: S.tf, on: S.on, panels: S.panels });
  const stop = [];

  const isIndex = (k) => /^IDX_/.test(k || '');
  const D0 = window.MLData || {};
  const indexNames = () => { const seen = new Map(); const add = (n) => { if (n && !seen.has(indexKey(n))) seen.set(indexKey(n), n); }; (D0.indices || []).forEach((x) => add(x.name)); (D0.sectorIdx || []).forEach((x) => add(x.index)); (D0.valuation || []).forEach((x) => add(x.name)); return [...seen.entries()].map(([key, name]) => ({ key, name })); };
  const indexKey = (name) => 'IDX_' + String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const labelOf = (key) => (isIndex(key) ? (indexNames().find((x) => x.key === key) || { name: key.slice(4).replace(/_/g, ' ') }).name : key);
  const recent = () => store.get('ml.ta.recent', []).filter((r) => r && r.sym);
  const remember = (sym, name) => store.set('ml.ta.recent', [{ sym, name: name || '' }, ...recent().filter((r) => r.sym !== sym)].slice(0, 6));

  root.innerHTML = `<div class="grid gap-3"><div><h1 class="m-0">Chart analysis</h1>
    <p class="m-0 mt-1 text-sm text-muted-foreground">Candlesticks, indicators, support and resistance, patterns and a written technical read, from 5-minute to yearly candles, for stocks and indices.</p></div>
    <section class="card ta-card"><div class="ta-top"><div class="ta-pick"><button type="button" id="ta-pick-btn" class="ta-pick-btn" aria-haspopup="listbox" aria-expanded="false" aria-controls="ta-pop" aria-label="Choose a stock or index"></button>
        <div id="ta-pop" class="ta-pop" hidden><div class="ta-q"><span aria-hidden="true">${icon('command', 14)}</span><input id="ta-q" type="text" role="combobox" aria-expanded="true" aria-controls="ta-list" aria-autocomplete="list" placeholder="Search a stock or an index" autocomplete="off" maxlength="40"></div><div id="ta-list" class="ta-list" role="listbox" aria-label="Stocks and indices"></div></div></div>
      <div class="ta-zoom" role="group" aria-label="Zoom and pan"><button type="button" class="ta-btn" data-z="in" aria-label="Zoom in">+</button><button type="button" class="ta-btn" data-z="out" aria-label="Zoom out">−</button><button type="button" class="ta-btn" data-z="left" aria-label="Earlier">‹</button><button type="button" class="ta-btn" data-z="right" aria-label="Later">›</button><button type="button" class="ta-btn ta-btn-wide" data-z="all">All</button></div></div>
      <div class="viewtabs" role="tablist" id="ta-tf" aria-label="Candle size">${TIMEFRAMES.map(([k, l]) => `<button type="button" role="tab" class="vt ${k === S.tf ? 'on' : ''}" aria-selected="${k === S.tf}" tabindex="${k === S.tf ? 0 : -1}" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
      <p id="ta-head" class="m-0 mt-2 text-sm" aria-live="polite"></p>
      <div id="ta-opts" class="ta-opts"></div>
      <div id="ta-chart" class="mt-3" style="min-height:260px"></div><p id="ta-note" class="m-0 mt-2 text-xs text-muted-foreground"></p></section>
    <div id="ta-read"></div></div>`;
  const tfList = $('#ta-tf', root), tfAll = () => [...tfList.querySelectorAll('[role=tab]')];
  const pickTf = (el) => { tfAll().forEach((b) => { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }); S.tf = el.dataset.tab; persist(); S.from = null; load(); };
  tfList.addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) pickTf(b); });
  tfList.addEventListener('keydown', (e) => { const t = tfAll(), i = t.indexOf(document.activeElement), to = { ArrowRight: (i + 1) % t.length, ArrowLeft: (i - 1 + t.length) % t.length, Home: 0, End: t.length - 1 }[e.key]; if (to !== undefined && i >= 0) { e.preventDefault(); t[to].focus(); pickTf(t[to]); } });

  /* ---------- the stock / index picker: one searchable list, indices and stocks together ---------- */
  const btn = $('#ta-pick-btn', root), pop = $('#ta-pop', root), qIn = $('#ta-q', root), list = $('#ta-list', root);
  let opts = [], act = -1, found = [], seq = 0;
  const paintBtn = () => { const idx = isIndex(S.sym); btn.innerHTML = `<span class="ta-tag ${idx ? 'ta-tag-idx' : ''}">${idx ? 'Index' : 'Stock'}</span><b>${esc(labelOf(S.sym))}</b>${icon('chevron-down', 14)}`; };
  const optHtml = (o, i) => `<div role="option" id="ta-o${i}" class="ta-opt ${i === act ? 'on' : ''}" data-i="${i}" aria-selected="${i === act}"><span class="ta-tag ${o.index ? 'ta-tag-idx' : ''}">${o.index ? 'Index' : 'Stock'}</span><b>${esc(o.label)}</b><span class="ta-name">${esc(o.name || '')}</span></div>`;
  function renderList() {
    const q = qIn.value.trim().toUpperCase(); opts = [];
    const idxAll = indexNames().map((x) => ({ sym: x.key, label: x.name, name: '', index: true }));
    const stocksTop = (D0.stocks || []).slice(0, 8).map((x) => ({ sym: x.sym, label: x.sym, name: x.sector || '', index: false }));
    const groups = [];
    if (!q) {
      const rec = recent().map((r) => ({ sym: r.sym, label: labelOf(r.sym), name: r.name || '', index: isIndex(r.sym) }));
      if (rec.length) groups.push(['Recent', rec]);
      const head = ['NIFTY 50', 'NIFTY BANK', 'NIFTY NEXT 50', 'NIFTY MIDCAP 100', 'INDIA VIX'].map(indexKey);
      groups.push(['Indices', idxAll.filter((x) => head.includes(x.sym)).concat(idxAll.filter((x) => !head.includes(x.sym)).slice(0, 7))]);
      groups.push(['Most traded stocks', stocksTop]);
    } else {
      const idx = idxAll.filter((x) => x.label.toUpperCase().includes(q) || x.sym.includes(q.replace(/\W+/g, '_'))).slice(0, 8);
      const local = (D0.stocks || []).filter((x) => x.sym.includes(q)).slice(0, 6).map((x) => ({ sym: x.sym, label: x.sym, name: x.sector || '', index: false }));
      const seen = new Set(local.map((x) => x.sym)), remote = found.filter((x) => !seen.has(x.sym));
      if (idx.length) groups.push(['Indices', idx]);
      if (local.length || remote.length) groups.push(['Stocks', [...local, ...remote].slice(0, 10)]);
    }
    let n = 0; const out = [];
    for (const [title, items] of groups) { if (!items.length) continue; out.push(`<div class="ta-group" role="presentation">${esc(title)}</div>`); for (const o of items) { opts.push(o); out.push(optHtml(o, n++)); } }
    if (!opts.length) out.push(`<div class="ta-empty">${q.length < 2 ? 'Type at least two letters' : 'No stock or index matches'}</div>`);
    list.innerHTML = out.join(''); if (act >= opts.length) act = opts.length - 1;
    if (act >= 0) qIn.setAttribute('aria-activedescendant', `ta-o${act}`); else qIn.removeAttribute('aria-activedescendant');
  }
  const open = () => { pop.hidden = false; btn.setAttribute('aria-expanded', 'true'); qIn.value = ''; found = []; act = -1; renderList(); qIn.focus(); };
  const close = (back = true) => { if (pop.hidden) return; pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (back) btn.focus(); };
  const choose = (o) => { if (!o) return; close(); remember(o.sym, o.index ? '' : o.name); S.sym = o.sym; S.daily = []; S.bars = []; S.from = null; persist(); if (location.hash !== `#/chart/${encodeURIComponent(o.sym)}`) location.hash = `#/chart/${encodeURIComponent(o.sym)}`; };
  btn.addEventListener('click', () => (pop.hidden ? open() : close()));
  qIn.addEventListener('input', () => { act = -1; renderList(); const v = qIn.value.trim(); if (v.length >= 2) { const mine = ++seq; api(`/api/search?q=${encodeURIComponent(v)}`, { quiet: true, retries: 0 }).then((r) => { if (mine !== seq) return; found = (r.results || []).slice(0, 8).map((x) => ({ sym: x.symbol, label: x.symbol, name: x.name || '', index: false })); renderList(); }).catch(() => {}); } });
  qIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!opts.length) return; act = (act + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length; renderList(); $(`#ta-o${act}`, list)?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); const q = qIn.value.trim().toUpperCase(); choose(opts[act >= 0 ? act : 0] || (/^[A-Z0-9&_-]{1,24}$/.test(q) ? { sym: q, label: q, name: '', index: false } : null)); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Tab') close(false);
  });
  list.addEventListener('mousemove', (e) => { const o = e.target.closest('[data-i]'); if (o && +o.dataset.i !== act) { act = +o.dataset.i; $$('.ta-opt', list).forEach((x) => { x.classList.toggle('on', +x.dataset.i === act); x.setAttribute('aria-selected', +x.dataset.i === act); }); } });
  list.addEventListener('click', (e) => { const o = e.target.closest('[data-i]'); if (o) choose(opts[+o.dataset.i]); });
  const outside = (e) => { if (!pop.hidden && !e.target.closest('.ta-pick')) close(false); };
  document.addEventListener('pointerdown', outside); stop.push(() => document.removeEventListener('pointerdown', outside));
  paintBtn();

  const chip = (group, k, l, on) => `<button type="button" class="ta-chip ${on ? 'on' : ''}" data-${group}="${k}" aria-pressed="${on}">${esc(l)}</button>`;
  function paintOpts() {
    $('#ta-opts', root).innerHTML = `<span class="ta-lbl" id="ta-ovl">Overlays</span><div class="ta-chips" role="group" aria-labelledby="ta-ovl">${OVERLAYS.filter(([k]) => k !== 'vwap' || INTRADAY.has(S.tf)).map(([k, l]) => chip('ov', k, l, S.on.includes(k))).join('')}</div>
      <span class="ta-lbl" id="ta-pnl">Panels</span><div class="ta-chips" role="group" aria-labelledby="ta-pnl">${PANELS.map(([k, l]) => chip('pn', k, l, S.panels.includes(k))).join('')}</div>`;
    $$('[data-ov]', root).forEach((b) => b.addEventListener('click', () => { const k = b.dataset.ov; S.on = S.on.includes(k) ? S.on.filter((x) => x !== k) : [...S.on, k]; persist(); paintOpts(); draw(); }));
    $$('[data-pn]', root).forEach((b) => b.addEventListener('click', () => { const k = b.dataset.pn; S.panels = S.panels.includes(k) ? S.panels.filter((x) => x !== k) : [...S.panels, k]; persist(); paintOpts(); draw(); }));
  }
  const zoom = (how) => {
    const n = S.candles.length, c = S.count;
    if (how === 'in') S.count = Math.max(15, Math.round(c * 0.7)); else if (how === 'out') S.count = Math.min(n, Math.round(c / 0.7)); else if (how === 'all') S.count = n;
    else if (how === 'left') S.from = Math.max(0, (S.from ?? n - c) - Math.round(c / 3)); else if (how === 'right') S.from = Math.min(n - S.count, (S.from ?? n - c) + Math.round(c / 3));
    if (how === 'in' || how === 'out' || how === 'all') S.from = Math.max(0, n - S.count);
    draw();
  };
  $$('[data-z]', root).forEach((b) => b.addEventListener('click', () => zoom(b.dataset.z)));

  /* ---------- data ---------- */
  const marketLive = () => !!(window.MLData && window.MLData.market && window.MLData.market.live);
  async function ensureData() {
    S.ctl?.abort(); S.ctl = new AbortController(); const sig = S.ctl.signal;
    if (INTRADAY.has(S.tf)) {   // candles from Yahoo Finance (history), then anything newer that this app recorded itself
      const [y, r] = await Promise.all([api(`/api/candles/${encodeURIComponent(S.sym)}?tf=${S.tf}`, { quiet: true, retries: 0, timeoutMs: 30000, signal: sig }).catch((e) => { if (e.name === 'AbortError') throw e; return { available: false, reason: e.message }; }),
        api(`/api/intraday/${encodeURIComponent(S.sym)}`, { quiet: true, retries: 0, timeoutMs: 20000, signal: sig }).catch((e) => { if (e.name === 'AbortError') throw e; return { bars: [] }; })]);
      S.yc = y.available ? y.candles : []; S.ycNote = y.available ? y.source : y.reason; S.bars = r.bars || [];
    }
    else if (!S.daily.length) { const h = await api(`/api/history/${encodeURIComponent(S.sym)}?range=5Y`, { quiet: true, retries: 1, timeoutMs: 60000, signal: sig }); if (!h.available) throw new Error(h.reason || 'no price history for this symbol'); S.daily = h.points; S.earliest = h.earliest; }
  }
  function build() {
    let daily = S.daily;
    if (!INTRADAY.has(S.tf) && S.live && S.live.price > 0 && marketLive()) {   // today's candle from the live quote's own open, high, low
      const q = S.live, t = todayIst(), lastD = daily.length ? daily[daily.length - 1][0] : '';
      const row = [t, q.price, q.volume ?? 0, q.open ?? q.price, Math.max(q.high ?? q.price, q.price), Math.min(q.low ?? q.price, q.price)];
      daily = lastD < t ? [...daily, row] : lastD === t ? [...daily.slice(0, -1), row] : daily;
    }
    if (INTRADAY.has(S.tf)) {
      const base = (S.yc || []).map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })), rec = candlesFor(S.tf, { minuteBars: S.bars }), lastT = base.length ? base[base.length - 1].t : -1;
      S.candles = [...base, ...rec.filter((c) => c.t > lastT)];   // Yahoo's history, plus candles recorded after its last one
    } else S.candles = candlesFor(S.tf, { minuteBars: S.bars, dailyPoints: daily });
    S.ind = S.candles.length ? indicators(S.candles) : null; S.an = S.candles.length >= 3 ? analyse(S.candles, S.ind, S.tf) : null;
  }
  async function load() {
    $('#ta-chart', root).innerHTML = `<div role="status" aria-label="Loading chart">${skeletonBlock('300px')}</div>`; $('#ta-read', root).innerHTML = ''; paintOpts();
    try { await ensureData(); } catch (e) { if (e.name === 'AbortError') return; $('#ta-chart', root).innerHTML = alert({ variant: 'destructive', title: 'Could not load the chart', text: e.message, actionLabel: 'Retry', actionId: 'ta-retry' }); $('#ta-retry', root)?.addEventListener('click', load); return; }
    if (!S.alive) return;
    build(); S.count = Math.min(S.candles.length || 1, INTRADAY.has(S.tf) ? 100 : { '1D': 120, '1W': 80, '1M': 60, '1Y': 10 }[S.tf]); S.from = Math.max(0, S.candles.length - S.count);
    draw(); paintRead();
  }

  /* ---------- drawing ---------- */
  function draw() {
    const host = $('#ta-chart', root), cs = S.candles; if (!host) return;
    const head = $('#ta-head', root), note = $('#ta-note', root);
    if (cs.length < 2) {
      const intr = INTRADAY.has(S.tf);
      host.innerHTML = alert({ variant: 'default', title: intr ? 'No intraday candles available' : 'No candles for this symbol', text: intr ? `NSE’s servers keep daily history only, so intraday candles come from Yahoo Finance${S.ycNote ? ` (${S.ycNote})` : ''}, plus the live prices MarketLens records while it is open. ${marketLive() ? 'The market is open: keep this page open and recorded candles appear within a minute or two.' : 'Try again when the connection is back, or open the page while the market is open.'} Daily, weekly, monthly and yearly candles are available now.` : 'NSE returned no price history for this symbol.' });
      head.textContent = ''; note.textContent = ''; return;
    }
    const n = cs.length; S.count = Math.max(10, Math.min(S.count, n)); S.from = Math.max(0, Math.min(n - S.count, S.from ?? n - S.count));
    const a = S.from, b = S.from + S.count, vis = cs.slice(a, b), ind = S.ind;
    const W = Math.max(280, host.clientWidth || 720), pl = 6, pr = 58, pt = 8, ph = Math.round(Math.min(380, Math.max(220, innerHeight * 0.42))), sub = 84, gap = 14, panels = S.panels, bottomAxis = 22;
    const H = pt + ph + panels.length * (sub + gap) + bottomAxis, cw = (W - pl - pr) / vis.length, xs = (i) => pl + (i - a + 0.5) * cw;
    const slice = (arr) => arr.slice(a, b);
    // price scale over what is visible, including the overlays that are drawn
    let lo = Math.min(...vis.map((c) => c.l)), hi = Math.max(...vis.map((c) => c.h));
    const lines = {}; const addLine = (k, arr, color, w = 1.4, dash = '') => { lines[k] = { arr, color, w, dash }; slice(arr).forEach((v) => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); };
    if (S.on.includes('ema')) { addLine('ema9', ind.ema9, COLORS.ema9); addLine('ema21', ind.ema21, COLORS.ema21); }
    for (const k of ['sma20', 'sma50', 'sma200']) if (S.on.includes(k)) addLine(k, ind[k], COLORS[k]);
    if (S.on.includes('bb')) { addLine('bbU', ind.bb.upper, COLORS.bb, 1, '4 3'); addLine('bbL', ind.bb.lower, COLORS.bb, 1, '4 3'); addLine('bbM', ind.bb.mid, COLORS.bb, 1); }
    if (S.on.includes('vwap') && INTRADAY.has(S.tf)) addLine('vwap', ind.vwap, COLORS.vwap, 1.4, '6 3');
    const pad = (hi - lo || hi * 0.01) * 0.06; lo -= pad; hi += pad;
    const y = (v) => pt + (1 - (v - lo) / (hi - lo)) * ph;
    const g = [];
    // grid and price axis
    for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4; g.push(`<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${W - pr + 5}" y="${y(v) + 4}" class="ax">${money(v, v > 1000 ? 0 : 2)}</text>`); }
    // supertrend segments
    if (S.on.includes('st')) { let seg = [], dir = 0; const flush = () => { if (seg.length > 1) g.push(`<polyline fill="none" stroke="${dir > 0 ? 'var(--up)' : 'var(--down)'}" stroke-width="1.6" points="${seg.join(' ')}"/>`); seg = []; }; for (let i = a; i < b; i++) { const v = ind.st.line[i], d = ind.st.dir[i]; if (v == null) continue; if (d !== dir) { flush(); dir = d; } seg.push(`${xs(i).toFixed(1)},${y(v).toFixed(1)}`); } flush(); }
    // levels
    const an = S.an, lvl = (price, color, label, dash = '3 3') => { if (price >= lo && price <= hi) g.push(`<line x1="${pl}" x2="${W - pr}" y1="${y(price)}" y2="${y(price)}" stroke="${color}" stroke-dasharray="${dash}" opacity=".8"/><text x="${W - pr - 4}" y="${y(price) - 3}" class="ax" text-anchor="end" fill="${color}">${esc(label)} ${money(price, 2)}</text>`); };
    if (an && an.ok) {
      if (S.on.includes('sr')) { an.levels.resistance.forEach((l, i) => lvl(l.price, 'var(--down)', `R${i + 1}`)); an.levels.support.forEach((l, i) => lvl(l.price, 'var(--up)', `S${i + 1}`)); }
      if (S.on.includes('piv') && an.pivots) for (const [k, v] of Object.entries(an.pivots)) lvl(v, k === 'P' ? 'var(--text-2)' : k[0] === 'R' ? 'var(--down)' : 'var(--up)', k, '1 4');
      if (S.on.includes('fib') && an.fib) an.fib.levels.forEach((l) => lvl(l.price, 'var(--series-5)', `${(l.ratio * 100).toFixed(1)}%`, '2 4'));
    }
    for (const L of Object.values(lines)) { const pts = []; for (let i = a; i < b; i++) if (L.arr[i] != null) pts.push(`${xs(i).toFixed(1)},${y(L.arr[i]).toFixed(1)}`); if (pts.length > 1) g.push(`<polyline fill="none" stroke="${L.color}" stroke-width="${L.w}" ${L.dash ? `stroke-dasharray="${L.dash}"` : ''} points="${pts.join(' ')}"/>`); }
    // candles
    const bw = Math.max(1, Math.min(14, cw * 0.7));
    vis.forEach((c, k) => { const i = a + k, up = c.c >= c.o, col = up ? 'var(--up)' : 'var(--down)', x = xs(i); g.push(`<line x1="${x}" x2="${x}" y1="${y(c.h)}" y2="${y(c.l)}" stroke="${col}" stroke-width="1"/><rect x="${x - bw / 2}" y="${Math.min(y(c.o), y(c.c))}" width="${bw}" height="${Math.max(1, Math.abs(y(c.o) - y(c.c)))}" fill="${up ? 'var(--up)' : 'var(--down)'}" ${up ? 'fill-opacity=".85"' : ''}/>`); });
    const lastC = cs[n - 1]; g.push(`<line x1="${pl}" x2="${W - pr}" y1="${y(lastC.c)}" y2="${y(lastC.c)}" stroke="${lastC.c >= lastC.o ? 'var(--up)' : 'var(--down)'}" stroke-dasharray="2 2" opacity=".7"/><rect x="${W - pr}" y="${y(lastC.c) - 8}" width="${pr - 2}" height="16" rx="3" fill="${lastC.c >= lastC.o ? 'var(--up)' : 'var(--down)'}"/><text x="${W - pr + 4}" y="${y(lastC.c) + 4}" class="ax" fill="#fff" style="fill:#fff">${money(lastC.c, lastC.c > 1000 ? 0 : 2)}</text>`);
    // panels
    let top = pt + ph + gap; const panelInfo = {};
    for (const key of panels) {
      const t0 = top, py = (v, min, max) => t0 + (1 - (v - min) / (max - min || 1)) * sub; panelInfo[key] = t0;
      g.push(`<rect x="${pl}" y="${t0}" width="${W - pl - pr}" height="${sub}" fill="none" stroke="var(--border)"/><text x="${pl + 4}" y="${t0 + 11}" class="ax">${esc(PANELS.find((p) => p[0] === key)[1])}</text>`);
      const line = (arr, min, max, color, w = 1.3) => { const pts = []; for (let i = a; i < b; i++) if (arr[i] != null) pts.push(`${xs(i).toFixed(1)},${py(arr[i], min, max).toFixed(1)}`); if (pts.length > 1) g.push(`<polyline fill="none" stroke="${color}" stroke-width="${w}" points="${pts.join(' ')}"/>`); };
      const hline = (v, min, max, label) => g.push(`<line x1="${pl}" x2="${W - pr}" y1="${py(v, min, max)}" y2="${py(v, min, max)}" class="grid" stroke-dasharray="3 3"/><text x="${W - pr + 5}" y="${py(v, min, max) + 4}" class="ax">${label}</text>`);
      if (key === 'vol') { const mx = Math.max(1, ...vis.map((c) => c.v)); vis.forEach((c, k) => { const h = (c.v / mx) * (sub - 14); g.push(`<rect x="${xs(a + k) - bw / 2}" y="${t0 + sub - h}" width="${bw}" height="${h}" fill="${c.c >= c.o ? 'var(--up)' : 'var(--down)'}" opacity=".55"/>`); }); g.push(`<text x="${W - pr + 5}" y="${t0 + 12}" class="ax">${mx >= 1e7 ? `${(mx / 1e7).toFixed(1)}Cr` : mx >= 1e5 ? `${(mx / 1e5).toFixed(1)}L` : money(mx, 0)}</text>`); }
      if (key === 'rsi') { hline(70, 0, 100, '70'); hline(30, 0, 100, '30'); line(ind.rsi, 0, 100, 'var(--series-1)'); }
      if (key === 'macd') { const vals = [...slice(ind.macd.line), ...slice(ind.macd.signal)].filter((v) => v != null), m = Math.max(...vals.map(Math.abs), 1e-9); hline(0, -m, m, '0'); vis.forEach((c, k) => { const h = ind.macd.hist[a + k]; if (h == null) return; const y0 = py(0, -m, m), y1 = py(h, -m, m); g.push(`<rect x="${xs(a + k) - bw / 2}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.abs(y1 - y0)}" fill="${h >= 0 ? 'var(--up)' : 'var(--down)'}" opacity=".5"/>`); }); line(ind.macd.line, -m, m, 'var(--series-1)'); line(ind.macd.signal, -m, m, 'var(--series-3)'); }
      if (key === 'stoch') { hline(80, 0, 100, '80'); hline(20, 0, 100, '20'); line(ind.stoch.k, 0, 100, 'var(--series-1)'); line(ind.stoch.d, 0, 100, 'var(--series-3)'); }
      if (key === 'adx') { const mx = Math.max(50, ...slice(ind.adx.adx).filter((v) => v != null), ...slice(ind.adx.plus).filter((v) => v != null), ...slice(ind.adx.minus).filter((v) => v != null)); hline(25, 0, mx, '25'); line(ind.adx.adx, 0, mx, 'var(--text)', 1.6); line(ind.adx.plus, 0, mx, 'var(--up)'); line(ind.adx.minus, 0, mx, 'var(--down)'); }
      top += sub + gap;
    }
    // time axis
    const ticks = Math.max(2, Math.min(6, Math.floor((W - pl - pr) / 90)));
    for (let k = 0; k < ticks; k++) { const i = a + Math.round(((vis.length - 1) * k) / (ticks - 1)); g.push(`<text x="${xs(i)}" y="${H - 6}" class="ax" text-anchor="${k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle'}">${esc(stamp(cs[i].t, S.tf))}</text>`); }
    host.innerHTML = `<div class="relative"><svg id="ta-svg" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Candlestick chart of ${esc(labelOf(S.sym))}, ${esc(TIMEFRAMES.find((t) => t[0] === S.tf)[1])} candles" tabindex="0" style="display:block;touch-action:pan-y;cursor:crosshair">${g.join('')}<line id="ta-x" y1="${pt}" y2="${H - bottomAxis}" class="xh" style="display:none"/></svg><div id="ta-tip" class="chart-tip" style="display:none;min-width:11rem"></div></div>`;
    const svg = $('#ta-svg', host), tip = $('#ta-tip', host), cx = $('#ta-x', host);
    const idxAt = (clientX) => { const r = svg.getBoundingClientRect(), f = ((clientX - r.left) / r.width) * W; return Math.max(a, Math.min(b - 1, a + Math.floor((f - pl) / cw))); };
    const show = (i) => { const c = cs[i], prev = cs[i - 1], chg = prev ? ((c.c - prev.c) / prev.c) * 100 : null, tone = c.c >= c.o ? 'up' : 'down';
      cx.setAttribute('x1', xs(i)); cx.setAttribute('x2', xs(i)); cx.style.display = ''; tip.style.display = '';
      tip.style.left = `${Math.min(Math.max((xs(i) / W) * svg.clientWidth + 12, 4), svg.clientWidth - 190)}px`;
      const iv = (arr, d = 2) => (arr[i] == null ? '—' : money(arr[i], d));
      tip.innerHTML = `<b>${esc(stamp(c.t, S.tf))}</b><br>O ${money(c.o)} · H ${money(c.h)}<br>L ${money(c.l)} · C <span class="${tone}">${money(c.c)}</span>${chg != null ? ` <span class="${tone}">${signed(chg)}%</span>` : ''}<br>Vol ${c.v ? money(c.v, 0) : '—'}${panels.includes('rsi') ? `<br>RSI ${iv(ind.rsi, 1)}` : ''}${panels.includes('macd') ? `<br>MACD ${iv(ind.macd.line)} · sig ${iv(ind.macd.signal)}` : ''}${panels.includes('stoch') ? `<br>%K ${iv(ind.stoch.k, 0)} · %D ${iv(ind.stoch.d, 0)}` : ''}${panels.includes('adx') ? `<br>ADX ${iv(ind.adx.adx, 0)}` : ''}`; };
    svg.addEventListener('pointermove', (e) => { if (drag) return; show(idxAt(e.clientX)); }); svg.addEventListener('pointerleave', () => { cx.style.display = tip.style.display = 'none'; });
    let drag = null;   // horizontal drag pans; vertical movement still scrolls the page (touch-action: pan-y)
    svg.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, from: S.from }; svg.setPointerCapture(e.pointerId); });
    svg.addEventListener('pointermove', (e) => { if (!drag) return; const d = Math.round((drag.x - e.clientX) / (svg.getBoundingClientRect().width / W) / cw); const nf = Math.max(0, Math.min(n - S.count, drag.from + d)); if (nf !== S.from) { S.from = nf; draw(); } });
    svg.addEventListener('pointerup', () => { drag = null; }); svg.addEventListener('pointercancel', () => { drag = null; });
    svg.addEventListener('wheel', (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); zoom(e.deltaY < 0 ? 'in' : 'out'); }, { passive: false });
    svg.addEventListener('keydown', (e) => { const m = { ArrowLeft: 'left', ArrowRight: 'right', '+': 'in', '=': 'in', '-': 'out' }[e.key]; if (m) { e.preventDefault(); zoom(m); } });
    // header line and notes
    const c = cs[n - 1], p = cs[n - 2], chg = p ? ((c.c - p.c) / p.c) * 100 : null, tone = chg == null ? '' : chg >= 0 ? 'up' : 'down', live = marketLive() && (INTRADAY.has(S.tf) || S.live);
    head.innerHTML = `<b>${esc(labelOf(S.sym))}</b> · ${esc(TIMEFRAMES.find((t) => t[0] === S.tf)[1])} · <b class="tabular-nums ${tone}">${money(c.c)}</b> ${chg != null ? `<span class="${tone}">${signed(chg)}%</span>` : ''} · ${n} candles${live ? ` · ${badge('Live', { variant: 'success', iconName: 'circle-dot' })}` : ''}`;
    note.textContent = INTRADAY.has(S.tf) ? `Intraday candles: ${S.yc && S.yc.length ? `history from ${S.ycNote || 'Yahoo Finance'}` : 'no history source reachable'}${S.bars.length ? `, plus ${S.bars.length} one-minute bars recorded by MarketLens since ${stamp(S.bars[0][0], '5m')}` : ''}. NSE keeps daily history only.` : `${isIndex(S.sym) ? 'Index history' : 'Daily history'} from NSE since ${esc(fmtDate(S.earliest || cs[0].t))}${S.tf === '1Y' ? '; the number of yearly candles is the number of years NSE provides' : ''}.`;
  }

  /* ---------- the written read ---------- */
  function paintRead() {
    const box = $('#ta-read', root), an = S.an; if (!box) return;
    if (!an || !an.ok) { box.innerHTML = ''; return; }
    const tone = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : ''), vb = an.score >= 0.2 ? 'success' : an.score <= -0.2 ? 'danger' : 'secondary', f = (x) => (x == null ? '—' : money(x, 2));
    const bar = `<div style="height:8px;border-radius:4px;background:var(--surface-2);position:relative;margin:.5rem 0"><div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--text-muted)"></div><div style="position:absolute;top:0;bottom:0;border-radius:4px;background:${an.score >= 0 ? 'var(--up)' : 'var(--down)'};${an.score >= 0 ? `left:50%;width:${an.score * 50}%` : `right:50%;width:${-an.score * 50}%`}"></div></div>`;
    const groups = ['Trend', 'Momentum', 'Volatility', 'Volume', 'Patterns'].map((gname) => [gname, an.signals.filter((s) => s.group === gname)]).filter(([, l]) => l.length);
    const levelRows = (title, list, kind) => list.length ? `<p class="m-0 mt-2 text-xs font-semibold uppercase text-muted-foreground">${title}</p>${list.map((l, i) => `<div class="flex justify-between text-sm"><span>${kind}${i + 1} · ${l.touches} touch${l.touches > 1 ? 'es' : ''}</span><b class="tabular-nums ${kind === 'S' ? 'up' : 'down'}">${f(l.price)}</b></div>`).join('')}` : '';
    box.innerHTML = `<div class="grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))">
      <section class="card strat" aria-live="polite"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="m-0">Technical read</h2>${badge(an.verdict, { variant: vb })}</div>${bar}
        <p class="m-0 text-sm">${esc(an.text)}</p>
        <div class="mt-3 grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,8rem),1fr))"><div><p class="m-0 text-xs text-muted-foreground">Trend</p><b class="${tone(an.trendScore)}">${an.trendScore == null ? '—' : signed(an.trendScore)}</b></div><div><p class="m-0 text-xs text-muted-foreground">Momentum</p><b class="${tone(an.momentumScore)}">${an.momentumScore == null ? '—' : signed(an.momentumScore)}</b></div><div><p class="m-0 text-xs text-muted-foreground">ATR (typical range)</p><b>${f(an.atr)}${an.atrPct != null ? ` · ${an.atrPct.toFixed(1)}%` : ''}</b></div></div>
        ${an.enough.sma200 ? '' : '<p class="m-0 mt-2 text-xs text-muted-foreground">There are fewer than 200 candles here, so the 200-candle average is not part of the read. A longer timeframe or more recorded history adds it.</p>'}</section>
      <section class="card strat"><h2 class="m-0">Key levels</h2>${levelRows('Resistance (above price)', an.levels.resistance, 'R')}${levelRows('Support (below price)', an.levels.support, 'S')}
        ${an.pivots ? `<p class="m-0 mt-3 text-xs font-semibold uppercase text-muted-foreground">Pivot points (from the previous candle)</p><div class="scroll"><table class="tbl"><thead><tr>${['S3', 'S2', 'S1', 'P', 'R1', 'R2', 'R3'].map((k) => `<th class="num">${k}</th>`).join('')}</tr></thead><tbody><tr>${['S3', 'S2', 'S1', 'P', 'R1', 'R2', 'R3'].map((k) => `<td class="num">${f(an.pivots[k])}</td>`).join('')}</tr></tbody></table></div>` : ''}
        ${an.fib ? `<p class="m-0 mt-3 text-xs font-semibold uppercase text-muted-foreground">Fibonacci retracement of the last ${an.fib.direction === 'up' ? 'rise' : 'fall'} (${f(an.fib.low)} to ${f(an.fib.high)})</p><div class="scroll"><table class="tbl"><thead><tr>${an.fib.levels.map((l) => `<th class="num">${(l.ratio * 100).toFixed(1)}%</th>`).join('')}</tr></thead><tbody><tr>${an.fib.levels.map((l) => `<td class="num">${f(l.price)}</td>`).join('')}</tr></tbody></table></div>` : ''}</section>
      <section class="card strat"><h2 class="m-0">Patterns</h2>${an.candlePatterns.length || an.chartPatterns.length ? `<ul class="m-0 mt-2 grid gap-2 p-0" style="list-style:none">${[...an.chartPatterns.map((p) => ({ ...p, age: null })), ...an.candlePatterns].map((p) => `<li class="text-sm"><b class="${p.bias === 'bullish' ? 'up' : p.bias === 'bearish' ? 'down' : ''}">${esc(p.name)}</b> ${p.bias === 'neutral' ? '' : `<span class="text-xs">(${p.bias})</span>`}${p.age != null ? ` <span class="muted text-xs">${p.age === 0 ? 'latest candle' : `${p.age} candle${p.age > 1 ? 's' : ''} ago`}</span>` : ''}<br><span class="text-muted-foreground">${esc(p.text)}</span></li>`).join('')}</ul>` : '<p class="m-0 mt-2 text-sm text-muted-foreground">No classic candlestick or chart pattern on the latest candles.</p>'}</section>
      <section class="card strat" style="grid-column:1/-1"><h2 class="m-0">Every signal</h2><div class="scroll mt-2"><table class="tbl"><thead><tr><th>Group</th><th>Signal</th><th>Reading</th><th>Why</th></tr></thead><tbody>${groups.flatMap(([gname, list]) => list.map((s) => `<tr><td>${esc(gname)}</td><td><b>${esc(s.name)}</b></td><td class="${s.bias > 0 ? 'up' : s.bias < 0 ? 'down' : ''}">${s.bias > 0 ? 'Bullish' : s.bias < 0 ? 'Bearish' : 'Neutral'}</td><td>${esc(s.text)}</td></tr>`)).join('')}</tbody></table></div>
        <p class="m-0 mt-2 text-xs text-muted-foreground">How the read is formed: each signal votes bullish or bearish with a weight (longer averages and trend strength count more); the weighted average is the verdict. It describes what the chart is showing now; it does not predict.</p></section></div>`;
  }

  /* ---------- live ---------- */
  stop.push(window.MLLive ? window.MLLive.watch([S.sym]) : () => {});
  const off = window.MLLive ? window.MLLive.onFeed((r) => {
    if (!S.alive) return; const q = (r.quotes || []).find((x) => x.sym === S.sym); if (!q || !(q.price > 0) || q.status === 'unavailable') return;
    S.live = q; const before = S.candles.length ? S.candles[S.candles.length - 1].c : null;
    if (INTRADAY.has(S.tf)) { if (r.market && r.market.live && S.candles.length) { S.candles = applyTick(S.candles, q.price, Math.floor(Date.now() / 1000), S.tf); } }
    else if (S.daily.length) build();
    if (S.candles.length && S.candles[S.candles.length - 1].c !== before) { S.ind = indicators(S.candles); S.an = analyse(S.candles, S.ind, S.tf); draw(); S.ticks = (S.ticks || 0) + 1; if (S.ticks % 5 === 0) paintRead(); }
  }) : () => {};
  stop.push(off);
  const refreshBars = setInterval(async () => { if (!S.alive || document.hidden || !INTRADAY.has(S.tf) || !marketLive()) return; try { await ensureData(); build(); draw(); paintRead(); } catch (e) { /* the next attempt will try again */ } }, 15000);
  stop.push(() => clearInterval(refreshBars));
  window.addEventListener('resize', draw); stop.push(() => window.removeEventListener('resize', draw));

  paintOpts(); load();
  return () => { S.alive = false; S.ctl?.abort(); stop.forEach((f) => f && f()); };
}
