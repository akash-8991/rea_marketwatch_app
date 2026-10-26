// Lean quotes, batch quotes, chart history and route metrics on the on-device API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../engine/engine.js';
import { MemoryStorage } from '../engine/storage.js';

const MCP = 'https://mcp.test/m';
const at = (iso) => Date.parse(iso + '+05:30');
function server() {
  const s = { quote: [], history: [] };
  s.fetch = async (url, init = {}) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'Mcp-Session-Id': 's' } });
    if (b.method === 'notifications/initialized') return new Response('', { status: 404 });
    const a = b.params.arguments; let out;
    if (b.params.name === 'cm_get_stock_quote') { s.quote.push(a.symbol); out = a.symbol === 'BAD' ? { stock: null } : { stock: { lastTradedPrice: 105, preClosePrice: 100, perChange: 5, volume: 777, value: 1.5, latestTimestamp: '2026-10-26 10:42:11', fiftyTwoWeekHigh: 150, fiftyTwoWeekLow: 80 } }; }
    else if (b.params.name === 'get_stock_history') {
      s.history.push(a.endDate);
      const chunks = { '': ['2026-07-27', '2026-10-26', '2026-07-25'], '2026-07-25': ['2026-04-27', '2026-07-24', '2026-04-24'], '2026-04-24': ['2026-01-02', '2026-04-23', null] };
      const [from, to, next] = chunks[a.endDate]; const d0 = Date.parse(from), days = Math.round((Date.parse(to) - d0) / 86400000);
      out = { data: Array.from({ length: Math.floor(days / 3) + 1 }, (_, i) => ({ date: new Date(d0 + i * 3 * 86400000).toISOString().slice(0, 10), close: 100 + i, volume: 10 })), next_end_date: next };
    } else out = { date: '2026-10-23' };
    return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }) + '\n\n');
  };
  return s;
}
const eng = (srv, when, extra = {}) => createEngine({ storage: extra.storage || new MemoryStorage(), fetchFn: srv.fetch, now: () => when.t, optionSource: { fetchLatest: async () => null },
  settings: { cmUrl: MCP, bhavcopyUrl: MCP, requireLogin: false, refreshList: false, nseDelayMs: 0, feedDelayMs: 0, nseTimeoutMs: 200 } });
const get = (e, p) => e.handle('GET', p).then((r) => r.body);

test('lean quote: shape, honest status by market state, company name from the list', async () => {
  const open = { t: at('2026-10-26T10:45:00') }, srv = server(), e = eng(srv, open);
  await get(e, '/api/bootstrap').catch(() => {});
  const q = await get(e, '/api/quote/TCS');
  assert.deepEqual([q.sym, q.price, q.abs, q.chg, q.exchange, q.name], ['TCS', 105, 5, 5, 'NSE', 'Tata Consultancy Services Ltd.']);
  assert.equal(q.status, 'live'); assert.equal(q.fromCache, false);
  open.t = at('2026-10-26T10:55:00');                     // quote stamped 10:42:11 is now 13 minutes old while the market is open
  e.cache.clear(); assert.equal((await get(e, '/api/quote/TCS')).status, 'delayed');
  open.t = at('2026-10-26T16:00:00'); e.cache.clear();
  assert.equal((await get(e, '/api/quote/TCS')).status, 'closed');
  assert.equal((await e.handle('GET', '/api/quote/bad%20sym!')).status, 400);
});

test('quote falls back to the saved copy (stale) and says unavailable when there is nothing', async () => {
  const storage = new MemoryStorage();
  await storage.set('snap:bootstrap', { at: 1, val: { stocks: [{ sym: 'WIPRO', price: 250, prev: 245, volume: 5, ts: '2026-10-23' }], indices: [], valuation: [], mood: {}, breadth: {}, sectorIndices: [] } });
  const down = { fetch: async () => new Response('', { status: 500 }) };
  const e = eng(down, { t: at('2026-10-26T16:00:00') }, { storage });
  const s = await get(e, '/api/quote/WIPRO');
  assert.deepEqual([s.status, s.price, s.chg], ['stale', 250, 2.04]); assert.ok(s.reason);
  const u = await get(e, '/api/quote/NOSAVED'); assert.equal(u.status, 'unavailable'); assert.ok(u.reason);
});

test('batch quotes: validates, de-duplicates, keeps order, one NSE request per distinct symbol, cached, capped at 50', async () => {
  const srv = server(), e = eng(srv, { t: at('2026-10-26T16:00:00') });
  const r = await get(e, '/api/quotes?symbols=tcs,TCS,INFY,bad%20sym!,BAD,');
  assert.deepEqual(r.quotes.map((x) => x.sym), ['TCS', 'INFY', 'BAD SYM!', 'BAD']);
  assert.deepEqual(r.quotes.map((x) => x.status), ['closed', 'closed', 'unavailable', 'unavailable']);
  assert.deepEqual([...srv.quote].sort(), ['BAD', 'INFY', 'TCS']);
  await get(e, '/api/quotes?symbols=TCS,INFY'); assert.equal(srv.quote.length, 3, 'second call came from the cache');
  const parallel = await Promise.all([get(e, '/api/quote/HDFCBANK'), get(e, '/api/quote/HDFCBANK'), get(e, '/api/quotes?symbols=HDFCBANK')]);
  assert.equal(srv.quote.filter((x) => x === 'HDFCBANK').length, 1, 'simultaneous requests share one NSE request (coalescing)'); assert.equal(parallel.length, 3);
  assert.equal((await get(e, `/api/quotes?symbols=${Array.from({ length: 60 }, (_, i) => 'S' + i).join(',')}`)).truncated, true);
  assert.equal((await e.handle('GET', '/api/quotes')).status, 400);
});

