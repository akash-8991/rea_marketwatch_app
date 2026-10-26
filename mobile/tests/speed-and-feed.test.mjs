// Speed design (bulk quotes, warm sessions, answer-from-saved-data-first) and the automatic end-of-day option feed.
// The fixture is a real excerpt of NSE's published derivatives file for 23-Oct-2026 (trade date inside the file).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { createEngine } from '../engine/engine.js';
import { MemoryStorage } from '../engine/storage.js';
import { BhavcopySource, candidateDates, expiryLabel, parseBhavcopy, unzip, BhavcopyError } from '../engine/bhavcopy.js';
import { pct30 } from '../engine/market.js';
import { NseClient } from '../engine/nse.js';

const CSV = readFileSync(new URL('./fixtures/bhavcopy-sample.csv', import.meta.url), 'utf8');
const H = { 'x-requested-with': 'MarketLens' };
const ACCT = { name: 'Asha Rao', email: 'asha@example.com', dob: '1990-04-02', userId: 'asha.rao', password: 'tulip-orbit-77x' };

/** Minimal single-entry ZIP writer so the test exercises the real reader, not a mock of it. */
function makeZip(name, text) {
  const raw = Buffer.from(text), comp = deflateRawSync(raw), n = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, n, comp]), dir = Buffer.concat([cd, n]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(body.length, 16);
  return new Uint8Array(Buffer.concat([body, dir, end]));
}

test('ZIP reader returns the original bytes; damaged or foreign files are refused', async () => {
  const zip = makeZip('x.csv', CSV);
  assert.equal(new TextDecoder().decode(await unzip(zip)), CSV);
  await assert.rejects(() => unzip(new Uint8Array(100)), BhavcopyError);
  await assert.rejects(() => unzip(zip.subarray(0, zip.length - 30)), BhavcopyError);
});

test('derivatives file: index and stock options parsed, futures ignored, values exact', () => {
  const p = parseBhavcopy(CSV);
  assert.equal(p.tradeDate, '2026-10-23');
  assert.deepEqual(Object.keys(p.symbols).sort(), ['NIFTY', 'RELIANCE']);          // the stock future is not an option
  const n = p.symbols.NIFTY;
  assert.equal(n.kind, 'index'); assert.equal(n.spot, 22600);
  assert.deepEqual(Object.keys(n.expiries), ['2026-10-27', '2026-11-03']);
  const row = n.expiries['2026-10-27'].find((r) => r.strike === 22600);
  assert.deepEqual(row.ce, { oi: 5635370, chgOi: 1823900, vol: 3995812, iv: null, ltp: 124.4, chg: -88.4, bid: null, ask: null });
  assert.deepEqual(row.pe, { oi: 6255600, chgOi: -2320175, vol: 4511492, iv: null, ltp: 150.7, chg: 47.75, bid: null, ask: null });
  assert.equal(p.symbols.RELIANCE.kind, 'stock');
  assert.equal(expiryLabel('2026-10-27'), '27-Oct-2026');
  assert.throws(() => parseBhavcopy(CSV.replace('OpnIntrst', 'Renamed')), /column OpnIntrst missing/);
  assert.throws(() => parseBhavcopy(CSV.split('\n')[0] + '\n'), /no option contracts/);
});

test('which days to try: weekdays only, today only after the 18:30 IST publish, nothing at or before the day we hold', () => {
  const at = (iso) => Date.parse(iso);
  assert.deepEqual(candidateDates(at('2026-10-25T12:00:00Z')).slice(0, 3), ['2026-10-23', '2026-10-22', '2026-10-21']);   // Sunday
  assert.deepEqual(candidateDates(at('2026-10-26T04:30:00Z')).slice(0, 1), ['2026-10-23']);                                // Monday 10:00 IST: not published yet
  assert.deepEqual(candidateDates(at('2026-10-26T14:30:00Z')).slice(0, 2), ['2026-10-26', '2026-10-23']);                  // Monday 20:00 IST
  assert.deepEqual(candidateDates(at('2026-10-25T12:00:00Z'), '2026-10-23'), []);                                          // already have Friday
  assert.deepEqual(candidateDates(at('2026-10-26T14:30:00Z'), '2026-10-23'), ['2026-10-26']);
});

