// The trading desk: agents, fusion, intents, the risk engine, the order state machine, reconciliation, the audit chain; plus the fundamental screens and the OHLC strategies.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../src/marketlens/static/js/desk-core.js';
import * as F from '../../src/marketlens/static/js/fund-screens.js';
import * as T from '../../src/marketlens/static/js/ta.js';
import { STRATEGIES, backtest, defaultParams, strategyGroups } from '../../src/marketlens/static/js/strategies.js';

const MON_10_30 = Date.parse('2026-11-09T10:30:00+05:30'), SAT = Date.parse('2026-11-07T11:00:00+05:30');
const prop = (agent, score, conf = 0.8, extra = {}) => ({ schema_version: '1.0', proposal_id: `${agent}:X`, agent_type: agent, instrument_id: 'NSE:RELIANCE', direction: score > 0.2 ? 'BUY' : score < -0.2 ? 'SELL' : 'HOLD', score, confidence: conf, horizon_seconds: 900, valid_until: MON_10_30 + 600000, evidence: [{ kind: 'x', id: '1', weight: 1 }], reason_codes: [], model_version: `${agent}-1`, ...extra });

test('agents emit schema-valid proposals and return null when their data is missing', () => {
  const an = { ok: true, score: 0.6, candles: 200, signals: [{ name: 'RSI 61', bias: 1, weight: 1.5 }, { name: 'MACD', bias: 1, weight: 1.5 }] };
  const t = C.technicalAgent('RELIANCE', an, { now: MON_10_30 }); assert.deepEqual(C.validateProposal(t), []); assert.equal(t.direction, 'BUY'); assert.ok(t.confidence > 0.6 && t.reason_codes.length === 2);
  assert.equal(C.technicalAgent('X', { ok: false }), null); assert.equal(C.newsAgent('X', { score: null, n: 0 }), null);
  const n = C.newsAgent('X', { score: -0.3, n: 6, pos: 1, neg: 4 }, { now: MON_10_30 }); assert.equal(n.direction, 'SELL'); assert.deepEqual(C.validateProposal(n), []);
  assert.equal(C.fundamentalAgent('X', { price: 100, hi52: 200, lo52: 90, fund: { score: 0.5 } }).direction, 'BUY'); assert.equal(C.fundamentalAgent('X', null), null);
  assert.equal(C.derivativesAgent('X', { pcr: 1.5, maxPain: 110, spot: 100 }).direction, 'BUY'); assert.equal(C.derivativesAgent('X', {}), null);
  assert.equal(C.regimeAgent('X', { breadth: { advances: 300, declines: 1500 }, mood: { vix: 25 } }).direction, 'SELL'); assert.equal(C.regimeAgent('X', {}), null);
  assert.ok(C.validateProposal({ agent_type: 'rogue', score: 5 }).length >= 4, 'malformed output is detected');
});

test('fusion: weights renormalise over present agents, a missing required agent rejects, conflicts are penalised, expired or invalid proposals count as missing', () => {
  const all = ['news', 'technical', 'fundamental', 'derivatives', 'regime'].map((a) => prop(a, 0.6));
  let f = C.fuse(all, C.FUSION_DEFAULT, MON_10_30); assert.equal(f.status, 'candidate'); assert.equal(f.direction, 'BUY'); assert.equal(f.score, 0.6); assert.deepEqual(f.missing, []);
  f = C.fuse([prop('technical', 0.6), prop('regime', 0.2)], C.FUSION_DEFAULT, MON_10_30); assert.deepEqual(f.missing.sort(), ['derivatives', 'fundamental', 'news']); assert.ok(Math.abs(f.weights_used.technical + f.weights_used.regime - 1) < 0.02);
  f = C.fuse([prop('news', 0.8)], C.FUSION_DEFAULT, MON_10_30); assert.equal(f.status, 'rejected'); assert.deepEqual(f.reason_codes, ['required_agent_technical_missing']);
  f = C.fuse([prop('technical', 0.8), prop('news', -0.8)], C.FUSION_DEFAULT, MON_10_30); assert.equal(f.conflict, true); assert.ok(f.reason_codes.includes('conflicting_agents'));
  f = C.fuse([prop('technical', 0.8, 0.8, { valid_until: MON_10_30 - 1 })], C.FUSION_DEFAULT, MON_10_30); assert.equal(f.status, 'rejected'); assert.equal(f.invalid[0].problems[0], 'expired');
  f = C.fuse([prop('technical', 0.8, 0.8, { score: 7 })], C.FUSION_DEFAULT, MON_10_30); assert.equal(f.status, 'rejected', 'invalid output fails closed');
  f = C.fuse([prop('technical', 0.1)], C.FUSION_DEFAULT, MON_10_30); assert.equal(f.status, 'no_trade'); f = C.fuse([prop('technical', 0.5, 0.2)], C.FUSION_DEFAULT, MON_10_30); assert.equal(f.status, 'rejected');
  assert.equal(C.FUSION_DEFAULT.weights.news, 0.35); assert.equal(Object.values(C.FUSION_DEFAULT.weights).reduce((a, b) => a + b, 0).toFixed(2), '1.00');
});

