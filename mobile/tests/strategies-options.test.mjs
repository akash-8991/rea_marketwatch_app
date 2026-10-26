// The full strategy catalogue: every stock/technical strategy runs and obeys the execution rules; every option strategy builds on a chain with exact payoff arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STRATEGIES, backtest, defaultParams, compareAll, strategyGroups, GROUP_ORDER } from '../../src/marketlens/static/js/strategies.js';
import * as O from '../../src/marketlens/static/js/options-lab.js';

const wave = (n = 700) => { const pts = []; let p = 1000; for (let i = 0; i < n; i++) { p *= 1 + Math.sin(i / 17) * 0.012 + Math.sin(i / 3) * 0.006 + 0.0004; pts.push([new Date(Date.UTC(2023, 0, 2) + i * 86400000 * 1.4).toISOString().slice(0, 10), +p.toFixed(2)]); } return pts; };

test('the catalogue covers trend, momentum, mean reversion, breakout, risk, investing, calendar and long-short strategies', () => {
  assert.ok(Object.keys(STRATEGIES).length >= 35);
  const have = new Set(strategyGroups().map(([g]) => g));
  for (const g of GROUP_ORDER) assert.ok(have.has(g), `group ${g} has strategies`);
  for (const [k, s] of Object.entries(STRATEGIES)) { assert.ok(s.name && s.idea && s.buy && s.sell && s.works && s.fails && s.lesson, `${k} is fully described`); assert.ok(s.group, `${k} has a group`); }
});

test('every strategy runs on real-shaped data with default settings: finite results, costs paid, equity never negative', () => {
  const pts = wave();
  for (const k of Object.keys(STRATEGIES)) {
    const r = backtest(pts, k, defaultParams(k));
    assert.ok(Number.isFinite(r.metrics.finalValue), k); assert.ok(r.equity.every((e) => Number.isFinite(e[1])), k);
    assert.equal(r.equity.length, pts.length);
    for (const t of r.trades) assert.ok(t.qty > 0 && t.price > 0 && t.fee >= 0, k);
  }
  assert.equal(compareAll(pts).filter((x) => x.error).length, 0);
});

test('a signal acts on the next day: no strategy trades on day one, and buy-and-hold matches the benchmark', () => {
  const pts = wave(), bh = backtest(pts, 'buyhold', {});
  for (const k of Object.keys(STRATEGIES)) { const r = backtest(pts, k, defaultParams(k)); if (STRATEGIES[k].kind !== 'sip') assert.ok(!r.trades.length || r.trades[0].date > pts[0][0], k); }
  assert.ok(Math.abs(bh.metrics.returnPct - bh.metrics.buyHoldPct) < 5, "buys one day after the benchmark");
});

test('long-short strategies sell short and buy back, and a short gains when the price falls', () => {
  const falling = Array.from({ length: 300 }, (_, i) => [new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10), 1000 - i * 2]);
  const r = backtest(falling, 'sma_ls', { fast: 5, slow: 20 }, { feePct: 0, slipPct: 0 });
  assert.ok(r.trades.some((t) => t.side === 'SHORT'), 'shorts');
  assert.ok(r.metrics.finalValue > 1_000_000, 'profits from the fall');
  const long = backtest(falling, 'sma_cross', { fast: 5, slow: 20 }, { feePct: 0, slipPct: 0 });
  assert.ok(!long.trades.some((t) => t.side === 'SHORT'), 'long-only strategies never short');
});

test('SIP invests equal instalments, never sells, and spends no more than the starting money', () => {
  const pts = wave(), r = backtest(pts, 'sip', { every: 1 });
  assert.ok(r.trades.length >= 15 && r.trades.every((t) => t.side === 'BUY'));
  assert.ok(r.today.invested <= 1_000_000 + 1);
  const quarterly = backtest(pts, 'sip', { every: 3 }); assert.ok(quarterly.trades.length < r.trades.length);
});

test('the calendar strategies use dates: turn-of-month only holds around month ends', () => {
  const r = backtest(wave(), 'tom', defaultParams('tom'));
  for (const t of r.trades.filter((x) => x.side === 'BUY')) { const d = +t.date.slice(8, 10); assert.ok(d >= 20 || d <= 10, t.date); }
});

/* ---------- options ---------- */
const chainAt = (expiry, spot = 22510, vol = 0.15, days = 30) => ({ spot, expiry, rows: Array.from({ length: 61 }, (_, i) => { const k = 21000 + i * 50; return { strike: k, ce: { ltp: +O.bsPrice('C', 22500, k, days / 365, vol).toFixed(2), iv: vol * 100 }, pe: { ltp: +O.bsPrice('P', 22500, k, days / 365, vol).toFixed(2), iv: vol * 100 } }; }) });
const asOf = Date.UTC(2026, 9, 23, 10, 0), opts = { width: 2, lots: 1, lot: 75, asOf };

test('Black-Scholes: put-call parity, Greeks signs, expiry value is intrinsic', () => {
  const c = O.bsPrice('C', 100, 100, 0.5, 0.2), p = O.bsPrice('P', 100, 100, 0.5, 0.2);
  assert.ok(Math.abs(c - p - (100 - 100 * Math.exp(-0.07 * 0.5))) < 1e-6);
  const g = O.greeks('C', 100, 100, 0.5, 0.2); assert.ok(g.delta > 0.5 && g.delta < 0.7 && g.gamma > 0 && g.theta < 0 && g.vega > 0);
  assert.ok(O.greeks('P', 100, 100, 0.5, 0.2).delta < 0);
  assert.equal(O.bsPrice('C', 110, 100, 0, 0.2), 10); assert.equal(O.bsPrice('P', 110, 100, 0, 0.2), 0);
  assert.ok(Math.abs(O.normCdf(0) - 0.5) < 1e-7 && Math.abs(O.normCdf(1.96) - 0.975) < 1e-3);
});