test('source skips holidays (404) and stops at the first published file; other errors surface', async () => {
  const asked = [], zip = makeZip('f.csv', CSV);
  const src = new BhavcopySource({ now: () => Date.parse('2026-10-26T14:30:00Z'), fetchBinary: async (url) => { asked.push(url.match(/_(\d{8})_/)[1]); return asked.length === 1 ? { status: 404, bytes: new Uint8Array() } : { status: 200, bytes: zip }; } });
  const p = await src.fetchLatest(null);
  assert.equal(p.tradeDate, '2026-10-23');
  assert.deepEqual(asked, ['20261026', '20261023']);
  await assert.rejects(() => new BhavcopySource({ now: () => Date.parse('2026-10-26T14:30:00Z'), fetchBinary: async () => ({ status: 500, bytes: new Uint8Array() }) }).fetchLatest(null), /HTTP 500/);
});

/* ---------- the option screen, end to end through the router ---------- */
function fakeSource(opts = {}) {
  const calls = { n: 0 };
  return { calls, fetchLatest: async () => { calls.n++; if (opts.fail) throw new Error('boom'); return opts.none ? null : parseBhavcopy(CSV); } };
}
async function engineWith(source, extra = {}) {
  const t0 = Date.parse('2026-10-26T14:30:00Z'); let clock = t0;
  const e = createEngine({ storage: extra.storage || new MemoryStorage(), optionSource: source, now: () => clock, fetchFn: async () => new Response('', { status: 500 }), settings: { pbkdf2Iterations: 1000, refreshList: false, nseDelayMs: 0, feedDelayMs: 0 } });
  const token = (await e.handle('POST', '/api/auth/signup', { headers: H, body: JSON.stringify(ACCT) })).setToken;
  return { e, token, tick: (ms) => { clock += ms; } };
}
const get = (x, p) => x.e.handle('GET', p, { token: x.token });

test('option chain loads by itself: no upload, nearest expiry first, summary from real contracts, end-of-day label', async () => {
  const src = fakeSource(), x = await engineWith(src);
  const r = (await get(x, '/api/options?symbol=NIFTY')).body;
  assert.equal(r.available, true);
  assert.equal(r.expiry, '27-Oct-2026');
  assert.deepEqual(r.expiries, ['27-Oct-2026', '3-Nov-2026']);
  assert.equal(r.spot, 22600); assert.equal(r.spotEstimated, false);
  assert.equal(r.meta.tradeDate, '2026-10-23');
  assert.equal(r.summary.pcr, 0.975);                                   // puts 23,426,975 / calls 24,018,150
  assert.equal(r.summary.atm, 22600);
  assert.match(r.feed.source, /end-of-day/);
  assert.equal((await get(x, '/api/options?symbol=NIFTY&expiry=3-Nov-2026')).body.rows.length, 1);
  const meta = (await get(x, '/api/options/meta')).body;
  assert.equal(meta.auto, true);
  assert.ok(meta.symbols.includes('RELIANCE') && meta.symbols.indexOf('NIFTY') < meta.symbols.indexOf('RELIANCE'));
  assert.equal((await get(x, '/api/options?symbol=RELIANCE')).body.available, true);   // stock options too
  assert.equal(src.calls.n, 1, 'one download served every symbol and expiry');
  const log = (await get(x, '/api/audit')).body;
  assert.ok(log.entries.some((a) => a.event === 'fetch_ok')); assert.equal(log.verify.ok, true);
});