const fused = { direction: 'BUY', score: 0.6, confidence: 0.7, components: {}, reason_codes: [], version: 'fusion-1', weights_used: {} };
const intentOf = (o = {}) => C.buildIntent({ fused, sym: 'RELIANCE', price: 1200, atr: 20, equity: 1000000, now: MON_10_30, sector: 'Energy', ...o });
const quote = (o = {}) => ({ price: 1200, ageSeconds: 3, valueCr: 500, ...o });
const ctxOf = (o = {}) => ({ account: { equity: 1000000, cash: 1000000 }, positions: [], quote: quote(), openOrders: 0, recentIntents: [], recentOrderTimes: [], limits: { requireBacktest: false }, kill: {}, now: MON_10_30, ...o });
const codes = (d) => d.reason_codes;

test('intents are sized from the risk budget, tick-aligned, tagged and idempotent', () => {
  const i = intentOf(); assert.equal(i.side, 'BUY'); assert.equal(i.order_type, 'LIMIT'); assert.equal(i.quantity, Math.floor(100000 / 1200), 'capped by the order-value limit (the risk budget alone would allow 250)'); assert.ok(i.limit_price > 1200 && i.limit_price <= 1200 * 1.0015 + 0.05); assert.ok(i.stop_loss < 1200 && i.target > 1200);
  assert.match(i.client_order_id, /^[A-Za-z0-9]{1,20}$/); assert.equal(intentOf().idempotency_key, i.idempotency_key, 'the same trade in the same window has the same key'); assert.notEqual(intentOf({ now: MON_10_30 + 3600e3 }).idempotency_key, i.idempotency_key);
  assert.equal(intentOf({ equity: 1000 }).quantity, 0, 'too small to trade is zero, not one'); assert.equal(intentOf({ lot: 7 }).quantity % 7, 0);
  assert.equal(C.buildIntent({ fused: { ...fused, direction: 'SELL' }, sym: 'X', price: 100, atr: 2, equity: 1e6, now: MON_10_30 }).side, 'SELL');
});

test('risk engine: a clean intent is approved with every check listed', () => {
  const d = C.riskEvaluate(intentOf(), ctxOf()); assert.equal(d.decision, 'APPROVE', JSON.stringify(d.failures)); assert.ok(d.checks.length >= 20); assert.equal(d.risk_engine_version, 'risk-1');
});

