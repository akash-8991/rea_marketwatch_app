// Repeatable benchmark of the data engine (the same code the phone app runs; the desktop server has tools/loadtest.py).
//   node tools/bench-engine.mjs --engine mobile/engine/engine.js --label after  --out /tmp/after.json   [--live] [--n 15]
//   node tools/bench-engine.mjs --engine /tmp/old/mobile/engine/engine.js --label before --out /tmp/before.json --live
//   node tools/bench-compare.mjs /tmp/before.json /tmp/after.json
// Without --live only the offline scenarios run (in-process cache, stampede, hang, failure). With --live the scenarios that talk to NSE's real MCP servers
// run too (about 300 polite requests, never more than two at a time). Nothing is invented: a scenario that cannot run on an engine reports why.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const enginePath = resolve(arg('engine', 'mobile/engine/engine.js')), label = arg('label', 'run'), LIVE = !!arg('live', false), N = +arg('n', 15), out = arg('out', '');
const { createEngine } = await import(pathToFileURL(enginePath).href);
const { MemoryStorage } = await import(pathToFileURL(enginePath.replace(/engine\.js$/, 'storage.js')).href);

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const sum = (xs, extra = {}) => ({ n: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), p99: pct(xs, 0.99), max: Math.max(...xs), ...extra });
const MONDAY_CLOSED = Date.parse('2026-10-24T12:00:00Z'), SYMS = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'ITC', 'LT', 'AXISBANK', 'WIPRO', 'MARUTI', 'TITAN', 'SUNPHARMA', 'ONGC', 'NTPC', 'COALINDIA', 'BAJFINANCE', 'HCLTECH', 'KOTAKBANK', 'ASIANPAINT', 'NESTLEIND', 'POWERGRID', 'CIPLA'];
const mk = (extra = {}, fetchFn = (...a) => fetch(...a), now = () => Date.now()) => createEngine({ storage: new MemoryStorage(), fetchFn, now, optionSource: { fetchLatest: async () => null }, settings: { requireLogin: false, refreshList: false, ...extra } });
const time = async (fn) => { const t = performance.now(); const r = await fn(); return [performance.now() - t, r]; };
const R = {};
const has = async (e) => (await e.handle('GET', '/api/quote/PROBE')).status !== 404;   // a symbol no scenario uses, so the probe never warms a cache

/* ---- fake NSE: counts requests, optional misroutes, hang or failure ---- */
function fakeNse({ hang = false, fail = false, delayMs = 4, miss = 0.5 } = {}) {
  let seed = 11; const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648), s = { posts: 0, tools: 0 };
  s.fetch = async (url, init = {}) => {
    if (/feeds\.finance|news\.google/.test(url)) return new Response('<rss><channel></channel></rss>');
    s.posts++; if (hang) return new Promise(() => {}); if (fail) return new Response('boom', { status: 500 });
    await new Promise((r) => setTimeout(r, delayMs));
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'Mcp-Session-Id': 's' } });
    if (b.method === 'notifications/initialized') return new Response('', { status: 404 });
    if (rand() < miss) return new Response('nf', { status: 404 });
    s.tools++; const a = b.params.arguments; let o;
    if (b.params.name === 'cm_get_stock_quote') o = { stock: { lastTradedPrice: 100, preClosePrice: 99, perChange: 1.01, volume: 5, value: 1, latestTimestamp: '2026-10-23 16:00:29' } };
    else if (b.params.name === 'get_stock_history') o = { data: [{ date: '2026-10-23', open: 1, high: 2, low: 1, close: 100, volume: 5 }], next_end_date: null };
    else if (b.params.name === 'get_bulk_quote') o = { quotes: a.symbols.map((symbol) => ({ symbol, close: 100, volume: 5, prev_close: 99 })) };
    else if (b.params.name === 'get_top_by_volume') o = { stocks: SYMS.map((symbol) => ({ symbol, series: 'EQ', traded_value: 1e9 })) };
    else o = { date: '2026-10-23', actions: [], '52w_high': 1, '52w_low': 0, indices: {} };
    return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(o) }] } }) + '\n\n');
  };
  return s;
}

/* S1 warm cache: one symbol read 2,000 times */
{ const f = fakeNse(), e = mk({ nseDelayMs: 0 }, f.fetch, () => MONDAY_CLOSED), path = (await has(e)) ? '/api/quote/TCS' : '/api/stock/TCS';
  await e.handle('GET', path); const xs = []; for (let i = 0; i < 2000; i++) { const [t] = await time(() => e.handle('GET', path)); xs.push(t); }
  R.warm_quote = sum(xs, { endpoint: path, nseRequestsDuringReads: 0 }); }