test('freshness policy: no re-check inside the cooldown, a forced refresh checks once, concurrent opens share one check', async () => {
  const src = fakeSource({ none: true }), x = await engineWith(src);
  await Promise.all([get(x, '/api/options?symbol=NIFTY'), get(x, '/api/options?symbol=NIFTY'), get(x, '/api/options?symbol=BANKNIFTY')]);
  assert.equal(src.calls.n, 1);
  await get(x, '/api/options?symbol=NIFTY'); assert.equal(src.calls.n, 1);
  x.tick(21 * 60 * 1000); await get(x, '/api/options?symbol=NIFTY'); assert.equal(src.calls.n, 2);
  await get(x, '/api/options/meta?refresh=1'); assert.equal(src.calls.n, 3);
  const none = (await get(x, '/api/options?symbol=NIFTY')).body;
  assert.equal(none.available, false);
  assert.match(none.reason, /no option contracts|NSE has/);
});

test('network failure after data was saved: the screen still shows the saved chain, with a warning', async () => {
  const storage = new MemoryStorage();
  let x = await engineWith(fakeSource(), { storage });
  assert.equal((await get(x, '/api/options?symbol=NIFTY')).body.available, true);
  const down = fakeSource({ fail: true });
  const e2 = createEngine({ storage, optionSource: down, now: () => Date.parse('2026-10-27T14:30:00Z'), fetchFn: async () => new Response('', { status: 500 }), settings: { pbkdf2Iterations: 1000 } });
  const tok = (await e2.handle('POST', '/api/auth/login', { headers: H, body: JSON.stringify({ userId: ACCT.userId, password: ACCT.password }) })).setToken;
  const r = (await e2.handle('GET', '/api/options?symbol=NIFTY', { token: tok })).body;
  assert.equal(r.available, true); assert.match(r.warning, /could not fetch the file: boom/); assert.equal(r.meta.tradeDate, '2026-10-23');
  assert.ok((await e2.handle('GET', '/api/audit', { token: tok })).body.entries.some((a) => a.event === 'fetch_failed'));
});

/* ---------- speed ---------- */
const MCP = 'https://mcp.test/m';
function mcpServer({ missRate = 0.6, hang = false } = {}) {
  let seed = 7; const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const sessions = new Set(), s = { posts: 0, inits: 0, tools: {} };
  s.fetch = async (url, init = {}) => {
    if (hang) return new Promise(() => {});
    s.posts++;
    const b = JSON.parse(init.body), sid = init.headers['Mcp-Session-Id'];
    if (b.method === 'initialize') { s.inits++; const id = 'sid' + s.inits; sessions.add(id); return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'Mcp-Session-Id': id } }); }
    if (b.method === 'notifications/initialized') return new Response('', { status: 404 });
    if (!sessions.has(sid) || rand() < missRate) return new Response('nf', { status: 404 });      // wrong backend
    s.tools[b.params.name] = (s.tools[b.params.name] || 0) + 1;
    const out = tool(b.params.name, b.params.arguments);
    return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }) + '\n\n');
  };
  return s;
}
const SYMS = Array.from({ length: 50 }, (_, i) => 'SYM' + i);
function tool(name, a) {
  switch (name) {
    case 'get_top_by_volume': return { stocks: SYMS.map((symbol) => ({ symbol, series: 'EQ', traded_value: 1e10 })) };
    case 'get_bulk_quote': return { count: a.symbols.length, quotes: a.symbols.map((symbol) => ({ symbol, close: 100, open: 99, high: 101, low: 98, prev_close: 99.5, volume: 10, date: '2026-10-23' })) };
    case 'cm_get_live_indices': return { indices: {} };
    case 'get_index_snapshot': case 'get_market_mood': case 'get_market_breadth': return { date: '2026-10-23' };
    case 'get_stock_history': return { data: Array.from({ length: 70 }, (_, i) => ({ date: new Date(Date.UTC(2026, 6, 20 + i)).toISOString().slice(0, 10), open: 1, high: 1, low: 1, close: 100 + i, volume: 1 })) };
    case 'get_52_week_high_low': return { '52w_high': 170, '52w_low': 90 };
    case 'get_corporate_actions': return { actions: [] };
    default: throw new Error('unexpected tool ' + name);
  }
}
const engineOn = (srv, extra = {}) => createEngine({ now: () => Date.parse('2026-10-24T12:00:00Z'), storage: extra.storage || new MemoryStorage(), fetchFn: srv.fetch, settings: { cmUrl: MCP, bhavcopyUrl: MCP, requireLogin: false, universeSize: 50, refreshList: false, nseDelayMs: 0, feedDelayMs: 0, nseTimeoutMs: 100 } });