test('risk engine: every configured violation is rejected with its reason code, and several can fail at once', () => {
  const i = intentOf(), v = (ctx, intent = i) => codes(C.riskEvaluate(intent, ctxOf(ctx)));
  assert.deepEqual(v({ kill: { global: true } }), ['KILL_SWITCH']); assert.ok(v({ kill: { strategies: { fusion: true } } }).includes('KILL_SWITCH')); assert.ok(v({ kill: { instruments: { RELIANCE: true } } }).includes('KILL_SWITCH'));
  assert.ok(v({ now: SAT }).includes('SESSION')); assert.ok(v({ strategyStatus: 'paused' }).includes('STRATEGY_STATUS'));
  assert.ok(v({ quote: quote({ ageSeconds: 90 }) }).includes('STALE_DATA')); assert.ok(v({ quote: null }).includes('STALE_DATA'));
  assert.ok(v({ lot: 7 }, { ...i, quantity: 10 }).includes('LOT_SIZE')); assert.ok(v({}, { ...i, limit_price: 1200.03 }).includes('TICK_SIZE'));
  assert.ok(v({}, { ...i, order_type: 'MARKET' }).includes('ORDER_TYPE')); assert.ok(!v({ limits: { marketOrders: true } }, { ...i, order_type: 'MARKET' }).includes('ORDER_TYPE'));
  assert.ok(v({}, { ...i, side: 'SELL' }).includes('SIDE_ALLOWED')); assert.ok(!v({ positions: [{ sym: 'RELIANCE', qty: 100, last: 1200, sector: 'Energy' }] }, { ...i, side: 'SELL', quantity: 10, stop_loss: 1300 }).includes('SIDE_ALLOWED'));
  assert.ok(v({}, { ...i, limit_price: 1300 }).includes('PRICE_BAND')); assert.ok(v({ quote: quote({ valueCr: 0.1 }) }).includes('LIQUIDITY'));
  assert.ok(v({ limits: { maxOrderValue: 1000 } }).includes('ORDER_VALUE')); assert.ok(v({ limits: { maxPositionPct: 1 } }).includes('POSITION_SIZE')); assert.ok(v({ limits: { maxGrossPct: 1 } }).includes('GROSS_EXPOSURE'));
  assert.ok(v({ limits: { maxSectorPct: 1 } }).includes('SECTOR_EXPOSURE')); assert.ok(v({ account: { equity: 1000000, cash: 100 } }).includes('CASH'));
  assert.ok(v({ dayPnl: -40000, startEquity: 1000000 }).includes('DAILY_LOSS')); assert.ok(!v({ dayPnl: -1000, startEquity: 1000000 }).includes('DAILY_LOSS'));
  assert.ok(v({ openOrders: 10 }).includes('OPEN_ORDERS')); assert.ok(v({ recentIntents: [{ key: i.idempotency_key, at: MON_10_30 - 1000 }] }).includes('DUPLICATE_INTENT'));
  assert.ok(v({ recentOrderTimes: [1, 2, 3, 4, 5].map((k) => MON_10_30 - k * 10) }).includes('ORDER_RATE')); assert.ok(v({}, { ...i, expires_at: MON_10_30 - 1 }).includes('EXPIRY'));
  assert.ok(v({}, { ...i, client_order_id: 'bad tag!' }).includes('COMPLIANCE_TAG')); assert.ok(v({ live: true, brokerConnected: false }).includes('BROKER_CONNECTED')); assert.ok(!v({ live: false, brokerConnected: false }).includes('BROKER_CONNECTED'));
  const many = C.riskEvaluate(i, ctxOf({ now: SAT, quote: null, kill: { global: true } })); assert.ok(many.reason_codes.length >= 3 && many.failures.every((f) => f.detail), 'all failures are reported with a reason');
});

const brokerOf = (res) => ({ name: 'test', placed: [], async place(p) { this.placed.push(p); if (res instanceof Error) throw res; return res; }, async get() { return { status: 'FILLED', filled: 10, price: 100, broker_order_id: 'B1' }; } });
test('execution: the state machine follows the allowed path, is idempotent, rejects on a failed risk decision and never blind-retries an unknown order', async () => {
  const i = intentOf(), ok = C.riskEvaluate(i, ctxOf()), b = brokerOf({ status: 'FILLED', broker_order_id: 'B1', price: 1201, filled: i.quantity });
  const r = await C.execute(i, ok, { broker: b, orders: [], now: () => MON_10_30 }); assert.equal(r.order.status, 'FILLED'); assert.deepEqual(r.order.history.map((h) => h.state), ['CREATED', 'RISK_APPROVED', 'SUBMITTING', 'SUBMITTED', 'FILLED']); assert.equal(r.order.average_price, 1201); assert.equal(b.placed[0].tag, i.client_order_id);
  const again = await C.execute(i, ok, { broker: b, orders: [r.order], now: () => MON_10_30 }); assert.equal(again.duplicate, true); assert.equal(b.placed.length, 1, 'the same intent is never sent twice');
  const bad = C.riskEvaluate(i, ctxOf({ kill: { global: true } })), rej = await C.execute(i, bad, { broker: b, orders: [], now: () => MON_10_30 }); assert.equal(rej.order.status, 'REJECTED'); assert.equal(b.placed.length, 1, 'rejected before the broker');
  const down = brokerOf(new Error('timeout')), u = await C.execute(i, ok, { broker: down, orders: [], now: () => MON_10_30 }); assert.equal(u.order.status, 'UNKNOWN'); assert.equal(down.placed.length, 1, 'no automatic second attempt');
  const rc = await C.reconcileOrder(u.order, down); assert.equal(rc.changed, true); assert.equal(rc.order.status, 'FILLED');
  const brk = brokerOf({ status: 'REJECTED', reason: 'margin' }); assert.equal((await C.execute(i, ok, { broker: brk, orders: [], now: () => MON_10_30 })).order.status, 'REJECTED');
  const open = (await C.execute(i, ok, { broker: brokerOf({ status: 'ACKNOWLEDGED', broker_order_id: 'B2' }), orders: [], now: () => MON_10_30 })).order; assert.equal(open.status, 'ACKNOWLEDGED');
  assert.throws(() => C.advance(r.order, 'SUBMITTED'), /illegal order transition/); assert.throws(() => C.advance(open, 'CREATED'), /illegal/); assert.equal(C.advance(open, 'CANCEL_REQUESTED').status, 'CANCEL_REQUESTED');
});