/* S2 cache stampede: 100 simultaneous requests for one cold symbol */
{ const f = fakeNse(), e = mk({ nseDelayMs: 0 }, f.fetch, () => MONDAY_CLOSED), path = (await has(e)) ? '/api/quote/INFY' : '/api/stock/INFY'; f.posts = 0; f.tools = 0;
  const xs = await Promise.all(Array.from({ length: 100 }, () => time(() => e.handle('GET', path)).then((r) => r[0])));
  R.stampede = sum(xs, { endpoint: path, nseToolCalls: f.tools, nseRequests: f.posts, note: '100 identical simultaneous requests' }); }

/* S3 NSE hangs (never answers): default settings on both engines */
{ const f = fakeNse({ hang: true }), e = mk({}, f.fetch, () => MONDAY_CLOSED), path = (await has(e)) ? '/api/quote/INFY' : '/api/stock/INFY';
  const cap = new Promise((r) => setTimeout(() => r('capped'), 30000)); const [t, r] = await time(() => Promise.race([e.handle('GET', path), cap]));
  R.nse_hang = { n: 1, p50: t, p95: t, p99: t, max: t, endpoint: path, note: r === 'capped' ? 'no answer within the 30 s the benchmark waits' : `answered with HTTP ${r.status}` }; }

/* S4 NSE failure (HTTP 500 on every call) */
{ const f = fakeNse({ fail: true }), e = mk({ nseTimeoutMs: 2000 }, f.fetch, () => MONDAY_CLOSED), path = (await has(e)) ? '/api/quote/INFY' : '/api/stock/INFY';
  const [t, r] = await time(() => e.handle('GET', path)); R.nse_failure = { n: 1, p50: t, p95: t, p99: t, max: t, endpoint: path, note: `HTTP ${r.status}${r.body && r.body.status ? ', status ' + r.body.status : ''}` }; }

/* S5 storage failure: every read throws; the API must answer, not crash */
{ const st = new MemoryStorage(); const e = createEngine({ storage: st, fetchFn: fakeNse().fetch, now: () => MONDAY_CLOSED, optionSource: { fetchLatest: async () => null }, settings: { requireLogin: false, refreshList: false } });
  await e.handle('GET', '/api/auth/status'); st.get = async () => { throw new Error('disk failure'); };
  const [t, r] = await time(() => e.handle('GET', '/api/bootstrap').catch((x) => ({ status: 'threw ' + x.message }))); R.storage_failure = { n: 1, p50: t, p95: t, p99: t, max: t, note: `HTTP ${r.status}` }; }

/* S6 large watchlist: 50 symbols in one batch against a fast fake NSE (new engines only) */
{ const f = fakeNse({ miss: 0.3 }), e = mk({ nseDelayMs: 0 }, f.fetch, () => MONDAY_CLOSED);
  if (await has(e)) { const list = Array.from({ length: 50 }, (_, i) => 'S' + String(i).padStart(3, '0')); const xs = [];
    for (let k = 0; k < 5; k++) { const e2 = mk({ nseDelayMs: 0 }, fakeNse({ miss: 0.3 }).fetch, () => MONDAY_CLOSED); const [t] = await time(() => e2.handle('GET', `/api/quotes?symbols=${list.join(',')}`)); xs.push(t); }
    R.watchlist_50_batch = sum(xs, { endpoint: '/api/quotes (50 symbols, 30% misroutes, 4 ms network)' }); } else R.watchlist_50_batch = { n: 0, note: 'no batch endpoint in this version' }; }

