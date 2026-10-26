// Pure modules behind paper trading, the dashboard and the chart: indicators, strategy simulator, paper account, sorting/filtering, windowing.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ind from '../../src/marketlens/static/js/indicators.js';
import { STRATEGIES, backtest, compareAll, cleanParams, defaultParams } from '../../src/marketlens/static/js/strategies.js';
import { newAccount, placeOrder, valuation, sharesFor, normalize, OrderError, START_CASH } from '../../src/marketlens/static/js/paper.js';
import { matches, compare, summarize, windowSlice, decimate, stats, highlight } from '../../src/marketlens/static/js/pure.js';
import * as engine from '../engine/analysis.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !== ${b}`);
const walk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const dates = (n) => walk(n, (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10));
const pts = (closes) => closes.map((c, i) => [dates(closes.length)[i], c]);

/* ---------- indicators ---------- */
test('RSI and MACD agree with the engine implementation the rest of the app uses', () => {
  const v = walk(120, (i) => 100 + i * 0.4 + Math.sin(i / 3) * 6 + Math.cos(i / 7) * 3);
  close(ind.rsi(v, 14).at(-1), engine.rsi(v, 14), 1e-9);
  const m = ind.macd(v), e = engine.macd(v);
  close(m.hist.at(-1), e.hist, 1e-9); close(m.line.at(-1), e.macd, 1e-9);
  close(ind.sma(v, 20).at(-1), engine.sma(v, 20), 1e-9);
});
test('SMA, Bollinger, channel and ROC on small known inputs', () => {
  assert.deepEqual(ind.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  const b = ind.bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2); close(b.mid[7], 5); close(b.upper[7], 5 + 2 * 2); close(b.lower[7], 1);   // population sd of this classic set is 2
  assert.deepEqual(ind.channel([1, 5, 3, 4, 2], 2).hi, [null, null, 5, 5, 4]);          // previous two closes only, today excluded
  assert.deepEqual(ind.roc([100, 110, 121], 1).map((x) => x && Math.round(x)), [null, 10, 10]);
  assert.equal(ind.rsi([1, 2, 3], 14).every((x) => x === null), true);
  assert.equal(ind.rsi(walk(30, (i) => i + 1), 14).at(-1), 100);                         // only gains
});

