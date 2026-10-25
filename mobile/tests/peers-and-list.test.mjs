// The stock list (names, industries) and the peer comparison built on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine } from '../engine/engine.js';
import { MemoryStorage } from '../engine/storage.js';
import { Securities, parseList, ListError, REFRESH_EVERY_MS, SOURCES } from '../engine/securities.js';
import { SECURITIES } from '../engine/sectors.js';

const FULL = readFileSync(new URL('../../src/marketlens/data/ind_niftytotalmarket_list.csv', import.meta.url), 'utf8');
const WEEK = REFRESH_EVERY_MS;

test('the bundled list: 755 stocks, 22 industries, names and NSE codes', () => {
  assert.equal(Object.keys(SECURITIES).length, 755);
  assert.equal(new Set(Object.values(SECURITIES).map((v) => v[0])).size, 22);
  assert.deepEqual(SECURITIES.INFY, ['Information Technology', 'Infosys Ltd.']);
  assert.equal(parseList(FULL).size, 755);
});

test('a download that is not a usable list is refused with a reason', () => {
  assert.throws(() => parseList('a,b\n1,2'), ListError);
  assert.throws(() => parseList('Company Name,Industry,Symbol\nX,Y,Z\n'), /only 1 stocks/);
  assert.throws(() => parseList('<html>blocked</html>'), ListError);
});

function secs(opts = {}) {
  const storage = opts.storage || new MemoryStorage(), clock = { t: 1_800_000_000_000 }, log = [], asked = [];
  const fetchText = async (url) => { asked.push(url); const r = (opts.respond || (() => FULL))(url, asked.length); if (r instanceof Error) throw r; return r; };
  const s = new Securities({ storage, fetchText, now: () => clock.t, audit: async (...a) => { log.push(a); } });
  return { s, storage, clock, log, asked };
}

test('weekly refresh: replaces the list, saves it, reports what changed, and is not repeated inside the week', async () => {
  const changed = FULL.replace('ICICILIFE', 'NEWSYMBOL1').replace(/^(.*),Realty,(\w+),/m, '$1,Power,$2,');   // one rename, one industry move
  const x = secs({ respond: () => changed });
  const r = await x.s.refresh();
  assert.deepEqual([r.added.length, r.removed.length], [1, 1]); assert.equal(r.moved.length, 1); assert.equal(r.changed, true);
  assert.ok(x.s.get('NEWSYMBOL1')); assert.equal(x.s.get('ICICILIFE'), null);
  assert.equal(x.asked.length, 1); assert.equal(x.asked[0], SOURCES[0]);
  assert.equal(x.log[0][0], 'securities_updated');
  assert.deepEqual(await x.s.refresh(), { skipped: 'checked within the last 7 days' });
  x.clock.t += WEEK + 1000; await x.s.refresh(); assert.equal(x.asked.length, 2);
  const fresh = new Securities({ storage: x.storage, fetchText: async () => { throw new Error('offline'); }, now: () => x.clock.t });   // an app restart
  await fresh.load(); assert.ok(fresh.get('NEWSYMBOL1'), 'the saved copy is used');
});

test('falls back to the second source, and keeps the saved list when every download fails or is invalid', async () => {
  const two = secs({ respond: (url) => (url === SOURCES[0] ? new Error('HTTP 403') : FULL) });
  assert.equal((await two.s.refresh()).source, 'www.niftyindices.com');
  const bad = secs({ respond: () => 'Company Name,Industry,Symbol\nA,B,C\n' });
  const r = await bad.s.refresh();
  assert.match(r.skipped, /download failed/); assert.equal(bad.s.rows.size, 755);
  assert.equal(bad.log[0][0], 'securities_update_failed');
  assert.equal(bad.asked.length, 2, 'both sources tried once');
  assert.deepEqual(await bad.s.refresh(), { skipped: 'checked within the last 7 days' });   // a dead link is retried next week, not every start
});

test('company-name search, case and word order free', () => {
  const { s } = secs();
  assert.equal(s.searchNames('infosys')[0].symbol, 'INFY');
  assert.equal(s.searchNames('Tata Consultancy')[0].symbol, 'TCS');
  assert.deepEqual(s.searchNames('zz'), []);
  assert.equal(s.sector('TCS'), 'Information Technology'); assert.equal(s.sector('NOPE'), 'Other');
});