test('first run: the whole home page costs 6 tool calls (one bulk quote for 50 stocks), not one per stock', async () => {
  const srv = mcpServer({ missRate: 0.6 }), e = engineOn(srv);
  const b = (await e.handle('GET', '/api/bootstrap')).body;
  assert.equal(b.stocks.length, 50);
  assert.deepEqual(srv.tools, { get_top_by_volume: 1, get_bulk_quote: 1, cm_get_live_indices: 1, get_index_snapshot: 1, get_market_mood: 1, get_market_breadth: 1 });
  assert.equal(b.stocks[0].valueCr, 1000); assert.equal(b.stocks[0].price, 100); assert.equal(b.stocks[0].prev, 99.5);
});

test('warm sessions: with 60% of calls misrouted, requests per call stay near 1/(1-miss), not 3x that', async () => {
  const srv = mcpServer({ missRate: 0.6 }), e = engineOn(srv);
  await e.handle('GET', '/api/bootstrap');
  const calls = Object.values(srv.tools).reduce((a, v) => a + v, 0);
  const old = calls * (3 / 0.4);                                            // fresh session per attempt: init + notify + call, 40% success
  assert.ok(srv.posts < old / 2, `${srv.posts} requests for ${calls} calls (a fresh session per attempt would need about ${Math.round(old)})`);
  assert.ok(srv.inits <= 8, `${srv.inits} sessions created`);
});

test('saved data first: with a saved snapshot the home page answers immediately even if NSE never replies', async () => {
  const storage = new MemoryStorage();
  await engineOn(mcpServer({ missRate: 0.3 }), { storage }).handle('GET', '/api/bootstrap');           // creates the saved copy
  const slow = engineOn(mcpServer({ hang: true }), { storage });
  const t = performance.now();
  const r = await slow.handle('GET', '/api/bootstrap');
  assert.ok(performance.now() - t < 100, 'did not wait for NSE');
  assert.equal(r.body.stocks.length, 50); assert.equal(r.body.refreshing, true); assert.equal(r.body.stale, false);
});

test('extras job: 52-week range and 30-day change appear on the stock list once it has run', async () => {
  const srv = mcpServer({ missRate: 0.3 }), e = engineOn(srv);
  await e.handle('GET', '/api/bootstrap');
  assert.equal((await e.handle('GET', '/api/bootstrap')).body.stocks[0].hi52, null);
  await e.handle('GET', '/api/extras');
  for (let i = 0; i < 300 && (await e.handle('GET', '/api/extras')).body.refreshing; i++) await new Promise((r) => setTimeout(r, 10));
  e.cache.clear();
  const s0 = (await e.handle('GET', '/api/bootstrap')).body.stocks[0];
  assert.equal(s0.hi52, 170); assert.equal(s0.lo52, 90); assert.equal(typeof s0.pct30, 'number');
  assert.equal(srv.tools.get_stock_history, 50); assert.equal(srv.tools.get_52_week_high_low, 50);
});

test('pct30 uses the close on or before 30 calendar days back', () => {
  const rows = [['2026-09-20', 100], ['2026-09-23', 110], ['2026-10-01', 120], ['2026-10-23', 132]].map(([date, close]) => ({ date, close }));
  assert.equal(pct30(rows), 20);                                           // base = 2026-09-23 (110)... 132/110 - 1
  assert.equal(pct30([{ date: '2026-10-23', close: 5 }]), null);
});