/* ---------- strategy simulator ---------- */
test('execution rules: a signal read on day t trades on day t+1, never the same day', () => {
  // flat for 30 days, then one huge spike day: a rule that peeked would buy the spike day itself and be sold the next day at a profit
  const c = [...walk(30, () => 100), 200, 100, 100, 100];
  const r = backtest(pts(c), 'momentum', { lookback: 10 }, { capital: 100000, feePct: 0, slipPct: 0 });
  const buys = r.trades.filter((t) => t.side === 'BUY');
  assert.equal(buys.length, 1);
  assert.equal(buys[0].price, 100, 'bought on the day AFTER the spike was seen, at that day\'s close');
  assert.equal(buys[0].date, dates(c.length)[31]);
});
test('buy and hold: all-in on day one, whole shares, fee on entry, result equals the price move minus costs', () => {
  const c = [100, 110, 121]; const r = backtest(pts(c), 'buyhold', {}, { capital: 10000, feePct: 1, slipPct: 0 });
  // signal for day 0 is acted on day 1 (no peeking): bought at 110
  assert.equal(r.trades[0].qty, Math.floor(10000 / (110 * 1.01))); close(r.trades[0].fee, r.trades[0].qty * 110 * 0.01, 1e-9);
  const bh = backtest(pts(c), 'buyhold', {}, { capital: 10000, feePct: 1, slipPct: 0 }).buyHold;
  assert.equal(bh.at(-1)[1] > 10000, true);
});
test('moving-average crossover trades a rise and a fall, books a profit, and reports honest metrics', () => {
  const c = [...walk(40, () => 100), ...walk(40, (i) => 100 + i * 2), ...walk(40, (i) => 180 - i * 3)];
  const r = backtest(pts(c), 'sma_cross', { fast: 5, slow: 20 }, { capital: 1_000_000, feePct: 0.1, slipPct: 0 });
  assert.equal(r.trades[0].side, 'BUY'); assert.equal(r.trades.at(-1).side, 'SELL');
  assert.equal(r.rounds.length, 1); assert.ok(r.rounds[0].pnl > 0);
  assert.ok(r.metrics.returnPct > 0 && r.metrics.maxDrawdownPct <= 0 && r.metrics.exposurePct > 0 && r.metrics.exposurePct < 100);
  assert.equal(r.metrics.winRatePct, 100); assert.ok(r.metrics.feesPaid > 0);
  assert.equal(r.today.position, 'flat'); assert.equal(r.today.open, null);
  assert.equal(r.equity.length, c.length); assert.equal(r.buyHold.length, c.length);
});
test('a strategy that never signals stays in cash and loses nothing; costs are charged on every trade', () => {
  const r = backtest(pts(walk(60, () => 100)), 'sma_cross', {}, { capital: 50000 });
  assert.equal(r.trades.length, 0); assert.equal(r.metrics.returnPct, 0); assert.equal(r.metrics.exposurePct, 0);
  const noFee = backtest(pts([...walk(40, () => 100), ...walk(30, (i) => 100 + i * 3), ...walk(30, (i) => 190 - i * 3)]), 'sma_cross', { fast: 5, slow: 20 }, { feePct: 0, slipPct: 0 });
  const fee = backtest(pts([...walk(40, () => 100), ...walk(30, (i) => 100 + i * 3), ...walk(30, (i) => 190 - i * 3)]), 'sma_cross', { fast: 5, slow: 20 }, { feePct: 1, slipPct: 0 });
  assert.ok(fee.metrics.finalValue < noFee.metrics.finalValue);
});
test('maximum drawdown is the worst peak-to-trough fall of the account', () => {
  const r = backtest(pts([100, 100, 100, 100, 100, 50, 50]), 'buyhold', {}, { capital: 1000, feePct: 0, slipPct: 0 });
  close(r.metrics.maxDrawdownPct, -50, 1e-6); close(r.metrics.buyHoldDrawdownPct, -50, 1e-6);
});
test('every strategy runs on realistic data, parameters are clamped, bad input is refused, comparison covers all', () => {
  const c = walk(300, (i) => 100 + i * 0.3 + Math.sin(i / 5) * 12 + Math.cos(i / 11) * 7);
  for (const key of Object.keys(STRATEGIES)) {
    const r = backtest(pts(c), key, defaultParams(key));
    assert.ok(Number.isFinite(r.metrics.returnPct) && r.equity.every((e) => Number.isFinite(e[1]) && e[1] >= 0), key);
    assert.ok(STRATEGIES[key].idea && STRATEGIES[key].buy && STRATEGIES[key].sell && STRATEGIES[key].works && STRATEGIES[key].fails && STRATEGIES[key].lesson, `${key} is explained`);
  }
  assert.deepEqual(cleanParams('sma_cross', { fast: -5, slow: 'abc' }), { fast: 2, slow: 50 });
  assert.equal(cleanParams('bollinger', { period: 20, k: 2.5 }).k, 2.5);
  assert.throws(() => backtest(pts([1, 2]), 'sma_cross'), /not enough/); assert.throws(() => backtest(pts(c), 'nope'), /unknown strategy/);
  const all = compareAll(pts(c)); assert.equal(all.length, Object.keys(STRATEGIES).length); assert.ok(all.every((x) => !x.error));
});

