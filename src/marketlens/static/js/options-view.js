/* Option strategies tab of the paper-trading page (lazy-loaded): pick any textbook options strategy, build it from the real option chain, and see its cost,
 * maximum profit and loss, break-evens, chance of profit and Greeks, with a profit-and-loss chart. Positions can be saved to a separate paper option book and
 * tracked against the latest chain. Learning only: no orders are sent anywhere. Maths: options-lab.js (unit-tested). */
import { $, $$, esc, money, signed, api, icon, store, fmtDate, debounce, compact } from './lib.js';
import { buttonClass, alert, skeletonRows, toast, badge, emptyCard, confirmDialog } from './ui.js';
import { OPTION_STRATEGIES, optionStrategyGroups, buildStrategy, analyse, payoffCurves, compareOptionStrategies, markToMarket, settlePnl, pnlAt, defaultLot, expiryMs } from './options-lab.js';

const BOOK = 'ml.paper.opt';
const rupee = (n, d = 0) => `₹${money(n, d)}`;
const sRupee = (n) => (n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : '−'}₹${money(Math.abs(n), 0)}`);
const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
const inp = 'h-9 rounded-md border border-input bg-card px-3', sel = 'h-9 rounded-md border border-input bg-card px-2';
const cell = (label, value, sub = '', t = '') => `<div class="rounded-lg border border-border bg-card p-3"><p class="m-0 text-xs text-muted-foreground">${esc(label)}</p><p class="m-0 text-lg font-bold tabular-nums ${t}">${value}</p>${sub ? `<p class="m-0 text-xs text-muted-foreground">${sub}</p>` : ''}</div>`;
const readBook = () => { const b = store.get(BOOK, null); return b && Array.isArray(b.positions) ? b : { positions: [], closed: [], realized: 0 }; };

export function paintOptions(body, { isAlive }) {
  const L = Object.assign({ sym: 'NIFTY', expiry: '', key: 'iron_condor', width: 1, lots: 1, lot: 0 }, store.get('ml.optlab', {}));
  const S = { chain: null, far: null, st: null, an: null, comp: null, ctl: null };
  const persist = () => store.set('ml.optlab', L);

  body.innerHTML = `<div class="grid gap-3"><section class="card"><h2 class="m-0">Build an option strategy from the real chain</h2>
    <p class="m-0 mt-1 text-sm text-muted-foreground">Choose a view of the market and a strategy; the legs are placed on the actual strikes and priced from NSE’s latest end-of-day option file. Nothing is bought: this shows what would happen.</p>
    <form id="ol-form" class="mt-3 grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr))" autocomplete="off" novalidate>
      <label class="grid gap-1 text-sm">Underlying<input id="ol-sym" list="ol-sugg" value="${esc(L.sym)}" maxlength="24" class="${inp}"></label><datalist id="ol-sugg"><option>NIFTY</option><option>BANKNIFTY</option><option>FINNIFTY</option><option>MIDCPNIFTY</option></datalist>
      <label class="grid gap-1 text-sm">Expiry<select id="ol-exp" class="${sel}"><option value="">Nearest saved</option></select></label>
      <label class="grid gap-1 text-sm">Strategy<select id="ol-key" class="${sel}">${optionStrategyGroups().map(([g, items]) => `<optgroup label="${esc(g)}">${items.map(([k, n]) => `<option value="${k}" ${k === L.key ? 'selected' : ''}>${esc(n)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label class="grid gap-1 text-sm">Strike gap<select id="ol-width" class="${sel}">${[1, 2, 3, 4, 5].map((w) => `<option value="${w}" ${w === L.width ? 'selected' : ''}>${w === 1 ? 'Narrow (1 step)' : `${w} steps`}</option>`).join('')}</select></label>
      <label class="grid gap-1 text-sm">Lots<input id="ol-lots" type="number" min="1" max="100" step="1" value="${L.lots}" class="${inp}"></label>
      <label class="grid gap-1 text-sm">Lot size<input id="ol-lot" type="number" min="1" step="1" value="${L.lot || defaultLot(L.sym)}" class="${inp}"></label>
      <div class="flex items-end"><button type="submit" id="ol-run" class="${buttonClass({ size: 'lg', extra: 'w-full' })}">${icon('play', 16)}Build strategy</button></div></form>
    <p class="mt-2 text-xs text-muted-foreground">Lot sizes are revised by NSE from time to time: check the current size before reading the rupee amounts. The strike gap scales the distance between legs.</p></section>
    <div id="ol-result"></div><div id="ol-book"></div></div>`;

  const read = () => {
    L.sym = $('#ol-sym', body).value.trim().toUpperCase(); L.expiry = $('#ol-exp', body).value; L.key = $('#ol-key', body).value; L.width = +$('#ol-width', body).value || 1;
    L.lots = Math.min(100, Math.max(1, Math.round(+$('#ol-lots', body).value || 1))); L.lot = Math.max(1, Math.round(+$('#ol-lot', body).value || defaultLot(L.sym))); persist();
  };
  $('#ol-sym', body).addEventListener('input', debounce((e) => { const v = e.target.value.trim(); if (v.length >= 2) api(`/api/search?q=${encodeURIComponent(v)}`, { quiet: true, retries: 0 }).then((r) => { const dl = $('#ol-sugg', body); if (dl) dl.innerHTML = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].map((x) => `<option>${x}</option>`).join('') + r.results.slice(0, 8).map((x) => `<option value="${esc(x.symbol)}">${esc(x.name || '')}</option>`).join(''); }).catch(() => {}); }, 200));
  $('#ol-sym', body).addEventListener('change', () => { $('#ol-lot', body).value = defaultLot($('#ol-sym', body).value.trim()); $('#ol-exp', body).value = ''; });
  $('#ol-key', body).addEventListener('change', () => { read(); if (S.chain) rebuild(); });
  for (const id of ['#ol-width', '#ol-lots', '#ol-lot']) $(id, body).addEventListener('change', () => { read(); if (S.chain) rebuild(); });
  $('#ol-exp', body).addEventListener('change', () => { read(); run(); });
  $('#ol-form', body).addEventListener('submit', (e) => { e.preventDefault(); read(); run(); });

  const fetchChain = async (sym, expiry, signal) => {
    const d = await api(`/api/options?symbol=${encodeURIComponent(sym)}&expiry=${encodeURIComponent(expiry || '')}`, { quiet: true, retries: 1, timeoutMs: 30000, signal });
    if (d.error) throw new Error(d.error);
    if (!d.available) throw new Error(d.reason || `No option-chain data for ${sym} yet.`);
    return d;
  };
  const toChain = (d) => ({ spot: d.spot, expiry: d.expiry, rows: d.rows, expiries: d.expiries || [], tradeDate: d.meta && d.meta.tradeDate, spotLive: !!d.spotLive });

  async function run() {
    const box = $('#ol-result', body); if (!box) return;
    if (!/^[A-Z0-9&_-]{1,24}$/.test(L.sym)) { box.innerHTML = alert({ variant: 'destructive', title: 'Invalid symbol', text: 'Use an NSE underlying such as NIFTY or RELIANCE.' }); return; }
    S.ctl?.abort(); S.ctl = new AbortController(); const btn = $('#ol-run', body); if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    box.innerHTML = `<section class="card">${skeletonRows(5)}<p class="m-0 mt-2 text-sm text-muted-foreground">Loading the ${esc(L.sym)} option chain…</p></section>`;
    try {
      const d = await fetchChain(L.sym, L.expiry, S.ctl.signal); S.chain = toChain(d); S.far = null;
      const sel2 = $('#ol-exp', body); if (sel2) sel2.innerHTML = '<option value="">Nearest saved</option>' + S.chain.expiries.map((x) => `<option ${x === S.chain.expiry ? 'selected' : ''}>${esc(x)}</option>`).join('');
      const next = S.chain.expiries[S.chain.expiries.indexOf(S.chain.expiry) + 1];
      if (next) { try { S.far = toChain(await fetchChain(L.sym, next, S.ctl.signal)); } catch (e) { S.far = null; } }
      rebuild();
    } catch (e) {
      if (e.name === 'AbortError') return;
      box.innerHTML = alert({ variant: 'destructive', title: 'Could not load the option chain', text: e.message, actionLabel: 'Try again', actionId: 'ol-retry' }); $('#ol-retry', box)?.addEventListener('click', run);
    } finally { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
  }

  const opts = () => ({ width: L.width, lots: L.lots, lot: L.lot || defaultLot(L.sym), asOf: S.chain.tradeDate ? Date.parse(`${S.chain.tradeDate}T10:00:00Z`) : Date.now() });
  function rebuild() {
    const box = $('#ol-result', body); if (!box || !S.chain) return;
    S.comp = compareOptionStrategies(S.chain, S.far, opts());
    try { S.st = buildStrategy(S.chain, L.key, { ...opts(), farChain: S.far }); S.an = analyse(S.st); } catch (e) { S.st = S.an = null; box.innerHTML = `<div class="grid gap-3">${alert({ variant: 'destructive', title: 'This strategy cannot be built here', text: e.message })}${compareCard()}</div>`; wireCompare(box); return; }
    paintResult(box); paintBook();
  }

  function legsTable(st) {
    return `<div class="scroll mt-2"><table class="tbl"><caption class="sr-only">Legs of the strategy</caption><thead><tr><th>Action</th><th class="num">Qty</th><th>Contract</th><th class="num">Premium</th><th class="num">IV</th><th>Expiry</th></tr></thead><tbody>${st.legs.map((l) => `<tr><td>${badge(l.side > 0 ? 'BUY' : 'SELL', { variant: l.side > 0 ? 'success' : 'danger' })}</td><td class="num">${l.qty * st.lots} × ${st.lot}</td>
      <td>${l.kind === 'U' ? `<b>${esc(L.sym)}</b> underlying (future or shares)` : `<b>${esc(L.sym)} ${money(l.strike, 0)} ${l.kind === 'C' ? 'CE' : 'PE'}</b>`}</td><td class="num">${money(l.price)}${l.estimated ? ' <span class="muted" title="No traded price in the file; estimated with Black-Scholes">est.</span>' : ''}</td><td class="num">${l.iv ? `${(l.iv * 100).toFixed(1)}%` : '—'}</td><td>${esc(l.expiry)}</td></tr>`).join('')}</tbody></table></div>`;
  }

  function paintResult(box) {
    const { st, an } = S, T = OPTION_STRATEGIES[st.key], big = (v, neg) => (Number.isFinite(v) ? sRupee(v) : neg ? 'Unlimited loss' : 'Unlimited');
    const src = S.chain.tradeDate ? `NSE end-of-day file, trading day ${esc(fmtDate(S.chain.tradeDate))}` : 'the saved chain';
    const gw = an.greeks;
    box.innerHTML = `<div class="grid gap-3"><section class="card" aria-live="polite"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="m-0">${esc(T.name)} on ${esc(L.sym)}</h2><p class="m-0 flex flex-wrap gap-2 text-xs text-muted-foreground">${badge(T.outlook)}${badge(T.group, { variant: 'outline' })}</p></div>
      <p class="mt-2 text-sm">${esc(T.idea)}</p><p class="m-0 text-sm"><b>Use when:</b> ${esc(T.whenToUse)}</p>
      <p class="m-0 mt-1 text-xs text-muted-foreground">${esc(L.sym)} at ${money(S.st.spot)} · expiry ${esc(S.chain.expiry)} (${Math.max(0, an.daysToExpiry).toFixed(0)} days) · premiums from ${src}${S.st.notes.length ? ` · ${esc(S.st.notes.join(' '))}` : ''}</p>
      ${legsTable(st)}
      <div class="mt-3 grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,9.5rem),1fr))">
        ${cell(an.debit ? 'You pay (debit)' : 'You receive (credit)', rupee(Math.abs(an.net)), an.debit ? 'net premium' : 'net premium', an.debit ? 'down' : 'up')}
        ${cell('Maximum profit', big(an.maxProfit), `<span title="${esc(T.maxGain)}">${esc(T.maxGain)}</span>`, Number.isFinite(an.maxProfit) ? 'up' : 'up')}
        ${cell('Maximum loss', big(an.maxLoss, true), `<span title="${esc(T.maxLoss)}">${esc(T.maxLoss)}</span>`, 'down')}
        ${cell('Break-even at expiry', an.breakevens.length ? an.breakevens.map((b) => money(b, 0)).join(' · ') : 'none', an.breakevens.length ? 'underlying price' : 'never crosses zero')}
        ${cell('Chance of profit', an.pop == null ? '—' : `${an.pop.toFixed(0)}%`, 'model estimate, not a forecast')}
        ${cell('Reward to risk', an.rewardRisk == null ? '—' : `${an.rewardRisk.toFixed(2)} : 1`, an.rewardRisk == null ? 'not finite' : 'max profit ÷ max loss')}
        ${cell('Net delta', `${gw.delta >= 0 ? '+' : '−'}${Math.abs(gw.delta).toFixed(1)}`, 'units of underlying')}
        ${cell('Time decay a day', sRupee(gw.theta), gw.theta >= 0 ? 'time helps you' : 'time hurts you', tone(gw.theta))}
        ${cell('Volatility +1 point', sRupee(gw.vega), gw.vega >= 0 ? 'gains if volatility rises' : 'loses if volatility rises', tone(gw.vega))}</div>
      ${an.unlimitedLoss ? `<div class="mt-3">${alert({ variant: 'warning', title: 'Unlimited risk', text: 'This position can lose far more than the premium collected. Real brokers demand large margin for it, which this lab does not model. Prefer a version with protective legs while learning.' })}</div>` : ''}
      ${an.estimated ? '<p class="m-0 mt-2 text-xs text-muted-foreground">Some premiums had no traded price in the file and are model estimates (marked est.).</p>' : ''}
      <div id="ol-chart" class="mt-3"></div>
      <div class="mt-3 grid gap-2 text-sm" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr))"><label class="grid gap-1">If the underlying is at<input id="ol-what" type="number" step="any" value="${Math.round(st.spot)}" class="${inp}"></label><div id="ol-what-out" class="self-end"></div></div>
      <p class="mt-2 text-sm"><b>What to learn:</b> ${esc(T.lesson)}</p>
      <div class="mt-2 flex flex-wrap gap-2"><button type="button" id="ol-save" class="${buttonClass({ size: 'sm' })}">${icon('briefcase', 16)}Save to my paper option book</button></div>
      <p class="mt-3 text-xs text-muted-foreground">How to read this: the solid line is the profit or loss at expiry (exact arithmetic on the premiums). The dashed line is what the position would be worth today if closed at each underlying price (Black-Scholes model with the chain’s implied volatility, 7% interest, no dividends). Brokerage, taxes, margin and early assignment are not included.</p></section>
      ${compareCard()}</div>`;
    drawChart($('#ol-chart', box));
    const what = () => { const v = +$('#ol-what', box).value; const out = $('#ol-what-out', box); if (!out || !(v > 0)) return; const a = pnlAt(st, v), b = pnlAt(st, v, 0); out.innerHTML = `At expiry: <b class="${tone(a)}">${sRupee(a)}</b>${analyseTime(st) > 0 ? ` · closed today: <b class="${tone(b)}">${sRupee(b)}</b>` : ''}`; };
    $('#ol-what', box).addEventListener('input', what); what();
    $('#ol-save', box).addEventListener('click', save);
    wireCompare(box);
  }
  const analyseTime = (st) => Math.min(...st.legs.filter((l) => l.kind !== 'U').map((l) => l.T), Infinity);

  function compareCard() {
    const rows = S.comp || [];
    return `<section class="card"><h2 class="m-0">Every strategy on the same chain</h2><p class="m-0 mt-1 text-xs text-muted-foreground">${esc(L.sym)} · expiry ${esc(S.chain ? S.chain.expiry : '')} · ${L.lots} lot${L.lots > 1 ? 's' : ''} of ${L.lot || defaultLot(L.sym)} · strike gap ${L.width}. Select a row to open it.</p>
      <div class="scroll mt-2"><table class="tbl"><caption class="sr-only">All option strategies compared</caption><thead><tr><th>Strategy</th><th>View</th><th class="num">Debit (−) / credit (+)</th><th class="num">Max profit</th><th class="num">Max loss</th><th class="num">Chance of profit</th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-open="${r.key}" tabindex="0" style="cursor:pointer" class="${S.st && r.key === S.st.key ? 'me' : ''}"><td><b>${esc(r.name)}</b></td><td>${esc(r.outlook)}</td><td class="num ${tone(-r.net)}">${sRupee(-r.net)}</td><td class="num up">${Number.isFinite(r.maxProfit) ? sRupee(r.maxProfit) : 'Unlimited'}</td><td class="num down">${Number.isFinite(r.maxLoss) ? sRupee(r.maxLoss) : 'Unlimited'}</td><td class="num">${r.pop == null ? '—' : `${r.pop.toFixed(0)}%`}</td></tr>`).join('')}</tbody></table></div></section>`;
  }
  function wireCompare(box) {
    const open = (key) => { L.key = key; persist(); const k = $('#ol-key', body); if (k) k.value = key; rebuild(); window.scrollTo({ top: body.getBoundingClientRect().top + scrollY - 70, behavior: 'smooth' }); };
    $$('[data-open]', box).forEach((tr) => { tr.addEventListener('click', () => open(tr.dataset.open)); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(tr.dataset.open); } }); });
  }

  /* ---------- chart ---------- */
  function drawChart(host) {
    const c = payoffCurves(S.st, S.an), xs = c.xs, W = Math.max(240, host.clientWidth || 720), H = Math.round(Math.min(320, Math.max(200, innerHeight * 0.42))), pl = 8, pr = 62, pt = 10, pb = 24;
    const all = [...c.expiry, ...(c.today || []), 0], lo = Math.min(...all), hi = Math.max(...all), padY = (hi - lo || 1) * 0.06, min = lo - padY, max = hi + padY;
    const x = (v) => pl + ((v - xs[0]) / (xs[xs.length - 1] - xs[0])) * (W - pl - pr), y = (v) => pt + (1 - (v - min) / (max - min)) * (H - pt - pb), y0 = y(0);
    const pts = (a) => a.map((v, i) => `${x(xs[i]).toFixed(1)},${y(v).toFixed(1)}`).join(' '), area = `${x(xs[0]).toFixed(1)},${y0.toFixed(1)} ${pts(c.expiry)} ${x(xs[xs.length - 1]).toFixed(1)},${y0.toFixed(1)}`;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => xs[0] + (xs[xs.length - 1] - xs[0]) * f);
    const grid = [min + (max - min) * 0.1, 0, max - (max - min) * 0.1].map((v) => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${W - pr + 6}" y="${y(v) + 4}" class="ax">${v === 0 ? '0' : compact(v)}</text>`).join('');
    host.innerHTML = `<div class="relative"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Profit and loss of the strategy at different underlying prices" id="ol-svg" tabindex="0" style="display:block">
      <defs><clipPath id="olc-up"><rect x="0" y="0" width="${W}" height="${Math.max(0, y0)}"/></clipPath><clipPath id="olc-dn"><rect x="0" y="${y0}" width="${W}" height="${Math.max(0, H - y0)}"/></clipPath></defs>
      ${grid}<polygon points="${area}" fill="var(--up)" opacity=".16" clip-path="url(#olc-up)"/><polygon points="${area}" fill="var(--down)" opacity=".16" clip-path="url(#olc-dn)"/>
      <line x1="${pl}" x2="${W - pr}" y1="${y0}" y2="${y0}" stroke="var(--text-muted)" stroke-width="1"/>
      ${ticks.map((v) => `<text x="${x(v)}" y="${H - 7}" class="ax" text-anchor="middle">${money(v, 0)}</text>`).join('')}
      ${c.today ? `<polyline fill="none" stroke="var(--series-3)" stroke-width="1.6" stroke-dasharray="5 4" points="${pts(c.today)}"/>` : ''}
      <polyline fill="none" stroke="var(--series-1)" stroke-width="2.4" points="${pts(c.expiry)}"/>
      <line x1="${x(c.spot)}" x2="${x(c.spot)}" y1="${pt}" y2="${H - pb}" stroke="var(--text-muted)" stroke-dasharray="2 3"/><text x="${x(c.spot)}" y="${pt + 8}" class="ax" text-anchor="middle">spot</text>
      ${c.breakevens.filter((b) => b >= xs[0] && b <= xs[xs.length - 1]).map((b) => `<circle cx="${x(b)}" cy="${y0}" r="4" fill="var(--bg)" stroke="var(--series-1)" stroke-width="2"/>`).join('')}
      <line id="olx" y1="${pt}" y2="${H - pb}" class="xh" style="display:none"/></svg><div id="oltip" class="chart-tip" style="display:none"></div></div>
      <p class="m-0 mt-1 flex flex-wrap gap-4 text-xs"><span class="inline-flex items-center gap-1"><span style="width:18px;height:0;border-top:3px solid var(--series-1)"></span>Profit or loss at expiry</span>${c.today ? '<span class="inline-flex items-center gap-1"><span style="width:18px;height:0;border-top:3px dashed var(--series-3)"></span>If closed today (model)</span>' : ''}<span class="inline-flex items-center gap-1"><span style="width:10px;height:10px;border-radius:50%;border:2px solid var(--series-1)"></span>Break-even</span></p>`;
    const svg = $('#ol-svg', host), tip = $('#oltip', host), cx = $('#olx', host), n = xs.length;
    const at = (clientX) => { const r = svg.getBoundingClientRect(), f = ((clientX - r.left) / r.width) * W; return Math.max(0, Math.min(n - 1, Math.round(((f - pl) / (W - pl - pr)) * (n - 1)))); };
    const show = (i) => { cx.setAttribute('x1', x(xs[i])); cx.setAttribute('x2', x(xs[i])); cx.style.display = ''; tip.style.display = ''; tip.style.left = `${Math.min(Math.max((x(xs[i]) / W) * svg.clientWidth + 10, 4), svg.clientWidth - 170)}px`;
      tip.innerHTML = `<b>Underlying ${money(xs[i], 0)}</b><br>At expiry: <span class="${tone(c.expiry[i])}">${sRupee(c.expiry[i])}</span>${c.today ? `<br>If closed today: <span class="${tone(c.today[i])}">${sRupee(c.today[i])}</span>` : ''}`; };
    svg.addEventListener('pointermove', (e) => show(at(e.clientX))); svg.addEventListener('pointerleave', () => { cx.style.display = tip.style.display = 'none'; });
    let k = Math.round(n / 2); svg.addEventListener('keydown', (e) => { const to = { ArrowLeft: k - 2, ArrowRight: k + 2, Home: 0, End: n - 1 }[e.key]; if (to !== undefined) { e.preventDefault(); k = Math.max(0, Math.min(n - 1, to)); show(k); } });
  }

  /* ---------- paper option book ---------- */
  function save() {
    const { st, an } = S, book = readBook();
    book.positions.push({ id: Date.now(), ts: Date.now(), sym: L.sym, expiry: S.chain.expiry, key: st.key, name: st.name, lot: st.lot, lots: st.lots, spot: st.spot, net: an.net, maxProfit: Number.isFinite(an.maxProfit) ? an.maxProfit : null, maxLoss: Number.isFinite(an.maxLoss) ? an.maxLoss : null,
      legs: st.legs.map((l) => ({ kind: l.kind, side: l.side, strike: l.strike, qty: l.qty, price: l.price, expiry: l.expiry })) });
    store.set(BOOK, book); toast.success('Saved to your paper option book', `${st.name} on ${L.sym}`); paintBook();
  }
  const bookChains = {};
  async function chainFor(sym, expiry) {
    const k = `${sym}|${expiry}`, hit = bookChains[k]; if (hit && Date.now() - hit.at < 60000) return hit.c;
    try { const d = await fetchChain(sym, expiry); const c = toChain(d); bookChains[k] = { at: Date.now(), c: c.expiry === expiry ? c : null }; return bookChains[k].c; } catch (e) { return null; }
  }
  async function paintBook() {
    const host = $('#ol-book', body); if (!host) return; const book = readBook();
    if (!book.positions.length && !book.closed?.length) { host.innerHTML = ''; return; }
    host.innerHTML = `<section class="card"><h2 class="m-0">My paper option book</h2><p class="m-0 mt-1 text-xs text-muted-foreground">Separate from your share portfolio: premiums are pretend and do not use its cash. Marked to the latest saved chain.</p><div id="ol-bk" class="mt-2">${skeletonRows(2)}</div></section>`;
    const rows = []; let openPnl = 0;
    for (const p of book.positions) {
      const exp = expiryMs(p.expiry), expired = exp != null && Date.now() > exp + 3600000, chain = expired ? null : await chainFor(p.sym, p.expiry);
      if (!isAlive()) return;
      const m = chain ? markToMarket(p, { [p.expiry]: chain, _spot: chain.spot }) : null; if (m && !m.missing) openPnl += m.pnl;
      rows.push({ p, expired, m });
    }
    const host2 = $('#ol-bk', body); if (!host2) return;
    const realized = book.realized || 0;
    host2.innerHTML = `<div class="mb-2 grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr))">${cell('Open positions', `${book.positions.length}`)}${cell('Open profit or loss', sRupee(openPnl), 'at latest premiums', tone(openPnl))}${cell('Realised', sRupee(realized), `${(book.closed || []).length} closed`, tone(realized))}</div>
      ${rows.length ? `<div class="scroll"><table class="tbl"><caption class="sr-only">Saved option positions</caption><thead><tr><th>Position</th><th>Expiry</th><th class="num">Entry (net)</th><th class="num">Now</th><th>Action</th></tr></thead><tbody>${rows.map(({ p, expired, m }) => `<tr><td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.sym)} · ${p.lots} lot${p.lots > 1 ? 's' : ''} · saved ${esc(fmtDate(new Date(p.ts).toISOString().slice(0, 10)))} · ${p.legs.map((l) => `${l.side > 0 ? '+' : '−'}${l.qty}${l.kind === 'U' ? ' UND' : ` ${money(l.strike, 0)}${l.kind === 'C' ? 'CE' : 'PE'}`}`).join(' ')}</span></td><td>${esc(p.expiry)}</td>
        <td class="num">${p.net >= 0 ? 'Paid' : 'Got'} ${rupee(Math.abs(p.net))}</td>
        <td class="num">${expired ? `<span class="muted">Expired: enter the settlement price</span><br><input type="number" step="any" min="0" data-settle-in="${p.id}" class="${inp}" style="width:8rem" aria-label="Settlement price for ${esc(p.name)}">` : m && !m.missing ? `<span class="${tone(m.pnl)}">${sRupee(m.pnl)}</span>` : '<span class="muted">no current prices</span>'}</td>
        <td>${expired ? `<button type="button" data-settle="${p.id}" class="${buttonClass({ size: 'sm' })}">Settle</button>` : `<button type="button" data-close="${p.id}" class="${buttonClass({ variant: 'outline', size: 'sm' })}" ${m && !m.missing ? '' : 'disabled'}>Close</button>`}
          <button type="button" data-del="${p.id}" class="${buttonClass({ variant: 'ghost', size: 'sm' })}" aria-label="Delete ${esc(p.name)}">${icon('trash-2', 14)}</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="m-0 text-sm text-muted-foreground">No open positions.</p>'}`;
    const finish = (id, pnl) => { const b = readBook(), i = b.positions.findIndex((x) => x.id === id); if (i < 0) return; const [p] = b.positions.splice(i, 1); b.closed = [...(b.closed || []), { ...p, pnl, closedAt: Date.now() }].slice(-200); b.realized = Math.round(((b.realized || 0) + pnl) * 100) / 100; store.set(BOOK, b); toast.success('Position closed', `${p.name}: ${sRupee(pnl)}`); paintBook(); };
    $$('[data-close]', host2).forEach((b) => b.addEventListener('click', () => { const r = rows.find((x) => String(x.p.id) === b.dataset.close); if (r && r.m && !r.m.missing) finish(r.p.id, r.m.pnl); }));
    $$('[data-settle]', host2).forEach((b) => b.addEventListener('click', () => { const r = rows.find((x) => String(x.p.id) === b.dataset.settle), v = +$(`[data-settle-in="${b.dataset.settle}"]`, host2).value; if (!(v > 0)) { toast.error('Enter the settlement price', 'The underlying’s closing price on the expiry day.'); return; } finish(r.p.id, settlePnl(r.p, v)); }));
    $$('[data-del]', host2).forEach((b) => b.addEventListener('click', async () => { if (!(await confirmDialog({ title: 'Delete this position?', text: 'It is removed without affecting your realised profit.', confirmLabel: 'Delete', danger: true }))) return; const bk = readBook(); bk.positions = bk.positions.filter((x) => String(x.id) !== b.dataset.del); store.set(BOOK, bk); paintBook(); }));
  }

  paintBook(); run();
}
