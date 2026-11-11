// Latency of the in-process decision path against the 1 ms budget. Usage: node tools/bench-desk.mjs [iterations]
import * as C from '../src/marketlens/static/js/desk-core.js';
import { applyFeed } from '../src/marketlens/static/js/pure.js';
import { Latency } from '../src/marketlens/static/js/latency.js';

const N = +process.argv[2] || 5000, lat = new Latency(), now = Date.parse('2026-11-09T10:30:00+05:30');
const prop = (a, s) => ({ schema_version: '1.0', proposal_id: a, agent_type: a, instrument_id: 'NSE:RELIANCE', direction: 'BUY', score: s, confidence: 0.8, horizon_seconds: 900, valid_until: now + 6e5, evidence: [{ kind: 'x', id: '1', weight: 1 }], reason_codes: [], model_version: 'x' });
const props = ['news', 'technical', 'fundamental', 'derivatives', 'regime'].map((a) => prop(a, 0.6));
const D = { indices: [{ name: 'NIFTY 50', last: 1, prev: 1 }], sectorIdx: [], market: null }, bySym = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`S${i}`, { price: 100 }]));
const feed = (k) => ({ market: { live: true }, indices: [{ name: 'NIFTY 50', last: 22000 + k, prev: 21900 }], quotes: Object.keys(bySym).map((s) => ({ sym: s, price: 100 + (k % 5), prev: 99, status: 'live' })) });
const broker = { name: 'shadow', async place(p) { return { status: 'FILLED', broker_order_id: 'S', price: 100, filled: p.quantity }; } };
const ctx = { account: { equity: 1e6, cash: 1e6 }, positions: [], quote: { price: 1200, ageSeconds: 1, valueCr: 500 }, openOrders: 0, recentIntents: [], recentOrderTimes: [], limits: { requireBacktest: false }, kill: {}, now };
for (let i = 0; i < N; i++) {
  const t0 = lat.clock();
  lat.time('feed_apply (40 stocks + indices)', () => applyFeed(D, bySym, feed(i)));
  const f = lat.time('fuse (5 agents)', () => C.fuse(props, C.FUSION_DEFAULT, now));
  const it = lat.time('build_intent', () => C.buildIntent({ fused: f, sym: 'RELIANCE', price: 1200, atr: 20, equity: 1e6, now: now + i * 1000, sector: 'Energy' }));
  const d = lat.time('risk_evaluate (24 checks)', () => C.riskEvaluate(it, ctx));
  await lat.timeAsync('execute (shadow broker)', () => C.execute({ ...it, client_order_id: `ML${i}` }, d, { broker, orders: [], now: () => now }), 1);
  lat.record('signal_to_order (fuse..execute)', lat.clock() - t0 - 0, 1);
}
const f = (x) => x.toFixed(4).padStart(9);
console.log(`${N} iterations, budget ${1} ms (p99)\n${'stage'.padEnd(36)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'p99'.padStart(9)}${'max'.padStart(9)}  verdict`);
for (const s of lat.all()) console.log(`${s.stage.padEnd(36)}${f(s.p50)}${f(s.p95)}${f(s.p99)}${f(s.max)}  ${s.within === false ? 'OVER budget' : 'within 1 ms'}`);