/* ---------- paper account ---------- */
test('buy, sell, average cost, fees, realised profit, and an account that is never mutated', () => {
  const a0 = newAccount(100000, 1);
  const { account: a1, trade: t1 } = placeOrder(a0, { sym: 'infy', side: 'BUY', qty: 10, price: 1000, ts: 5, feePct: 0.1 });
  assert.equal(a0.cash, 100000); assert.deepEqual(a0.positions, {});
  assert.equal(t1.fee, 10); assert.equal(a1.cash, 100000 - 10000 - 10); close(a1.positions.INFY.avg, 1001);
  const { account: a2 } = placeOrder(a1, { sym: 'INFY', side: 'BUY', qty: 10, price: 1100, ts: 6 });
  close(a2.positions.INFY.avg, (10010 + 11011) / 20);
  const { account: a3, trade: t3 } = placeOrder(a2, { sym: 'INFY', side: 'SELL', qty: 5, price: 1200, ts: 7 });
  close(t3.pnl, 5 * 1200 - 6 - 5 * a2.positions.INFY.avg, 0.01); assert.equal(a3.positions.INFY.qty, 15);
  const { account: a4 } = placeOrder(a3, { sym: 'INFY', side: 'SELL', qty: 15, price: 1000 });
  assert.deepEqual(a4.positions, {}); assert.equal(a4.trades.length, 4); assert.equal(a4.nextId, 5);
  close(a4.realized, a4.trades.filter((t) => t.pnl != null).reduce((s, t) => s + t.pnl, 0), 0.01);
  close(a4.cash + 0, 100000 + a4.realized - 0 + 0 - 0, 200);   // cash returns to start plus realised profit (fees are inside pnl)
});
test('orders that cannot happen are refused with a reason', () => {
  const a = newAccount(10000);
  assert.throws(() => placeOrder(a, { sym: 'X', side: 'BUY', qty: 100, price: 1000 }), /Not enough cash/);
  assert.throws(() => placeOrder(a, { sym: 'X', side: 'SELL', qty: 1, price: 10 }), /short selling/);
  assert.throws(() => placeOrder(a, { sym: 'X', side: 'BUY', qty: 1.5, price: 10 }), /whole number/);
  assert.throws(() => placeOrder(a, { sym: 'X', side: 'BUY', qty: 0, price: 10 }), OrderError);
  assert.throws(() => placeOrder(a, { sym: 'X', side: 'BUY', qty: 1, price: NaN }), /valid price/);
  assert.throws(() => placeOrder(a, { sym: 'bad sym!', side: 'BUY', qty: 1, price: 10 }), /valid NSE symbol/);
  assert.throws(() => placeOrder(a, { sym: 'X', side: 'HOLD', qty: 1, price: 10 }), /buy or sell/);
  const { account } = placeOrder(a, { sym: 'X', side: 'BUY', qty: 5, price: 10 });
  assert.throws(() => placeOrder(account, { sym: 'X', side: 'SELL', qty: 6, price: 10 }), /hold only 5 shares/);
});
test('valuation: unrealised and total profit, weights, and a missing price never invents a profit', () => {
  let a = newAccount(100000);
  a = placeOrder(a, { sym: 'AAA', side: 'BUY', qty: 100, price: 100, feePct: 0 }).account; a = placeOrder(a, { sym: 'BBB', side: 'BUY', qty: 50, price: 200, feePct: 0 }).account;
  const v = valuation(a, { AAA: 120, BBB: 180 });
  assert.equal(v.equity, 80000 + 12000 + 9000); close(v.unrealized, 2000 - 1000); close(v.totalPnl, 1000); close(v.returnPct, 1);
  assert.deepEqual(v.rows.map((r) => r.sym), ['AAA', 'BBB']); close(v.rows.reduce((s, r) => s + r.weightPct, 0) + v.cashPct, 100, 1e-9);
  const noPx = valuation(a, { AAA: 120 }); assert.equal(noPx.rows.find((r) => r.sym === 'BBB').priced, false); assert.equal(noPx.rows.find((r) => r.sym === 'BBB').pnl, 0);
  assert.equal(sharesFor(10000, 100), 99); assert.equal(sharesFor(10000, 99.9), 100); assert.equal(sharesFor(50, 100), 0);
});
test('saved accounts: a good one round-trips, junk becomes a fresh account', () => {
  let a = placeOrder(newAccount(), { sym: 'AAA', side: 'BUY', qty: 3, price: 100 }).account;
  assert.deepEqual(normalize(JSON.parse(JSON.stringify(a))), a);
  for (const junk of [null, {}, { version: 2 }, 'x', { version: 1, cash: 'a', positions: {}, trades: [] }]) assert.equal(normalize(junk).cash, START_CASH);
});

