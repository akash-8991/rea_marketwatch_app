/* Paper trading page (lazy-loaded): a virtual portfolio at real NSE prices, an order ticket, and a strategy lab that runs textbook strategies over a stock's real
 * daily history. Everything here is for learning: no money moves, nothing is sent anywhere, and the account lives only in this browser (per signed-in user).
 * Rules and maths are in paper.js and strategies.js (unit-tested); this file is layout and wiring. */
import { $, $$, esc, money, signed, cls, arrow, compact, api, icon, store, fmtDate, debounce } from './lib.js';
import { tabs, bindTabs, buttonClass, statusBadge, alert, emptyCard, skeletonRows, toast, confirmDialog, badge, ago } from './ui.js';
import { newAccount, normalize, placeOrder, valuation, sharesFor, OrderError, START_CASH, FEE_PCT } from './paper.js';
import { STRATEGIES, backtest, compareAll, cleanParams, defaultParams } from './strategies.js';

const KEY = 'ml.paper', SERIES = ['var(--series-1)', 'var(--series-3)'];
const rupee = (n, d = 2) => `₹${money(n, d)}`;
const signedRupee = (n) => `${n >= 0 ? '+' : '−'}₹${money(Math.abs(n), 0)}`;
const PERIODS = [['6M', '6 months'], ['1Y', '1 year'], ['ALL', 'All NSE history (since Jan 2024)']];
const PERIOD_DAYS = { '6M': 183, '1Y': 366, ALL: 99999 };

