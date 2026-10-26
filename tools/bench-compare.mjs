// Prints the before/after table (markdown) from two bench-engine.mjs result files.   node tools/bench-compare.mjs before.json after.json
import { readFileSync } from 'node:fs';
const [before, after] = process.argv.slice(2).map((f) => JSON.parse(readFileSync(f, 'utf8')));
const f = (v) => (v == null || Number.isNaN(v) ? '—' : v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v).toLocaleString('en-US'));
// id, label, target text, test on the AFTER numbers
const ROWS = [
  ['warm_quote', 'Cached quote (2,000 reads)', 'p50 < 100 ms', (a) => a.p50 < 100],
  ['live_quote_uncached', 'Uncached quote, live NSE (15 symbols)', 'p50 < 300 ms', (a) => a.p50 < 300],
  ['live_time_to_price', 'Stock page: time until the price shows', 'p50 < 300 ms', (a) => a.p50 < 300],
  ['live_stock_page_uncached', 'Stock page: all data (4 NSE calls)', 'p50 < 300 ms', (a) => a.p50 < 300],
  ['live_20_symbols', 'Multi-symbol: 20 symbols, cold', 'p50 < 300 ms', (a) => a.p50 < 300],
  ['live_dashboard_cold', 'Dashboard, first ever load (cold)', '< 300 ms', (a) => a.p50 < 300],
  ['live_dashboard_warm', 'Dashboard, saved data (warm)', '< 300 ms', (a) => a.p50 < 300],
  ['live_search', 'Search (saved matches + NSE search)', 'p95 < 300 ms', (a) => a.p95 < 300],
  ['live_market_open_settle', 'Market open: cold start until all live prices are in', 'no target', () => null],
  ['stampede', '100 identical simultaneous requests', '1 NSE call', (a) => a.nseToolCalls === 1],
  ['nse_hang', 'NSE stops answering', 'bounded, no hang', (a) => a.p50 < 5000],
  ['nse_failure', 'NSE returns errors', 'bounded, no hammering', (a) => a.p50 < 5000],
  ['storage_failure', 'Storage fails', 'answers, no crash', (a) => String(a.note).startsWith('HTTP')],
  ['watchlist_50_batch', 'Watchlist of 50, 4 ms network, 30% misroutes', 'p95 < 300 ms', (a) => a.p95 < 300],
];
const out = ['| Scenario | Before p50 | After p50 | Before p95 | After p95 | Before p99 | After p99 | Target | Result |', '|---|---:|---:|---:|---:|---:|---:|---:|---|'];
for (const [id, label, target, test] of ROWS) {
  const b = before.scenarios[id], a = after.scenarios[id]; if (!a) continue;
  const extra = id === 'stampede' ? ` (NSE calls ${b?.nseToolCalls ?? '—'} → ${a.nseToolCalls})` : '';
  const r = !a.n ? 'n/a' : test(a) === null ? '—' : test(a) ? 'Met' : 'Not met';
  out.push(`| ${label}${extra} | ${f(b?.n ? b.p50 : null)} | ${f(a.p50)} | ${f(b?.n ? b.p95 : null)} | ${f(a.p95)} | ${f(b?.n ? b.p99 : null)} | ${f(a.p99)} | ${target} | ${r} |`);
}
console.log(out.join('\n'));
console.log(`\nBefore: ${before.engine} (${before.date.slice(0, 10)}) · After: ${after.engine} · Node ${after.node} · times in ms`);