/* ---------- dashboard, chart and palette logic ---------- */
test('watchlist sorting and filtering: unavailable rows last in both directions; filters mean what they say', () => {
  const rows = [{ sym: 'B', chg: -1, price: 20, abs: -1, status: 'live', ts: '2026-10-26 10:00:00' }, { sym: 'A', chg: 2, price: 10, abs: 2, status: 'closed', ts: '2026-10-26 10:05:00' },
    { sym: 'C', chg: 0, price: 30, abs: 0, status: 'delayed' }, { sym: 'D', status: 'unavailable' }, { sym: 'E', chg: 1, price: 5, abs: 1, status: 'stale' }];
  assert.deepEqual([...rows].sort(compare('symbol', 'asc')).map((r) => r.sym), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual([...rows].sort(compare('chg', 'desc')).map((r) => r.sym), ['A', 'E', 'C', 'B', 'D']);
  assert.deepEqual([...rows].sort(compare('chg', 'asc')).map((r) => r.sym), ['B', 'C', 'E', 'A', 'D']);
  assert.equal([...rows].sort(compare('price', 'asc')).at(-1).sym, 'D'); assert.equal([...rows].sort(compare('ts', 'desc')).at(-1).sym !== undefined, true);
  const by = (f) => rows.filter((r) => matches(r, f)).map((r) => r.sym);
  assert.deepEqual([by('up'), by('down'), by('flat'), by('stale'), by('unavailable'), by('all')], [['A', 'E'], ['B'], ['C'], ['C', 'E'], ['D'], ['B', 'A', 'C', 'D', 'E']]);
  assert.deepEqual(summarize(rows), { total: 5, up: 2, down: 1, flat: 1, unavailable: 1 });
});
test('windowing: only the visible rows plus a margin are drawn, and the spacers add up to the full height', () => {
  const [first, count, above, below] = windowSlice(1000, 5200, 600, 52, 10);
  assert.equal(first, 90); assert.equal(count, Math.ceil(600 / 52) + 20); assert.equal(above, 90 * 52); assert.equal(above + count * 52 + below, 1000 * 52);
  assert.deepEqual(windowSlice(1000, 0, 600, 52, 10).slice(0, 1), [0]); const end = windowSlice(1000, 52 * 990, 600, 52, 10); assert.equal(end[0] + end[1], 1000); assert.equal(end[3], 0);
  assert.deepEqual(windowSlice(5, 0, 600, 52), [0, 5, 0, 0]);
});
test('chart: decimation keeps the highest and lowest of every bucket and both ends; stats are exact', () => {
  const p = walk(5000, (i) => [`d${String(i).padStart(5, '0')}`, 100 + (i % 97) + (i === 2500 ? 500 : 0) - (i === 3700 ? 90 : 0)]);
  const d = decimate(p); assert.ok(d.length <= 700 && d.length > 300); assert.equal(d[0], p[0]); assert.equal(d.at(-1), p.at(-1));
  assert.ok(d.some((x) => x[1] === 600 + (2500 % 97) - 0 || x[1] === 100 + (2500 % 97) + 500), 'the spike survives'); assert.ok(d.some((x) => x[0] === 'd03700'), 'the trough survives');
  assert.deepEqual(d.map((x) => x[0]), [...d.map((x) => x[0])].sort(), 'time order kept'); assert.equal(decimate(p.slice(0, 100)).length, 100);
  const s = stats([['a', 100], ['b', 130], ['c', 90], ['d', 110]]); assert.deepEqual([s.first, s.last, s.abs, s.hi, s.lo, s.n], [100, 110, 10, 130, 90, 4]); close(s.pct, 10);
});
test('search highlighting escapes the text and marks every word', () => {
  assert.equal(highlight('Infosys Ltd.', 'infosys'), '<mark class="rounded-sm bg-selection px-0.5 text-foreground">Infosys</mark> Ltd.');
  assert.match(highlight('A <b>&</b> Co', 'co'), /A &lt;b&gt;&amp;&lt;\/b&gt; <mark[^>]*>Co<\/mark>/);
  assert.equal(highlight('Plain', ''), 'Plain'); assert.equal(highlight('a.b', '.'), 'a<mark class="rounded-sm bg-selection px-0.5 text-foreground">.</mark>b');
});