export function mount(root, ctx) {
  const st = { tab: store.get('ml.paper.tab', 'portfolio'), acc: normalize(store.get(KEY, null)), prices: {}, quotes: {}, prefill: null, timer: 0, lab: store.get('ml.lab', { key: 'sma_cross', sym: 'INFY', period: '1Y', capital: START_CASH, feePct: FEE_PCT, slipPct: 0.05, params: {} }), result: null, ctl: null, alive: true };
  const save = () => store.set(KEY, st.acc);
  const heldSyms = () => Object.keys(st.acc.positions);

  /* ---------- prices ---------- */
  async function loadPrices(syms = heldSyms(), { fresh = false } = {}) {
    const list = [...new Set(syms)].slice(0, 50); if (!list.length) return;
    try {
      const r = await api(`/api/quotes?symbols=${encodeURIComponent(list.join(','))}${fresh ? '&fresh=1' : ''}`, { quiet: true, retries: 1 });
      r.quotes.forEach((q) => { st.quotes[q.sym] = q; if (q.price > 0 && q.status !== 'unavailable') st.prices[q.sym] = q.price; });
    } catch (e) { if (fresh) toast.error('Could not refresh prices', e.message); }
  }
  const tick = () => { clearTimeout(st.timer); if (!st.alive || !document.body.contains(root)) return; st.timer = setTimeout(async () => { if (!document.hidden && st.tab === 'portfolio') { await loadPrices(); if (st.tab === 'portfolio') paintPortfolio(); } tick(); }, 30000); };

  /* ---------- shell ---------- */
  function shell() {
    root.innerHTML = `<div class="grid gap-3"><div class="flex flex-wrap items-end justify-between gap-3"><div><h1 class="m-0">Paper trading</h1>
      <p class="m-0 mt-1 text-sm text-muted-foreground">Practise with ${rupee(START_CASH, 0)} of pretend money at real NSE prices. Learn how strategies behave before any real money is involved.</p></div>
      ${tabs([['portfolio', 'Portfolio'], ['trade', 'Trade'], ['lab', 'Strategy lab']], st.tab, { id: 'paper-tabs', label: 'Paper trading sections' })}</div><div id="paper-body"></div></div>`;
    bindTabs($('#paper-tabs', root), (t) => { st.tab = t; store.set('ml.paper.tab', t); paintTab(); });
  }
  function paintTab() { ({ portfolio: paintPortfolio, trade: paintTrade, lab: paintLab })[st.tab](); }
  const go = (tab) => { const btn = $(`#paper-tabs [data-tab="${tab}"]`, root); if (btn) btn.click(); else { st.tab = tab; paintTab(); } };

  /* ---------- portfolio ---------- */
  function paintPortfolio() {
    const body = $('#paper-body', root); if (!body) return;
    const v = valuation(st.acc, st.prices), a = st.acc;
    const stat = (label, value, sub = '', tone = '') => `<div class="rounded-lg border border-border bg-card p-3"><p class="m-0 text-xs text-muted-foreground">${esc(label)}</p><p class="m-0 text-xl font-bold tabular-nums ${tone}">${value}</p>${sub ? `<p class="m-0 text-xs text-muted-foreground">${sub}</p>` : ''}</div>`;
    const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
    const alloc = [['Cash', v.cashPct, 'var(--series-4)'], ...v.rows.map((r, i) => [r.sym, r.weightPct, ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-5)', 'var(--series-6)'][i % 5]])];
    body.innerHTML = `<div class="grid gap-3">
      <div class="grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(10.5rem,1fr))">
        ${stat('Total value', rupee(v.equity, 0), `Started with ${rupee(a.startCash, 0)}`)}${stat('Total profit / loss', `${signedRupee(v.totalPnl)}`, `<span class="${tone(v.returnPct)}">${signed(v.returnPct)}%</span>`, tone(v.totalPnl))}
        ${stat('Cash', rupee(a.cash, 0), `${v.cashPct.toFixed(0)}% of the account`)}${stat('Invested', rupee(v.invested, 0), `${v.rows.length} position${v.rows.length === 1 ? '' : 's'}`)}
        ${stat('Unrealised', signedRupee(v.unrealized), 'open positions', tone(v.unrealized))}${stat('Realised', signedRupee(v.realized), 'closed trades', tone(v.realized))}${stat('Fees paid', rupee(v.feesPaid, 0), `${FEE_PCT}% per trade`)}
      </div>
      <section class="card"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="m-0">Positions</h2><div class="flex gap-2">
        <button type="button" id="pp-refresh" class="${buttonClass({ variant: 'outline', size: 'sm' })}">${icon('refresh-cw', 14)}Refresh prices</button>
        <button type="button" id="pp-trade" class="${buttonClass({ size: 'sm' })}">${icon('plus', 14)}New order</button></div></div>
        ${v.rows.length ? `<div class="mt-2 flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label="Allocation: ${esc(alloc.map(([n, w]) => `${n} ${w.toFixed(0)} percent`).join(', '))}">${alloc.map(([n, w, c]) => `<span title="${esc(n)} ${w.toFixed(1)}%" style="width:${w}%;background:${c}"></span>`).join('')}</div>
        <div class="scroll mt-2"><table class="tbl"><caption class="sr-only">Open positions</caption><thead><tr><th>Stock</th><th class="num">Qty</th><th class="num">Avg cost</th><th class="num">Last</th><th class="num">Value</th><th class="num">P&amp;L ₹</th><th class="num">P&amp;L %</th><th class="num">Weight</th><th class="num"><span class="sr-only">Actions</span></th></tr></thead><tbody>
        ${v.rows.map((r) => `<tr><td><a href="#/quote/${encodeURIComponent(r.sym)}" class="font-semibold">${esc(r.sym)}</a></td><td class="num">${r.qty}</td><td class="num">${money(r.avg)}</td>
          <td class="num">${r.priced ? money(r.last) : '<span class="muted" title="No current price; shown at cost">—</span>'}</td><td class="num">${money(r.value, 0)}</td>
          <td class="num ${tone(r.pnl)}">${r.priced ? signedRupee(r.pnl) : '—'}</td><td class="num ${tone(r.pnl)}">${r.priced ? `${arrow(r.pnl)} ${Math.abs(r.pnlPct).toFixed(2)}%` : '—'}</td><td class="num">${r.weightPct.toFixed(1)}%</td>
          <td class="num"><button type="button" data-sell="${esc(r.sym)}" class="${buttonClass({ variant: 'outline', size: 'sm' })}">Sell</button></td></tr>`).join('')}</tbody></table></div>`
        : emptyCard({ iconName: 'briefcase', title: 'No open positions', text: 'Place a paper order, or test a strategy in the Strategy lab first.', action: `<div class="flex flex-wrap justify-center gap-2"><button type="button" data-go="trade" class="${buttonClass()}">Place an order</button><button type="button" data-go="lab" class="${buttonClass({ variant: 'outline' })}">Open the strategy lab</button></div>` })}
      </section>
      <section class="card"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="m-0">Trade history</h2><div class="flex gap-2">
        <button type="button" id="pp-csv" class="${buttonClass({ variant: 'outline', size: 'sm' })}" ${a.trades.length ? '' : 'disabled'}>${icon('download', 14)}Download CSV</button>
        <button type="button" id="pp-reset" class="${buttonClass({ variant: 'outline', size: 'sm' })}">${icon('rotate-ccw', 14)}Reset account</button></div></div>
        ${a.trades.length ? `<div class="scroll mt-2"><table class="tbl"><caption class="sr-only">Trade history, newest first</caption><thead><tr><th>#</th><th>Time</th><th>Side</th><th>Stock</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Fee</th><th class="num">Realised P&amp;L</th><th>Note</th></tr></thead><tbody>
        ${[...a.trades].reverse().slice(0, 40).map((t) => `<tr><td>${t.id}</td><td>${esc(new Date(t.ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td><td>${badge(t.side, { variant: t.side === 'BUY' ? 'success' : 'danger' })}</td>
          <td><a href="#/quote/${encodeURIComponent(t.sym)}">${esc(t.sym)}</a></td><td class="num">${t.qty}</td><td class="num">${money(t.price)}</td><td class="num">${money(t.fee)}</td><td class="num ${t.pnl == null ? '' : tone(t.pnl)}">${t.pnl == null ? '—' : signedRupee(t.pnl)}</td><td class="co">${esc(t.strategy ? `${STRATEGIES[t.strategy]?.name || t.strategy}` : t.note || '')}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted mt-2">No trades yet.</p>'}</section></div>`;
    $$('[data-go]', body).forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
    $$('[data-sell]', body).forEach((b) => b.addEventListener('click', () => { st.prefill = { sym: b.dataset.sell, side: 'SELL' }; go('trade'); }));
    $('#pp-trade', body)?.addEventListener('click', () => go('trade'));
    $('#pp-refresh', body)?.addEventListener('click', async () => { await loadPrices(heldSyms(), { fresh: true }); paintPortfolio(); toast.success('Prices refreshed', '', { duration: 1500 }); });
    $('#pp-csv', body)?.addEventListener('click', () => downloadCsv());
    $('#pp-reset', body)?.addEventListener('click', async () => { if (await confirmDialog({ title: 'Reset the paper account?', text: `All positions and the trade history are deleted and the account restarts with ${rupee(START_CASH, 0)}. This cannot be undone.`, confirmLabel: 'Reset', danger: true })) { st.acc = newAccount(); save(); paintPortfolio(); toast.info('Paper account reset'); } });
  }
  function downloadCsv() {
    const esc2 = (x) => { const s = String(x ?? ''); return /^[=+\-@]/.test(s) ? `'${s}` : s; };   // spreadsheet formulas are neutralised
    const rows = [['id', 'time', 'side', 'symbol', 'qty', 'price', 'fee', 'realised_pnl', 'note'], ...st.acc.trades.map((t) => [t.id, new Date(t.ts).toISOString(), t.side, t.sym, t.qty, t.price, t.fee, t.pnl ?? '', t.strategy || t.note || ''])];
    const blob = new Blob([rows.map((r) => r.map((c) => `"${esc2(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'paper-trades.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------- order ticket ---------- */
  function paintTrade() {
    const body = $('#paper-body', root); if (!body) return;
    const pf = st.prefill || {}; st.prefill = null;
    const form = { sym: pf.sym || store.get('ml.paper.sym', 'INFY'), side: pf.side || 'BUY', qty: pf.qty || '', note: pf.note || '', strategy: pf.strategy || '' };
    body.innerHTML = `<div class="grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr))">
      <section class="card"><h2 class="m-0">Order ticket</h2>
        <form id="ticket" class="mt-3 grid gap-3" autocomplete="off" novalidate>
          <label class="grid gap-1 text-sm">Stock (NSE symbol)<input id="tk-sym" list="tk-sugg" value="${esc(form.sym)}" maxlength="24" class="h-9 rounded-md border border-input bg-card px-3" aria-describedby="tk-price"></label><datalist id="tk-sugg"></datalist>
          <div role="radiogroup" aria-label="Side" class="grid grid-cols-2 gap-2"><button type="button" role="radio" data-side="BUY" aria-checked="${form.side === 'BUY'}" class="${buttonClass({ variant: form.side === 'BUY' ? 'default' : 'outline' })}">Buy</button>
            <button type="button" role="radio" data-side="SELL" aria-checked="${form.side === 'SELL'}" class="${buttonClass({ variant: form.side === 'SELL' ? 'destructive' : 'outline' })}">Sell</button></div>
          <label class="grid gap-1 text-sm">Quantity (whole shares)<input id="tk-qty" type="number" min="1" step="1" inputmode="numeric" value="${esc(form.qty)}" class="h-9 rounded-md border border-input bg-card px-3"></label>
          <div class="flex flex-wrap gap-2" aria-label="Quick quantity">${[['10%', 0.1], ['25%', 0.25], ['50%', 0.5], ['Max', 1]].map(([l, f]) => `<button type="button" data-frac="${f}" class="${buttonClass({ variant: 'outline', size: 'sm' })}">${l}</button>`).join('')}</div>
          <div id="tk-sum" class="rounded-md bg-muted p-3 text-sm" aria-live="polite"></div><p id="tk-err" class="m-0 text-sm text-down" role="alert"></p>
          <button type="submit" id="tk-go" class="${buttonClass({ size: 'lg' })}">Place paper order</button></form></section>
      <section class="card"><h2 class="m-0">Price</h2><div id="tk-price" class="mt-3" aria-live="polite">${skeletonRows(2)}</div>
        <p class="mt-3 text-xs text-muted-foreground">Orders fill at the latest NSE price (the last close when the market is shut), plus a ${FEE_PCT}% fee. Whole shares only; no short selling, no borrowing.</p>
        <div class="mt-3"><h3 class="m-0 text-sm">Your cash</h3><p class="m-0 text-xl font-bold tabular-nums">${rupee(st.acc.cash, 0)}</p></div></section></div>`;
    const sym = () => $('#tk-sym', body).value.trim().toUpperCase(), qty = () => parseInt($('#tk-qty', body).value, 10);
    const q = () => st.quotes[sym()];
    function summary() {
      const px = q()?.price, n = qty(), side = form.side, held = st.acc.positions[sym()]?.qty || 0; let err = '';
      const sum = $('#tk-sum', body);
      if (!px || !Number.isInteger(n) || n < 1) { sum.innerHTML = '<span class="text-muted-foreground">Enter a stock and a quantity to see the cost.</span>'; $('#tk-go', body).disabled = !px; $('#tk-err', body).textContent = ''; return; }
      const value = n * px, fee = value * FEE_PCT / 100;
      if (side === 'BUY' && value + fee > st.acc.cash) err = `Not enough cash: needs ${rupee(value + fee)}, you have ${rupee(st.acc.cash)}.`;
      if (side === 'SELL' && n > held) err = held ? `You hold only ${held} share${held > 1 ? 's' : ''} of ${sym()}.` : `You do not hold ${sym()}; short selling is not allowed.`;
      const q0 = q(); if (q0 && (q0.status === 'stale' || q0.status === 'unavailable')) err = err || 'This price is not current, so orders are blocked until a fresh price arrives.';
      sum.innerHTML = `<div class="flex justify-between"><span>${side === 'BUY' ? 'Cost' : 'Proceeds'}</span><b class="tabular-nums">${rupee(value)}</b></div><div class="flex justify-between"><span>Fee (${FEE_PCT}%)</span><b class="tabular-nums">${rupee(fee)}</b></div>
        <div class="flex justify-between border-t border-border pt-1"><span>${side === 'BUY' ? 'Total' : 'Net'}</span><b class="tabular-nums">${rupee(side === 'BUY' ? value + fee : value - fee)}</b></div><div class="flex justify-between text-muted-foreground"><span>Cash after</span><span class="tabular-nums">${rupee(st.acc.cash + (side === 'BUY' ? -(value + fee) : value - fee), 0)}</span></div>`;
      $('#tk-err', body).textContent = err; $('#tk-go', body).disabled = !!err;
    }
    function priceCard() {
      const box = $('#tk-price', body), s = sym(), x = st.quotes[s];
      if (!x) { box.innerHTML = skeletonRows(2); return; }
      if (x.status === 'unavailable') { box.innerHTML = alert({ variant: 'destructive', title: `No price for ${s}`, text: x.reason || 'NSE returned nothing for this symbol.' }); return; }
      box.innerHTML = `<div class="flex flex-wrap items-baseline gap-3"><span class="big">${money(x.price)}</span><span class="${cls(x.chg ?? 0)} font-semibold">${x.chg == null ? '' : `${arrow(x.chg)} ${signed(x.chg)}%`}</span>${statusBadge(x.status, x.reason || '')}</div>
        <p class="m-0 mt-1 text-sm text-muted-foreground">${esc(x.name || '')}${x.ts ? ` · last trade ${esc(x.ts)}` : ''}</p>${x.status === 'closed' ? '<p class="m-0 mt-1 text-sm">The market is closed: orders fill at the last close.</p>' : ''}${x.status === 'stale' ? alert({ variant: 'warning', title: 'Saved price', text: 'NSE could not be reached.' }) : ''}`;
    }
    const lookup = debounce(async () => { const s = sym(); if (!/^[A-Z0-9&_-]{1,24}$/.test(s)) return; store.set('ml.paper.sym', s); await loadPrices([s]); priceCard(); summary(); }, 250);
    $('#tk-sym', body).addEventListener('input', () => { priceCard(); lookup(); const v = sym(); if (v.length >= 2) api(`/api/search?q=${encodeURIComponent(v)}`, { quiet: true, retries: 0 }).then((r) => { const dl = $('#tk-sugg', body); if (dl) dl.innerHTML = r.results.slice(0, 8).map((x) => `<option value="${esc(x.symbol)}">${esc(x.name || '')}</option>`).join(''); }).catch(() => {}); });
    $('#tk-qty', body).addEventListener('input', summary);
    $$('[data-side]', body).forEach((b) => b.addEventListener('click', () => { form.side = b.dataset.side; $$('[data-side]', body).forEach((x) => { const on = x === b; x.setAttribute('aria-checked', on); x.className = buttonClass({ variant: on ? (x.dataset.side === 'BUY' ? 'default' : 'destructive') : 'outline' }); }); summary(); }));
    $$('[data-frac]', body).forEach((b) => b.addEventListener('click', () => {
      const px = q()?.price; if (!px) return; const f = +b.dataset.frac;
      const n = form.side === 'BUY' ? sharesFor(st.acc.cash * f, px) : Math.floor((st.acc.positions[sym()]?.qty || 0) * f);
      $('#tk-qty', body).value = n || ''; summary();
    }));
    $('#ticket', body).addEventListener('submit', async (e) => {
      e.preventDefault(); const s = sym(), n = qty(), btn = $('#tk-go', body); btn.disabled = true;
      try {
        await loadPrices([s], { fresh: true }); const x = st.quotes[s];                       // the fill price is fetched at the moment of the order
        if (!x || x.status === 'unavailable' || x.status === 'stale') throw new OrderError('There is no current price for this symbol, so the order was not placed.');
        const { account, trade } = placeOrder(st.acc, { sym: s, side: form.side, qty: n, price: x.price, note: form.note, strategy: form.strategy });
        st.acc = account; save();
        toast.success(`${trade.side === 'BUY' ? 'Bought' : 'Sold'} ${trade.qty} ${trade.sym} at ${rupee(trade.price)}`, `Fee ${rupee(trade.fee)}${trade.pnl != null ? ` · realised ${signedRupee(trade.pnl)}` : ''}`);
        go('portfolio');
      } catch (err) { if (err instanceof OrderError) { $('#tk-err', body).textContent = err.message; toast.error('Order not placed', err.message); } else toast.error('Order failed', err.message); btn.disabled = false; }
    });
    loadPrices([sym()]).then(() => { priceCard(); if (pf.qty === undefined && pf.side === 'SELL') { const h = st.acc.positions[sym()]?.qty; if (h) $('#tk-qty', body).value = h; } summary(); });
    if (pf.qty) summary();
  }

  /* ---------- strategy lab ---------- */
  function paintLab() {
    const body = $('#paper-body', root); if (!body) return;
    const L = st.lab, S = STRATEGIES[L.key], params = { ...defaultParams(L.key), ...(L.params[L.key] || {}) };
    body.innerHTML = `<div class="grid gap-3"><section class="card"><h2 class="m-0">Run a strategy on real history</h2>
      <form id="lab-form" class="mt-3 grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))" autocomplete="off" novalidate>
        <label class="grid gap-1 text-sm">Strategy<select id="lab-key" class="h-9 rounded-md border border-input bg-card px-2">${Object.entries(STRATEGIES).map(([k, s]) => `<option value="${k}" ${k === L.key ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="grid gap-1 text-sm">Stock<input id="lab-sym" list="lab-sugg" value="${esc(L.sym)}" maxlength="24" class="h-9 rounded-md border border-input bg-card px-3"></label><datalist id="lab-sugg"></datalist>
        <label class="grid gap-1 text-sm">Period<select id="lab-period" class="h-9 rounded-md border border-input bg-card px-2">${PERIODS.map(([k, l]) => `<option value="${k}" ${k === L.period ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <label class="grid gap-1 text-sm">Starting money (₹)<input id="lab-cap" type="number" min="10000" step="10000" value="${L.capital}" class="h-9 rounded-md border border-input bg-card px-3"></label>
        <label class="grid gap-1 text-sm">Fee per trade (%)<input id="lab-fee" type="number" min="0" max="2" step="0.01" value="${L.feePct}" class="h-9 rounded-md border border-input bg-card px-3"></label>
        <label class="grid gap-1 text-sm">Slippage (%)<input id="lab-slip" type="number" min="0" max="2" step="0.01" value="${L.slipPct}" class="h-9 rounded-md border border-input bg-card px-3"></label>
        ${S.params.map(([k, label, , lo, hi]) => `<label class="grid gap-1 text-sm">${esc(label)}<input data-param="${k}" type="number" min="${lo}" max="${hi}" step="${k === 'k' ? 0.5 : 1}" value="${params[k]}" class="h-9 rounded-md border border-input bg-card px-3"></label>`).join('')}
        <div class="flex items-end"><button type="submit" id="lab-run" class="${buttonClass({ size: 'lg', extra: 'w-full' })}">${icon('play', 16)}Run strategy</button></div></form></section>
      <section class="card"><h2 class="m-0">${esc(S.name)}</h2><div class="mt-2 grid gap-2 text-sm" style="grid-template-columns:repeat(auto-fit,minmax(15rem,1fr))">
        <p class="m-0 sm:col-span-2" style="grid-column:1/-1"><b>The idea.</b> ${esc(S.idea)}</p><p class="m-0"><b>Buys when:</b> ${esc(S.buy)}</p><p class="m-0"><b>Sells when:</b> ${esc(S.sell)}</p>
        <p class="m-0"><b>Works when:</b> ${esc(S.works)}</p><p class="m-0"><b>Struggles when:</b> ${esc(S.fails)}</p><p class="m-0" style="grid-column:1/-1"><b>What to learn:</b> ${esc(S.lesson)}</p></div>
        <p class="mt-3 text-xs text-muted-foreground">Rules of the simulation: a signal is read at the close of a day and acts at the next day’s close; all-in or all-out in whole shares; long only; the same fee and slippage on every trade; compared with buying on day one and holding.</p></section>
      <div id="lab-result"></div></div>`;
    const read = () => {
      L.key = $('#lab-key', body).value; L.sym = $('#lab-sym', body).value.trim().toUpperCase(); L.period = $('#lab-period', body).value;
      L.capital = Math.max(10000, +$('#lab-cap', body).value || START_CASH); L.feePct = Math.min(2, Math.max(0, +$('#lab-fee', body).value || 0)); L.slipPct = Math.min(2, Math.max(0, +$('#lab-slip', body).value || 0));
      const p = {}; $$('[data-param]', body).forEach((i) => { p[i.dataset.param] = i.value; }); L.params[L.key] = cleanParams(L.key, p); store.set('ml.lab', L);
    };
    $('#lab-key', body).addEventListener('change', () => { read(); paintLab(); });
    $('#lab-sym', body).addEventListener('input', debounce((e) => { const v = e.target.value.trim(); if (v.length >= 2) api(`/api/search?q=${encodeURIComponent(v)}`, { quiet: true, retries: 0 }).then((r) => { const dl = $('#lab-sugg', body); if (dl) dl.innerHTML = r.results.slice(0, 8).map((x) => `<option value="${esc(x.symbol)}">${esc(x.name || '')}</option>`).join(''); }).catch(() => {}); }, 200));
    $('#lab-form', body).addEventListener('submit', (e) => { e.preventDefault(); read(); runLab(); });
    if (st.result && st.result.sym === L.sym && st.result.key === L.key) paintResult();
  }

  async function runLab() {
    const L = st.lab, box = $('#lab-result', root); if (!box) return;
    if (!/^[A-Z0-9&_-]{1,24}$/.test(L.sym)) { box.innerHTML = alert({ variant: 'destructive', title: 'Invalid symbol', text: 'Use an NSE symbol such as INFY.' }); return; }
    st.ctl?.abort(); st.ctl = new AbortController(); const run = $('#lab-run', root); if (run) { run.disabled = true; run.setAttribute('aria-busy', 'true'); }
    box.innerHTML = `<section class="card">${skeletonRows(5)}<p class="m-0 mt-2 text-sm text-muted-foreground">Loading ${esc(L.sym)} price history from NSE… (the first time can take a few seconds)</p></section>`;
    try {
      const h = await api(`/api/history/${encodeURIComponent(L.sym)}?range=5Y`, { quiet: true, retries: 1, timeoutMs: 60000, signal: st.ctl.signal });
      if (!h.available) throw new Error(h.reason || 'no price history for this symbol');
      const cutoff = new Date(Date.now() - PERIOD_DAYS[L.period] * 86400000).toISOString().slice(0, 10), points = h.points.filter((p) => p[0] >= cutoff).map((p) => [p[0], p[1]]);
      const opts = { capital: L.capital, feePct: L.feePct, slipPct: L.slipPct };
      const r = backtest(points, L.key, L.params[L.key] || {}, opts);
      st.result = { sym: L.sym, key: L.key, r, all: compareAll(points, opts), opts, truncated: h.truncated, earliest: h.earliest, first: points[0][0], last: points[points.length - 1][0], points: points.length };
      paintResult();
    } catch (e) {
      if (e.name === 'AbortError') return;
      box.innerHTML = alert({ variant: 'destructive', title: 'Could not run the strategy', text: e.message, actionLabel: 'Try again', actionId: 'lab-retry' }); $('#lab-retry', box)?.addEventListener('click', runLab);
    } finally { if (run) { run.disabled = false; run.removeAttribute('aria-busy'); } }
  }

  function curveChart(host, series) {
    const W = Math.max(300, host.clientWidth || 720), H = 260, pl = 8, pr = 64, pt = 10, pb = 22, n = series[0].data.length;
    const all = series.flatMap((s) => s.data.map((d) => d[1])), min = Math.min(...all), max = Math.max(...all), span = max - min || 1;
    const x = (i) => pl + (i / (n - 1 || 1)) * (W - pl - pr), y = (v) => pt + (1 - (v - min) / span) * (H - pt - pb);
    const path = (d) => d.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
    const grid = [0, 0.5, 1].map((f) => { const v = min + span * f; return `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${W - pr + 6}" y="${y(v) + 4}" class="ax">${compact(v)}</text>`; }).join('');
    host.innerHTML = `<div class="relative"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Account value over time, strategy versus buy and hold" id="curve" tabindex="0" style="display:block">${grid}
      <text x="${pl}" y="${H - 6}" class="ax">${esc(fmtDate(series[0].data[0][0]))}</text><text x="${W - pr}" y="${H - 6}" class="ax" text-anchor="end">${esc(fmtDate(series[0].data[n - 1][0]))}</text>
      ${series.map((s, k) => `<polyline fill="none" stroke="${SERIES[k]}" stroke-width="${k === 0 ? 2.2 : 1.6}" ${k ? 'stroke-dasharray="5 4"' : ''} points="${path(s.data)}"/>`).join('')}<line id="cx" y1="${pt}" y2="${H - pb}" class="xh" style="display:none"/></svg><div id="ctip" class="chart-tip" style="display:none"></div></div>
      <p class="m-0 mt-1 flex flex-wrap gap-4 text-xs">${series.map((s, k) => `<span class="inline-flex items-center gap-1"><span style="width:18px;height:0;border-top:3px ${k ? 'dashed' : 'solid'} ${SERIES[k]}"></span>${esc(s.name)}</span>`).join('')}</p>`;
    const svg = $('#curve', host), tip = $('#ctip', host), cx = $('#cx', host);
    const at = (clientX) => { const r = svg.getBoundingClientRect(), f = ((clientX - r.left) / r.width) * W; return Math.max(0, Math.min(n - 1, Math.round(((f - pl) / (W - pl - pr)) * (n - 1)))); };
    const show = (i) => { cx.setAttribute('x1', x(i)); cx.setAttribute('x2', x(i)); cx.style.display = ''; tip.style.display = ''; tip.style.left = `${Math.min(Math.max((x(i) / W) * svg.clientWidth + 10, 4), svg.clientWidth - 160)}px`;
      tip.innerHTML = `<b>${esc(fmtDate(series[0].data[i][0]))}</b>${series.map((s, k) => `<br><span style="color:${SERIES[k]}">●</span> ${esc(s.name)}: ${rupee(s.data[i][1], 0)}`).join('')}`; };
    svg.addEventListener('pointermove', (e) => show(at(e.clientX))); svg.addEventListener('pointerleave', () => { cx.style.display = tip.style.display = 'none'; });
    let k = n - 1; svg.addEventListener('keydown', (e) => { const to = { ArrowLeft: k - 1, ArrowRight: k + 1, Home: 0, End: n - 1 }[e.key]; if (to !== undefined) { e.preventDefault(); k = Math.max(0, Math.min(n - 1, to)); show(k); } });
  }

  function paintResult() {
    const box = $('#lab-result', root); if (!box || !st.result) return; const { r, all, sym, opts } = st.result, m = r.metrics, S = STRATEGIES[r.key];
    const t = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : ''), pct = (n) => (n == null ? '—' : `${signed(n)}%`);
    const cell = (label, value, sub = '', tone = '') => `<div class="rounded-lg border border-border bg-card p-3"><p class="m-0 text-xs text-muted-foreground">${esc(label)}</p><p class="m-0 text-lg font-bold tabular-nums ${tone}">${value}</p>${sub ? `<p class="m-0 text-xs text-muted-foreground">${sub}</p>` : ''}</div>`;
    const verdict = m.excessPct >= 0 ? `beat buy-and-hold by ${m.excessPct.toFixed(2)} percentage points` : `trailed buy-and-hold by ${Math.abs(m.excessPct).toFixed(2)} percentage points`;
    const held = st.acc.positions[sym]?.qty || 0;
    box.innerHTML = `<div class="grid gap-3"><section class="card" aria-live="polite"><div class="flex flex-wrap items-center justify-between gap-2"><h2 class="m-0">${esc(S.name)} on ${esc(sym)}</h2><p class="m-0 text-xs text-muted-foreground">${esc(fmtDate(st.result.first))} to ${esc(fmtDate(st.result.last))} · ${st.result.points} trading days</p></div>
      <p class="mt-2 text-sm">Starting with ${rupee(opts.capital, 0)}, the strategy ended at <b>${rupee(m.finalValue, 0)}</b> (<span class="${t(m.returnPct)}">${pct(m.returnPct)}</span>) and ${verdict} (<span class="${t(m.buyHoldPct)}">${pct(m.buyHoldPct)}</span>).</p>
      ${st.result.truncated ? `<p class="m-0 text-xs text-muted-foreground">NSE’s history starts on ${esc(fmtDate(st.result.earliest))}, so that is as far back as this test can go.</p>` : ''}
      <div class="mt-3 grid gap-3" style="grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))">
        ${cell('Strategy return', pct(m.returnPct), m.cagrPct != null ? `${pct(m.cagrPct)} a year` : 'less than a year', t(m.returnPct))}${cell('Buy and hold', pct(m.buyHoldPct), `worst fall ${pct(m.buyHoldDrawdownPct)}`, t(m.buyHoldPct))}
        ${cell('Worst fall', pct(m.maxDrawdownPct), 'peak to trough', 'down')}${cell('Closed trades', `${m.roundTrips}`, `${m.winRatePct == null ? 'none closed yet' : `${m.winRatePct.toFixed(0)}% winners`}${r.today.open ? ' · 1 still open' : ''}`)}
        ${cell('Average trade', pct(m.avgTradePct), 'per round trip', t(m.avgTradePct))}${cell('Time invested', `${m.exposurePct.toFixed(0)}%`, 'of the days')}${cell('Costs paid', rupee(m.feesPaid, 0), `${opts.feePct}% fee + ${opts.slipPct}% slippage`)}</div>
      <div id="curve-host" class="mt-3"></div></section>
      <section class="card"><h2 class="m-0">Today’s position</h2><p class="mt-2 text-sm">${r.today.position === 'long' ? `The strategy is <b class="up">invested</b>${r.today.since ? ` since ${esc(fmtDate(r.today.since))}` : ''}.` : `The strategy is <b>in cash</b>${r.today.since ? ` since ${esc(fmtDate(r.today.since))}` : ''}.`}</p>
        <div class="flex flex-wrap gap-2"><button type="button" id="lab-buy" class="${buttonClass({ size: 'sm' })}" ${r.today.position === 'long' ? '' : 'disabled'}>Paper-buy ${esc(sym)} (10% of the account)</button>
          <button type="button" id="lab-sell" class="${buttonClass({ variant: 'outline', size: 'sm' })}" ${held ? '' : 'disabled'}>Paper-sell my ${held ? held + ' ' : ''}${esc(sym)}</button></div></section>
      <section class="card"><h2 class="m-0">Every trade</h2>${r.trades.length ? `<div class="scroll mt-2"><table class="tbl"><thead><tr><th>Date</th><th>Side</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Fee</th><th class="num">Result</th></tr></thead><tbody>${r.trades.map((tr) => `<tr><td>${esc(fmtDate(tr.date))}</td><td>${badge(tr.side, { variant: tr.side === 'BUY' ? 'success' : 'danger' })}</td><td class="num">${money(tr.price)}</td><td class="num">${tr.qty}</td><td class="num">${money(tr.fee)}</td><td class="num ${tr.pnl == null ? '' : t(tr.pnl)}">${tr.pnl == null ? '—' : `${signedRupee(tr.pnl)} (${pct(tr.pct)})`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted mt-2">The strategy never traded on this data.</p>'}</section>
      <section class="card"><h2 class="m-0">The same stock, every strategy</h2><p class="m-0 mt-1 text-xs text-muted-foreground">Each with its default settings and the same costs, over the same days. Select a row to open that strategy.</p>
        <div class="scroll mt-2"><table class="tbl"><thead><tr><th>Strategy</th><th class="num">Return</th><th class="num">Vs buy &amp; hold</th><th class="num">Worst fall</th><th class="num">Trades</th><th class="num">Winners</th><th class="num">Invested</th><th>Today</th></tr></thead><tbody>
        ${all.map((a) => `<tr data-open="${a.key}" tabindex="0" style="cursor:pointer" class="${a.key === r.key ? 'me' : ''}"><td><b>${esc(a.name)}</b></td>${a.error ? `<td colspan="7" class="muted">${esc(a.error)}</td>` : `<td class="num ${t(a.returnPct)}">${pct(a.returnPct)}</td><td class="num ${t(a.excessPct)}">${pct(a.excessPct)}</td><td class="num down">${pct(a.maxDrawdownPct)}</td><td class="num">${a.roundTrips}</td><td class="num">${a.winRatePct == null ? '—' : a.winRatePct.toFixed(0) + '%'}</td><td class="num">${a.exposurePct.toFixed(0)}%</td><td>${a.today === 'long' ? 'Invested' : 'Cash'}</td>`}</tr>`).join('')}</tbody></table></div></section></div>`;
    curveChart($('#curve-host', box), [{ name: `${S.name}`, data: r.equity }, { name: 'Buy and hold', data: r.buyHold }]);
    $('#lab-buy', box)?.addEventListener('click', async () => { await loadPrices([sym]); const px = st.prices[sym]; const v = valuation(st.acc, st.prices); st.prefill = { sym, side: 'BUY', strategy: r.key, qty: px ? sharesFor(v.equity * 0.1, px) : '' }; go('trade'); });
    $('#lab-sell', box)?.addEventListener('click', () => { st.prefill = { sym, side: 'SELL', strategy: r.key, qty: held }; go('trade'); });
    const open = (key) => { st.lab.key = key; store.set('ml.lab', st.lab); paintLab(); runLab(); };
    $$('[data-open]', box).forEach((tr) => { tr.addEventListener('click', () => open(tr.dataset.open)); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(tr.dataset.open); } }); });
  }

  shell(); paintTab(); loadPrices().then(() => { if (st.tab === 'portfolio') paintPortfolio(); }); tick();
  return () => { st.alive = false; clearTimeout(st.timer); st.ctl?.abort(); };
}