test('history: short ranges cost one NSE call, longer ranges extend the saved series, truncation is stated, 1D is honestly unavailable', async () => {
  const srv = server(), e = eng(srv, { t: at('2026-10-26T16:00:00') });
  const m1 = await get(e, '/api/history/TCS?range=1M');
  assert.equal(m1.available, true); assert.equal(srv.history.length, 1); assert.ok(m1.points.length > 5 && m1.points.every((p) => p[0] >= '2026-09-25'));
  await get(e, '/api/history/TCS?range=1W'); assert.equal(srv.history.length, 1, 'saved series reused');
  const y = await get(e, '/api/history/TCS?range=1Y');
  assert.equal(srv.history.length, 3, 'older chunks are fetched one after another, each from the previous next_end_date');
  assert.deepEqual(srv.history, ['', '2026-07-25', '2026-04-24']);
  assert.equal(y.truncated, true); assert.equal(y.earliest, '2026-01-02'); assert.match(y.note, /starts on 2026-01-02/);
  const dates = y.points.map((p) => p[0]); assert.deepEqual(dates, [...new Set(dates)].sort());
  await get(e, '/api/history/TCS?range=10Y'); assert.equal(srv.history.length, 3, 'history is complete: nothing more to fetch');
  const d1 = await get(e, '/api/history/TCS?range=1D'); assert.equal(d1.available, false); assert.match(d1.reason, /daily data only/);
  assert.match((await get(e, '/api/history/TCS?range=7Y')).reason, /unknown range/);
});

test('metrics: per-route percentiles with templated labels, cache hit rate, coalescing, NSE counters', async () => {
  const srv = server(), e = eng(srv, { t: at('2026-10-26T16:00:00') });
  for (let i = 0; i < 5; i++) await get(e, '/api/quote/TCS');
  await get(e, '/api/quote/INFY');
  const m = await get(e, '/api/metrics');
  assert.equal(m.routes['/api/quote/:sym'].n, 6); assert.ok(m.routes['/api/quote/:sym'].p99_ms >= m.routes['/api/quote/:sym'].p50_ms);
  assert.ok(!Object.keys(m.routes).some((k) => /TCS|INFY/.test(k)), 'no symbol ever becomes a label');
  assert.ok(m.cache.hits >= 4 && m.cache.hitRate > 0.5); assert.ok(m.nse.requests >= 2); assert.equal(m.nse.available, true);
});

test('a quote is answered from the saved copy when NSE stops answering, without waiting for the request to end', async () => {
  const storage = new MemoryStorage();
  await storage.set('snap:bootstrap', { at: 1, val: { stocks: [{ sym: 'WIPRO', price: 250, prev: 245, volume: 5, ts: '2026-10-23' }], indices: [], valuation: [], mood: {}, breadth: {}, sectorIndices: [] } });
  const hang = { fetch: () => new Promise(() => {}) };
  const e = createEngine({ storage, fetchFn: hang.fetch, now: () => at('2026-10-26T16:00:00'), optionSource: { fetchLatest: async () => null },
    settings: { cmUrl: MCP, bhavcopyUrl: MCP, requireLogin: false, refreshList: false, nseDelayMs: 0, nseTimeoutMs: 5000, quoteDeadlineMs: 150 } });
  const t = performance.now(); const q = await get(e, '/api/quote/WIPRO');
  assert.ok(performance.now() - t < 1500, 'answered at the deadline, not after the 15 s of retries');
  assert.deepEqual([q.status, q.price], ['stale', 250]); assert.match(q.reason, /did not answer/);
});

test('search answers from saved matches and the stock list when NSE search is slow, instead of waiting for it', async () => {
  const hang = { fetch: () => new Promise(() => {}) };
  const e = createEngine({ storage: new MemoryStorage(), fetchFn: hang.fetch, now: () => at('2026-10-26T16:00:00'), optionSource: { fetchLatest: async () => null },
    settings: { cmUrl: MCP, bhavcopyUrl: MCP, requireLogin: false, refreshList: false, nseDelayMs: 0, nseTimeoutMs: 5000, searchDeadlineMs: 120 } });
  const t = performance.now(); const r = await get(e, '/api/search?q=infosys');
  assert.ok(performance.now() - t < 1000);
  assert.ok(r.results.some((x) => x.symbol === 'INFY' && x.source === 'list')); assert.match(r.note, /unavailable|paused|slow/i);
});

test('a failing NSE is not hammered: backoff between errors and a limit on attempts', async () => {
  let posts = 0; const fetchFn = async () => { posts++; return new Response('boom', { status: 500 }); };
  const e = eng({ fetch: fetchFn }, { t: at('2026-10-26T16:00:00') }); const t = performance.now();
  const q = await get(e, '/api/quote/FAIL1'); assert.equal(q.status, 'unavailable');
  assert.ok(posts <= 16, `${posts} requests for one failing quote`); assert.ok(performance.now() - t < 5000);
});