test('paper broker fills a marketable limit with slippage no worse than the limit, leaves other limits open, and settles into the account', async () => {
  const settled = [], pb = C.paperBroker({ priceOf: () => 100, slippageBps: 15, place: (o) => { settled.push(o); return {}; } });
  const f = await pb.place({ tradingsymbol: 'X', transaction_type: 'BUY', quantity: 5, price: 100.5, tag: 'T1' }); assert.equal(f.status, 'FILLED'); assert.equal(f.price, 100.15); assert.equal(settled[0].qty, 5);
  assert.equal((await pb.place({ tradingsymbol: 'X', transaction_type: 'BUY', quantity: 5, price: 99, tag: 'T2' })).status, 'ACKNOWLEDGED');
  assert.equal((await C.paperBroker({ priceOf: () => 0 }).place({ tradingsymbol: 'X', transaction_type: 'BUY', quantity: 1, price: 1, tag: 'T3' })).status, 'REJECTED');
});

test('reconciliation finds differences between the order book and the account', () => {
  const orders = [{ sym: 'A', side: 'BUY', status: 'FILLED', filled_quantity: 10 }, { sym: 'A', side: 'SELL', status: 'FILLED', filled_quantity: 4 }, { sym: 'B', side: 'BUY', status: 'REJECTED', filled_quantity: 0 }];
  assert.equal(C.reconcilePositions(orders, [{ sym: 'A', qty: 6 }]).ok, true); const r = C.reconcilePositions(orders, [{ sym: 'A', qty: 5 }, { sym: 'Z', qty: 1 }]); assert.deepEqual(r.breaks.map((b) => b.sym).sort(), ['A', 'Z']);
});

test('the audit log is hash-chained: it verifies, detects any edit after a reload, exports, and keeps its anchor when old entries roll off', async () => {
  const mem = {}, kv = { get: (k, d) => (k in mem ? JSON.parse(mem[k]) : d), set: (k, v) => { mem[k] = JSON.stringify(v); } }, log = new C.AuditLog(kv, 'a', 5, 5);
  for (let n = 1; n <= 3; n++) await log.append('risk', { n }, 1000 + n);
  assert.equal((await log.verify()).ok, true); assert.equal(log.load().entries[1].prev, log.load().entries[0].hash); assert.match(log.toCsv(), /^seq,time,type,hash,data\n1,/);
  await log.flush(); const t = JSON.parse(mem.a); t.entries[1].data.n = 99; mem.a = JSON.stringify(t);
  const reloaded = new C.AuditLog(kv, 'a', 5, 5), v = await reloaded.verify(); assert.equal(v.ok, false); assert.equal(v.brokenAt, 2);
  const mem2 = {}, kv2 = { get: (k, d) => (k in mem2 ? JSON.parse(mem2[k]) : d), set: (k, v2) => { mem2[k] = JSON.stringify(v2); } }, l2 = new C.AuditLog(kv2, 'b', 3, 5); for (let n = 1; n <= 8; n++) await l2.append('x', { n }, n); assert.equal(l2.load().entries.length, 3); assert.equal((await l2.verify()).ok, true);
});

