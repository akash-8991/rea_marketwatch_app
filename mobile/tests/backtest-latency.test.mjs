// The ten-year backtest gate and the latency budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, gateDecision, selectStrategy, summary, GATE_DEFAULT } from '../../src/marketlens/static/js/backtest-gate.js';
import * as C from '../../src/marketlens/static/js/desk-core.js';
import { Latency } from '../../src/marketlens/static/js/latency.js';

let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
/** n trading days of synthetic OHLCV with a given daily drift and noise. */
function series(n, drift, noise = 0.012, start = '2016-01-04') {
  const out = []; let p = 1000, d = Date.parse(start + 'T00:00:00Z');
  for (let i = 0; i < n; i++) { do { d += 86400000; } while ([0, 6].includes(new Date(d).getUTCDay())); const o = p; p *= 1 + drift + (rnd() - 0.5) * 2 * noise + Math.sin(i / 40) * 0.004; out.push([new Date(d).toISOString().slice(0, 10), +p.toFixed(2), 100000 + Math.floor(rnd() * 90000), +o.toFixed(2), +(Math.max(o, p) * 1.005).toFixed(2), +(Math.min(o, p) * 0.995).toFixed(2)]); }
  return out;
}

test('a strategy report covers the whole history, an unseen last stretch, four periods and the costs, and states the years actually used', () => {
  const pts = series(2520, 0.0006), r = evaluate(pts, 'supertrend', null, GATE_DEFAULT);
  assert.ok(r.coverage.years > 9 && r.coverage.years < 11); assert.equal(r.coverage.requestedYears, 10); assert.equal(r.folds.length, 4); assert.ok(r.outOfSample.from > r.inSample.from && r.outOfSample.to === r.coverage.to);
  assert.ok(Number.isFinite(r.full.returnPct) && Number.isFinite(r.full.maxDrawdownPct) && r.full.maxDrawdownPct <= 0 && r.full.feesPaid > 0); assert.ok(r.yearly.length >= 10); assert.ok(['long', 'flat', 'short'].includes(r.today.position));
  const g = gateDecision(r, GATE_DEFAULT); assert.deepEqual(g.checks.map((c) => c.code), ['COVERAGE', 'TRADES', 'OUT_OF_SAMPLE_RETURN', 'DRAWDOWN', 'CONSISTENCY']); assert.equal(g.checks.length, 5, 'every check is reported');
  assert.throws(() => evaluate(pts, 'nope'), /unknown strategy/);
});

test('the gate fails short histories, losing strategies and deep drawdowns, and says exactly why', () => {
  const short = evaluate(series(300, 0.001), 'sma_cross', null, GATE_DEFAULT), g1 = gateDecision(short, GATE_DEFAULT); assert.equal(g1.pass, false); assert.ok(g1.failed.includes('COVERAGE'));
  const down = evaluate(series(2520, -0.0008), 'buyhold', null, GATE_DEFAULT), g2 = gateDecision(down, GATE_DEFAULT); assert.equal(g2.pass, false); assert.ok(g2.failed.includes('OUT_OF_SAMPLE_RETURN') && g2.failed.includes('DRAWDOWN') && g2.failed.includes('TRADES'));
  const up = evaluate(series(2520, 0.0009), 'price_sma', null, GATE_DEFAULT), loose = gateDecision(up, { ...GATE_DEFAULT, minTrades: 1, maxDrawdownPct: 95, minOosReturnPct: -100, minPositiveFolds: 0 }); assert.equal(loose.pass, true, JSON.stringify(loose.checks.filter((c) => !c.ok)));
  const strict = gateDecision(up, { ...GATE_DEFAULT, minYearsCovered: 11 }); assert.deepEqual(strict.failed, ['COVERAGE']); assert.match(strict.checks[0].detail, /years of history \(of 10 asked for; at least 11 needed\)/);
});

test('selection ranks passing strategies first by unseen-period return per unit of drawdown, tunes nothing, and skips what cannot run', () => {
  const pts = series(2520, 0.0007), s = selectStrategy(pts, GATE_DEFAULT); assert.ok(s.ranked.length >= 10 && s.tried === GATE_DEFAULT.candidates.length); assert.ok(s.best);
  const firstFail = s.ranked.findIndex((r) => !r.gate.pass); if (firstFail >= 0) assert.ok(s.ranked.slice(firstFail).every((r) => !r.gate.pass), 'passing strategies come first');
  const pass = s.ranked.filter((r) => r.gate.pass); for (let i = 1; i < pass.length; i++) assert.ok(pass[i - 1].score >= pass[i].score);
  assert.deepEqual(s.best.params, evaluate(pts, s.best.key, null, GATE_DEFAULT).params, 'default parameters only'); assert.equal(selectStrategy(pts, GATE_DEFAULT, ['not_a_strategy']).best, null);
});