if (LIVE) {
  const live = (extra = {}, now = () => Date.now()) => mk(extra, undefined, now);
  const syms = SYMS.slice(0, N);
  /* L1 uncached single quote (warm sessions) */
  { const e = live({}, () => MONDAY_CLOSED), q = (await has(e)) ? (s) => `/api/quote/${s}` : (s) => `/api/stock/${s}`; await e.nse.cm('cm_get_stock_quote', { symbol: 'RELIANCE' });
    const xs = []; for (const s of syms) { const [t] = await time(() => e.handle('GET', q(s))); xs.push(t); }
    R.live_quote_uncached = sum(xs, { endpoint: q('X').replace('X', ':sym'), nseRequests: e.nse.stats.requests, misroutes: e.nse.stats.misses }); }
  /* L2 uncached stock page (everything the page shows) */
  { const e = live({}, () => MONDAY_CLOSED); await e.nse.cm('cm_get_stock_quote', { symbol: 'RELIANCE' }); const xs = [];
    for (const s of syms.slice(0, 8)) { const [t] = await time(() => e.handle('GET', `/api/stock/${s}`)); xs.push(t); } R.live_stock_page_uncached = sum(xs, { endpoint: '/api/stock/:sym' }); }
  /* L3 multi-symbol: 20 symbols */
  { const e = live({}, () => MONDAY_CLOSED), twenty = SYMS.slice(3, 23); await e.nse.cm('cm_get_stock_quote', { symbol: 'RELIANCE' }); let t, r;
    if (await has(e)) { [t, r] = await time(() => e.handle('GET', `/api/quotes?symbols=${twenty.join(',')}`)); R.live_20_symbols = { n: 1, p50: t, p95: t, p99: t, max: t, endpoint: '/api/quotes (20 symbols)', nseRequests: e.nse.stats.requests, ok: r.body.quotes?.filter((x) => x.status !== 'unavailable').length }; }
    else { [t, r] = await time(() => Promise.all(twenty.map((s) => e.handle('GET', `/api/stock/${s}`)))); R.live_20_symbols = { n: 1, p50: t, p95: t, p99: t, max: t, endpoint: '20 x /api/stock (what a watchlist had to do)', nseRequests: e.nse.stats.requests }; } }
  /* L4 dashboard cold and warm (closed market) */
  { const xs = [], ws = []; let reqs = 0; for (let k = 0; k < 3; k++) { const e = live({}, () => MONDAY_CLOSED); const [t] = await time(() => e.handle('GET', '/api/bootstrap')); xs.push(t); reqs = e.nse.stats.requests; const [w] = await time(() => e.handle('GET', '/api/bootstrap')); ws.push(w); }
    R.live_dashboard_cold = sum(xs, { nseRequests: reqs }); R.live_dashboard_warm = sum(ws); }
  /* L5 market open: cold dashboard plus the live-price overlay until it settles */
  { const open = Date.parse('2026-10-26T11:00:00+05:30'), e = live({}, () => open); const t0 = performance.now(); await e.handle('GET', '/api/bootstrap'); const first = performance.now() - t0;
    for (let i = 0; i < 400; i++) { const b = (await e.handle('GET', '/api/bootstrap')).body; if (!b.refreshing) break; await new Promise((r) => setTimeout(r, 50)); }
    R.live_market_open_settle = { n: 1, p50: performance.now() - t0, p95: performance.now() - t0, p99: performance.now() - t0, max: performance.now() - t0, firstPaintMs: first, nseRequests: e.nse.stats.requests, note: 'first answer, then every live quote in; the market-state label may read "holiday" because NSE\'s quote dates are not today' }; }
  /* L6 stock page: price only (new) vs whole page (old) */
  { const e = live({}, () => MONDAY_CLOSED), p = (await has(e)) ? '/api/quote/' : '/api/stock/'; await e.nse.cm('cm_get_stock_quote', { symbol: 'RELIANCE' }); const xs = [];
    for (const s of syms.slice(8, 8 + 8)) { const [t] = await time(() => e.handle('GET', p + s)); xs.push(t); } R.live_time_to_price = sum(xs, { endpoint: p + ':sym', note: 'time until the price can be shown on a stock page' }); }
  /* L7 search */
  { const e = live({}, () => MONDAY_CLOSED); await e.handle('GET', '/api/bootstrap'); const xs = []; for (const q of ['rel', 'tata', 'infos', 'hdfc', 'bank', 'wip']) { const [t] = await time(() => e.handle('GET', `/api/search?q=${q}`)); xs.push(t); } R.live_search = sum(xs, { note: 'saved matches plus NSE symbol search' }); }
}
const result = { label, engine: enginePath, live: LIVE, date: new Date().toISOString(), node: process.version, scenarios: R };
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
for (const [k, v] of Object.entries(R)) console.log(k.padEnd(26), v.n === 0 ? v.note : `n=${v.n} p50=${v.p50?.toFixed(2)} p95=${v.p95?.toFixed(2)} p99=${v.p99?.toFixed(2)} ms ${v.nseRequests != null ? `| nse requests ${v.nseRequests}` : ''}${v.nseToolCalls != null ? `| nse tool calls ${v.nseToolCalls} (requests ${v.nseRequests})` : ''} ${v.note ? '| ' + v.note : ''}`);
process.exit(0);