test('the audit log queues entries without making the caller wait, keeps their order, and saves them a moment later', async () => {
  const mem = {}, kv = { get: (k, d) => (k in mem ? JSON.parse(mem[k]) : d), set: (k, v) => { mem[k] = JSON.stringify(v); } }, log = new C.AuditLog(kv, 'q', 4000, 20);
  const t0 = performance.now(); for (let n = 1; n <= 200; n++) log.append('e', { n }, n); const queued = performance.now() - t0;
  assert.ok(queued < 50, `queueing 200 entries took ${queued} ms`); assert.equal('q' in mem, false, 'nothing is written synchronously');
  await log.flush(); const e = JSON.parse(mem.q).entries; assert.equal(e.length, 200); assert.deepEqual(e.map((x) => x.data.n), Array.from({ length: 200 }, (_, i) => i + 1)); assert.equal((await log.verify()).ok, true);
});

test('desk state: defaults, normalisation of junk, and no live mode by default', () => {
  const d = C.newDesk(); assert.equal(d.mode, 'research'); assert.equal(d.kill.global, false); assert.equal(C.normalizeDesk('junk').mode, 'research'); assert.equal(C.normalizeDesk({ version: 1, mode: 'paper', limits: { maxOps: 3 } }).limits.maxOrderValue, 100000);
  assert.deepEqual(C.MODES.map((m) => m[0]), ['research', 'shadow', 'paper', 'manual', 'live']); assert.equal(C.inSession(MON_10_30), true); assert.equal(C.inSession(SAT), false);
});

test('fundamental screens use only data NSE provides, say what they cannot compute, and rank with reasons', () => {
  const ctx = { benchYield: 1.4 }, st = (o) => ({ sym: 'S', price: 100, hi52: 150, lo52: 90, pct30: 2, div: 3, valueCr: 50, fund: { yield: 3, dividendYears: 3, sectorYield: 1.5 }, ...o });
  const stocks = [st({ sym: 'A' }), st({ sym: 'B', div: 0.5, fund: { yield: 0.5, dividendYears: 1, sectorYield: 1.5 } }), st({ sym: 'C', price: 95, pct30: -12, div: 2.5, fund: { yield: 2.5, dividendYears: 3, sectorYield: 1.5 } }), st({ sym: 'D', price: 148, pct30: 6 })];
  assert.deepEqual(F.runScreen('income', stocks, ctx).map((r) => r.stock.sym), ['A', 'D', 'C']); assert.deepEqual(F.runScreen('near_low', stocks, ctx).map((r) => r.stock.sym), ['C', 'A', 'B']);
  assert.deepEqual(F.runScreen('quality_momentum', stocks, ctx).map((r) => r.stock.sym), ['D']); assert.deepEqual(F.runScreen('oversold_income', stocks, ctx).map((r) => r.stock.sym), ['C']); assert.ok(F.runScreen('sector_yield', stocks, ctx).every((r) => r.stock.sym !== 'B'));
  const sc = F.runScreen('scorecard', stocks, ctx); assert.equal(sc.length, 4); assert.ok(sc[0].score >= sc[3].score && sc[0].why.includes('Value')); assert.ok(F.scorecard({ price: 10 }, {}).total === null || F.scorecard({ price: 10 }, {}).parts.length < 4);
  assert.throws(() => F.runScreen('nope', stocks), /unknown screen/); assert.ok(F.UNAVAILABLE.some(([n]) => /Piotroski/.test(n)));
  assert.equal(F.sectorValuation([{ name: 'Nifty 50', pe: 20, pb: 3, divYield: 1.3 }, { name: 'Nifty IT', pe: 25, pb: 7, divYield: 2 }, { name: 'Nifty X' }])[0].name, 'Nifty 50');
});