test('the summary that travels with an intent is compact and carries verdict, signal, coverage, costs and a validity window', () => {
  const pts = series(2520, 0.0007), r = evaluate(pts, 'ema_cross', null, GATE_DEFAULT); r.gate = gateDecision(r, GATE_DEFAULT); const m = summary(r, GATE_DEFAULT, 1000);
  assert.equal(m.strategy, 'ema_cross'); assert.equal(m.validUntil, 1000 + 24 * 3600e3); assert.equal(m.folds.length, 4); assert.deepEqual(m.costs, { feePct: 0.1, slipPct: 0.05 }); assert.ok(JSON.stringify(m).length < 2500, 'no equity curves'); assert.equal(m.signal, r.today.position);
});

const fused = { direction: 'BUY', score: 0.6, confidence: 0.7, components: {}, reason_codes: [], version: 'fusion-1', weights_used: {} };
const NOW = Date.parse('2026-11-09T10:30:00+05:30');
const val = (o = {}) => ({ strategy: 'supertrend', name: 'Supertrend', pass: true, failed: [], signal: 'long', validUntil: NOW + 3600e3, ...o });
const rctx = (limits = {}) => ({ account: { equity: 1e6, cash: 1e6 }, positions: [], quote: { price: 1200, ageSeconds: 2, valueCr: 500 }, openOrders: 0, recentIntents: [], recentOrderTimes: [], limits, kill: {}, now: NOW });
test('the risk engine refuses any trade without a passing, fresh backtest whose strategy agrees with the trade', () => {
  const mk = (validation) => C.buildIntent({ fused, sym: 'RELIANCE', price: 1200, atr: 20, equity: 1e6, now: NOW, sector: 'Energy', validation });
  const ok = mk(val()); assert.equal(ok.strategy_id, 'supertrend', 'the trade belongs to the strategy that was backtested'); assert.equal(C.riskEvaluate(ok, rctx()).decision, 'APPROVE');
  assert.ok(C.riskEvaluate(mk(null), rctx()).reason_codes.includes('BACKTEST_PRESENT')); assert.ok(C.riskEvaluate(mk(val({ pass: false, failed: ['DRAWDOWN'] })), rctx()).reason_codes.includes('BACKTEST_GATE'));
  assert.ok(C.riskEvaluate(mk(val({ validUntil: NOW - 1 })), rctx()).reason_codes.includes('BACKTEST_FRESH')); assert.ok(C.riskEvaluate(mk(val({ signal: 'flat' })), rctx()).reason_codes.includes('STRATEGY_SIGNAL'));
  const sell = { ...mk(val({ signal: 'long' })), side: 'SELL' }; assert.ok(C.riskEvaluate(sell, rctx({ allowShort: true })).reason_codes.includes('STRATEGY_SIGNAL'), 'a long strategy does not support a sell');
  assert.equal(C.riskEvaluate(mk(null), rctx({ requireBacktest: false })).decision, 'APPROVE', 'only when the gate is switched off by the user');
  assert.equal(C.DEFAULT_LIMITS.requireBacktest, true, 'required by default');
});

test('latency monitor: percentiles, budgets and the over count are right', () => {
  let t = 0; const L = new Latency(() => t); for (let i = 1; i <= 100; i++) L.record('s', i / 100, 1); const s = L.stats('s');
  assert.equal(s.n, 100); assert.ok(Math.abs(s.p50 - 0.51) < 0.02); assert.ok(s.p99 <= 1 && s.within === true); assert.equal(s.over, 0); L.record('s', 2.5, 1); assert.equal(L.stats('s').over, 1); assert.equal(L.stats('s').max, 2.5);
  const x = L.time('sync', () => { t += 0.25; return 42; }, 1); assert.equal(x, 42); assert.equal(L.stats('sync').p50, 0.25); L.record('net', 300, null); assert.equal(L.stats('net').within, null, 'network stages have no budget'); assert.equal(L.stats('missing'), null);
});

test('the in-process decision path (fuse, intent, 24 risk checks, execute) runs well inside 1 ms', async () => {
  const props = ['news', 'technical', 'fundamental', 'derivatives', 'regime'].map((a) => ({ schema_version: '1.0', proposal_id: a, agent_type: a, instrument_id: 'NSE:X', direction: 'BUY', score: 0.6, confidence: 0.8, horizon_seconds: 900, valid_until: NOW + 6e5, evidence: [{ kind: 'x', id: '1', weight: 1 }], reason_codes: [], model_version: 'x' }));
  const broker = { name: 'shadow', async place(p) { return { status: 'FILLED', broker_order_id: 'S', price: 100, filled: p.quantity }; } }, L = new Latency();
  for (let i = 0; i < 1500; i++) { const t0 = L.clock(), f = C.fuse(props, C.FUSION_DEFAULT, NOW), it = C.buildIntent({ fused: f, sym: 'X', price: 1200, atr: 20, equity: 1e6, now: NOW + i * 1000 }), d = C.riskEvaluate(it, { ...rctx({ requireBacktest: false }), now: NOW }); await C.execute({ ...it, client_order_id: `ML${i}` }, d, { broker, orders: [], now: () => NOW }); L.record('all', L.clock() - t0, 1); }
  const s = L.stats('all'); assert.ok(s.p50 < 0.5, `median ${s.p50} ms`); assert.ok(s.p95 < 1, `p95 ${s.p95} ms`);
});