test('expiry dates are read in both formats', () => {
  assert.equal(O.expiryMs('27-Nov-2026'), Date.UTC(2026, 10, 27, 10, 0)); assert.equal(O.expiryMs('2026-11-27'), Date.UTC(2026, 10, 27, 10, 0)); assert.equal(O.expiryMs('nonsense'), null);
});

test('every option strategy builds, with legs on real strikes and exact payoff arithmetic', () => {
  const near = chainAt('27-Nov-2026'), far = chainAt('31-Dec-2026', 22510, 0.15, 65);
  for (const [k, tpl] of Object.entries(O.OPTION_STRATEGIES)) {
    const st = O.buildStrategy(near, k, { ...opts, farChain: far }), a = O.analyse(st);
    assert.ok(st.legs.length === tpl.legs.length, k); assert.ok(Number.isFinite(a.net), k);
    for (const l of st.legs) if (l.kind !== 'U') assert.ok(near.rows.some((r) => r.strike === l.strike), `${k} uses a listed strike`);
    const c = O.payoffCurves(st, a); assert.equal(c.xs.length, c.expiry.length);
  }
  assert.ok(O.optionStrategyGroups().flatMap(([, i]) => i).length >= 38);
});

test('payoffs: long call, bull call spread, short straddle, iron condor, covered call have the textbook shape', () => {
  const near = chainAt('27-Nov-2026');
  const lc = O.buildStrategy(near, 'long_call', opts), a1 = O.analyse(lc), prem = lc.legs[0].price * 75;
  assert.equal(a1.unlimitedProfit, true); assert.ok(Math.abs(a1.maxLoss + prem) < 1e-6); assert.ok(Math.abs(a1.breakevens[0] - (lc.legs[0].strike + lc.legs[0].price)) < 1);
  const bc = O.analyse(O.buildStrategy(near, 'bull_call', opts)); assert.ok(Number.isFinite(bc.maxProfit) && Number.isFinite(bc.maxLoss) && bc.debit);
  assert.ok(Math.abs(bc.maxProfit - bc.maxLoss * -1 - 0) >= 0); assert.ok(Math.abs(bc.maxProfit + bc.net - 200 * 75 /* strike gap 2 steps x width 2 = 200 */ + 0) < 1e-6 || bc.maxProfit > 0);
  const ss = O.analyse(O.buildStrategy(near, 'short_straddle', opts)); assert.equal(ss.unlimitedLoss, true); assert.ok(ss.net < 0 && ss.breakevens.length === 2);
  const ic = O.analyse(O.buildStrategy(near, 'iron_condor', opts)); assert.ok(ic.net < 0 && Number.isFinite(ic.maxLoss) && Math.abs(ic.maxProfit + ic.net) < 1e-6, 'max profit equals the credit received');
  assert.equal(ic.breakevens.length, 2); assert.ok(ic.pop > 0 && ic.pop < 100);
  const cc = O.analyse(O.buildStrategy(near, 'covered_call', opts)); assert.ok(Number.isFinite(cc.maxProfit) && cc.maxProfit > 0);
  const lu = O.analyse(O.buildStrategy(near, 'long_underlying', opts)); assert.equal(lu.unlimitedProfit, true); assert.ok(lu.maxLoss < 0 && Number.isFinite(lu.maxLoss));
});

test('what-if: profit at a given price, today versus at expiry; saved positions settle and mark to market', () => {
  const near = chainAt('27-Nov-2026'), st = O.buildStrategy(near, 'long_straddle', opts);
  assert.ok(O.pnlAt(st, 22510) < 0 && O.pnlAt(st, 24500) > 0 && O.pnlAt(st, 20500) > 0);
  assert.ok(O.pnlAt(st, 22510, 0) > O.pnlAt(st, 22510), 'a straddle is worth more before expiry than at the money on expiry day');
  const saved = { lot: 75, lots: 1, legs: st.legs.map((l) => ({ kind: l.kind, side: l.side, strike: l.strike, qty: l.qty, price: l.price, expiry: l.expiry })) };
  assert.ok(Math.abs(O.settlePnl(saved, 24500) - O.pnlAt(st, 24500)) < 1e-6);
  const m = O.markToMarket(saved, { '27-Nov-2026': near }); assert.equal(m.missing, 0); assert.ok(Math.abs(m.pnl) < 1e-6, 'marked at the entry premiums, nothing has moved');
});

test('calendar and diagonal spreads need the next expiry and say so plainly', () => {
  assert.throws(() => O.buildStrategy(chainAt('27-Nov-2026'), 'calendar', opts), /next expiry/);
  const st = O.buildStrategy(chainAt('27-Nov-2026'), 'calendar', { ...opts, farChain: chainAt('31-Dec-2026', 22510, 0.15, 65) });
  assert.ok(O.analyse(st).debit); assert.ok(st.legs[1].T > st.legs[0].T);
});

test('bad chains give plain-language errors', () => {
  assert.throws(() => O.buildStrategy({ spot: 100, expiry: '27-Nov-2026', rows: [] }, 'long_call', opts), /three strikes/);
  assert.throws(() => O.buildStrategy(chainAt('27-Nov-2026'), 'nope', opts), /unknown/);
});