const ohlc = (n = 500) => { const out = []; let p = 1000; for (let i = 0; i < n; i++) { const o = p; p *= 1 + Math.sin(i / 17) * 0.012 + Math.sin(i / 3) * 0.006 + 0.0004; out.push({ t: new Date(Date.UTC(2023, 0, 2) + i * 86400000 * 1.4).toISOString().slice(0, 10), o, h: Math.max(o, p) * 1.006, l: Math.min(o, p) * 0.994, c: p, v: 100000 + ((i * 7919) % 90000) }); } return out; };
test('the extra OHLC indicators are well-formed: SAR flips with the trend, Ichimoku needs its warm-up, Aroon, MFI, CMF, Williams %R and Keltner stay in range', () => {
  const up = Array.from({ length: 80 }, (_, i) => ({ t: String(i), o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 })), dn = up.map((c, i) => ({ ...c, o: 300 - i, h: 301 - i, l: 299 - i, c: 299.5 - i }));
  assert.equal(T.psar(up).dir[79], 1); assert.ok(T.psar(up).sar[79] < up[79].c); assert.equal(T.psar(dn).dir[79], -1); assert.ok(T.psar(dn).sar[79] > dn[79].c);
  const ich = T.ichimoku(ohlc(200)); assert.equal(ich.spanA[40], null); assert.ok(ich.spanA[150] != null && ich.spanB[150] != null);
  const ar = T.aroon(up, 25); assert.equal(ar.up[79], 100); assert.ok(ar.down[79] < 20);
  const cs = ohlc(200); for (const v of T.mfi(cs).filter((x) => x != null)) assert.ok(v >= 0 && v <= 100); for (const v of T.cmf(cs).filter((x) => x != null)) assert.ok(v >= -1 && v <= 1); for (const v of T.williamsR(cs).filter((x) => x != null)) assert.ok(v >= -100 && v <= 0);
  const k = T.keltner(cs); const i = 100; assert.ok(k.upper[i] > k.mid[i] && k.mid[i] > k.lower[i]); const ha = T.heikinAshi(up); assert.ok(ha.every((c) => c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c))); assert.ok(ha[79].c > ha[79].o);
});

test('the OHLC strategies are registered with descriptions and groups, run on real-shaped data, and use opens, highs, lows and volume', () => {
  const names = ['supertrend', 'adx_dmi', 'psar', 'ichimoku', 'aroon', 'heikin', 'chandelier', 'keltner_break', 'keltner_revert', 'ttm_squeeze', 'williams_r', 'mfi', 'cmf', 'obv_trend', 'elder_ray', 'vol_breakout', 'gap_rebound', 'gap_go', 'inside_bar', 'nr7', 'pivot_break', 'range_break', 'fib_pullback', 'candle_bull', 'candle_engulf', 'candle_stars', 'hammer_star'];
  assert.ok(Object.keys(STRATEGIES).length >= 60); for (const k of names) { const s = STRATEGIES[k]; assert.ok(s && s.idea && s.buy && s.sell && s.works && s.fails && s.lesson && s.group, k); }
  const pts = ohlc(700).map((c) => [c.t, c.c, c.v, c.o, c.h, c.l]);
  for (const k of Object.keys(STRATEGIES)) { const r = backtest(pts, k, defaultParams(k)); assert.ok(Number.isFinite(r.metrics.finalValue), k); }
  const groups = strategyGroups().map(([g]) => g); for (const g of ['Volume', 'Candlestick patterns', 'Pullback']) assert.ok(groups.includes(g), g);
  assert.ok(['supertrend', 'psar', 'heikin', 'adx_dmi', 'obv_trend'].every((k) => backtest(pts, k, defaultParams(k)).metrics.roundTrips > 0), 'trend and volume systems trade on the sample');
  const flat = pts.map((p) => [p[0], p[1]]); assert.ok(Number.isFinite(backtest(flat, 'supertrend', {}).metrics.finalValue), 'close-only history still runs (flat candles)');
  const shorts = backtest(pts, 'candle_engulf', defaultParams('candle_engulf')); assert.ok(shorts.trades.some((t) => t.side === 'SHORT' || t.side === 'BUY'));
});

import { mnemonic } from '../../src/marketlens/static/js/pure.js';
test('terminal mnemonics: "INFY GP" opens the chart, one-word commands go to the pages, and ordinary searches are left alone', () => {
  assert.deepEqual(mnemonic('infy gp').hash, '#/chart/INFY'); assert.equal(mnemonic('RELIANCE DES').hash, '#/quote/RELIANCE'); assert.equal(mnemonic('tcs fa').hash, '#/quote/TCS/analysis'); assert.equal(mnemonic('INFY SIG').hash, '#/signals/INFY'); assert.equal(mnemonic('M&M GP').hash, '#/chart/M%26M');
  for (const [w, h] of [['SIG', '#/signals'], ['ord', '#/orders'], ['ops', '#/ops'], ['set', '#/settings'], ['fund', '#/fundamentals'], ['top', '#/'], ['news', '#/news'], ['paper', '#/paper']]) assert.equal(mnemonic(w).hash, h, w);
  assert.equal(mnemonic('infosys'), null); assert.equal(mnemonic('infosys limited'), null); assert.equal(mnemonic('INFY XYZ'), null); assert.equal(mnemonic(''), null);
});