/* ---------- peers through the router ---------- */
const MCP = 'https://mcp.test/m';
function nseFor(members) {
  const calls = { tools: {} };
  calls.fetch = async (url, init = {}) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'Mcp-Session-Id': 's' } });
    if (b.method === 'notifications/initialized') return new Response('', { status: 404 });
    const name = b.params.name, a = b.params.arguments; calls.tools[name] = (calls.tools[name] || 0) + 1;
    let out;
    if (name === 'get_bulk_quote') out = { quotes: a.symbols.map((symbol, i) => ({ symbol, close: 100, volume: (a.symbols.length - i) * 1000, prev_close: 99, date: '2026-10-23' })) };
    else if (name === 'cm_get_stock_quote') out = { stock: { lastTradedPrice: 105, preClosePrice: 100, perChange: 5, volume: 777, value: 1.5, latestTimestamp: '2026-10-26 10:42:11' } };
    else out = { date: '2026-10-23' };
    return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }) + '\n\n');
  };
  return calls;
}
const eng = (srv, extra = {}) => createEngine({ storage: extra.storage || new MemoryStorage(), fetchFn: srv.fetch, optionSource: { fetchLatest: async () => null },
  settings: { cmUrl: MCP, bhavcopyUrl: MCP, requireLogin: false, refreshList: false, nseDelayMs: 0, feedDelayMs: 0, nseTimeoutMs: 200 } });
const get = (e, p) => e.handle('GET', p).then((r) => r.body);

test('peers: same industry, ranked by last session turnover, live prices for the shown rows, three bulk calls at most', async () => {
  const srv = nseFor(), e = eng(srv);
  const p = await get(e, '/api/peers/INFY');
  assert.equal(p.company, 'Infosys Ltd.'); assert.equal(p.industry, 'Information Technology'); assert.equal(p.count, 40);
  assert.equal(p.peers.length, 10); assert.ok(!p.peers.some((x) => x.sym === 'INFY'));
  assert.equal(p.self.sym, 'INFY'); assert.equal(p.self.price, 105); assert.equal(p.self.chg, 5);
  assert.ok(p.peers.every((x) => x.name && x.name !== x.sym), 'company names come from the list');
  assert.ok(srv.tools.get_bulk_quote <= 1, `one bulk call for 40 stocks, got ${srv.tools.get_bulk_quote}`);
  assert.equal(srv.tools.cm_get_stock_quote, 11, '10 peers + the stock itself');
  const again = await get(e, '/api/peers/INFY'); assert.equal(again.peers.length, 10);
  assert.equal(srv.tools.cm_get_stock_quote, 11, 'cached for a minute');
  assert.equal((await get(e, '/api/peers/NOPEXYZ')).peers.length, 0);
  assert.equal((await e.handle('GET', '/api/peers/bad%20sym!')).status, 400);
});

test('peers when NSE is unreachable: names and saved prices, flagged stale, no error', async () => {
  const storage = new MemoryStorage();
  await storage.set('snap:bootstrap', { at: Date.now(), val: { asOf: 'x', stocks: [{ sym: 'TCS', price: 2500, prev: 2400, volume: 5, valueCr: 9, ts: '2026-10-23' }], indices: [], valuation: [], mood: {}, breadth: {}, sectorIndices: [] } });
  const e = createEngine({ storage, fetchFn: async () => new Response('', { status: 500 }), optionSource: { fetchLatest: async () => null }, settings: { requireLogin: false, refreshList: false, nseDelayMs: 0, nseTimeoutMs: 100 } });
  const p = await get(e, '/api/peers/INFY');
  assert.equal(p.stale, true); assert.equal(p.peers.length, 10);
  assert.ok(p.peers.every((x) => x.name));
  const tcs = (await get(e, '/api/peers/WIPRO')).peers.find((x) => x.sym === 'TCS');
  if (tcs) { assert.equal(tcs.price, 2500); assert.equal(tcs.chg, 4.17); }
});

test('stock payload carries company and industry; search finds a stock by company name', async () => {
  const e = eng(nseFor());
  const s = await get(e, '/api/stock/INFY');
  assert.equal(s.company, 'Infosys Ltd.'); assert.equal(s.industry, 'Information Technology');
  const r = await get(e, '/api/search?q=infosys');
  assert.ok(r.results.some((x) => x.symbol === 'INFY' && x.name === 'Infosys Ltd.' && x.source === 'list'));
});
