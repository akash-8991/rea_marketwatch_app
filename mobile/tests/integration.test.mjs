// End-to-end through engine.handle() with a fake NSE MCP server and fake RSS feeds. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../engine/engine.js';
import { MemoryStorage } from '../engine/storage.js';

const CM = 'https://mcp.test/cm', BH = 'https://mcp.test/bh';
const H = { 'x-requested-with': 'MarketLens' };
const SYMS = ['TCS', 'INFY', 'HDFCBANK'];
const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 2);

function tool(name, a) {
  switch (name) {
    case 'cm_get_live_indices': return { nseTimestamp: 't', indices: { g: [{ indexName: 'NIFTY 50', last: 24500, previousClose: 24400, percChange: 0.41 }] } };
    case 'get_index_snapshot': return { indices: [{ indexName: 'NIFTY 50', close: 24500, pointsChange: 100, pe: 22, pb: 3.5, divYield: 1.3, pctChange: 0.41 }] };
    case 'get_market_mood': return { date: '2026-10-23' };
    case 'get_market_breadth': return { date: '2026-10-23' };
    case 'get_top_by_volume': return { stocks: SYMS.map((s) => ({ symbol: s, series: 'EQ', traded_value: 35e9 })) };
    case 'get_bulk_quote': return { count: a.symbols.length, quotes: a.symbols.map((symbol) => ({ symbol, close: 3500, open: 3460, high: 3520, low: 3440, prev_close: 3450, pct_change: 1.4, volume: 1000, date: '2026-10-23' })) };
    case 'cm_get_stock_quote': return { stock: { lastTradedPrice: 3500, preClosePrice: 3450, openPrice: 3460, highPrice: 3520, lowPrice: 3440, volume: 1000, value: 35, fiftyTwoWeekHigh: 4000, fiftyTwoWeekLow: 3000, perChange30d: 6.2, latestTimestamp: 't' } };
    case 'get_stock_history': return { data: closes.map((c, i) => ({ date: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, open: c, high: c + 1, low: c - 1, close: c, volume: 10 })), summary: {} };
    case 'get_corporate_actions': return { actions: [{ actionType: 'DIVIDEND', exDate: '2026-05-01', purpose: 'Dividend Rs 20 per share' }] };
    case 'get_52_week_high_low': return { '52w_high': 4000, '52w_low': 3000 };
    case 'search_symbols': return { results: [{ symbol: 'TCSELXSI', name: 'x' }] };
    default: throw new Error('unknown tool ' + name);
  }
}

const RSS = (t) => `<?xml version="1.0"?><rss version="2.0"><channel><item><title>${t}</title><link>https://example.com/${encodeURIComponent(t)}</link><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;

function fakeNet({ flaky = true, blockWith = 0 } = {}) {
  const calls = { post: 0, rss: 0, blocked: 0, tools: {} };
  let n = 0, inflight = 0, seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  calls.maxInflight = 0;
  const fetchFn = async (url, init = {}) => {
    if (/feeds\.finance\.yahoo|news\.google/.test(url)) { calls.rss++; return new Response(RSS('Sensex surges as banks rally'), { status: 200 }); }
    calls.post++;
    if (blockWith) { calls.blocked++; return new Response('denied', { status: blockWith }); }
    inflight++; calls.maxInflight = Math.max(calls.maxInflight, inflight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { status: 200, headers: { 'Mcp-Session-Id': 'sid' + ++n } });
      if (body.method === 'notifications/initialized') return new Response('', { status: 404 });   // NSE quirk
      if (flaky && rand() < 0.5) return new Response('not found', { status: 404 });                  // wrong backend for the session
      calls.tools[body.params.name] = (calls.tools[body.params.name] || 0) + 1;
      const out = tool(body.params.name, body.params.arguments);
      return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }) + '\n\n', { status: 200 });
    } finally { inflight--; }
  };
  return { fetchFn, calls };
}

const NOFILE = { fetchLatest: async () => null };
const make = (net, extra = {}) => createEngine({ storage: new MemoryStorage(), fetchFn: net.fetchFn, optionSource: NOFILE, settings: { cmUrl: CM, bhavcopyUrl: BH, pbkdf2Iterations: 1000, universeSize: 3, refreshList: false, nseDelayMs: 0, feedDelayMs: 0, ...extra } });
const get = (e, p, token) => e.handle('GET', p, { token });
const post = (e, p, body, token, headers = H) => e.handle('POST', p, { token, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const ACCT = { name: 'Asha Rao', email: 'asha@example.com', dob: '1990-04-02', userId: 'asha.rao', password: 'tulip-orbit-77x' };

async function signedIn(e) {
  const r = await post(e, '/api/auth/signup', ACCT);
  assert.equal(r.status, 201);
  return r.setToken;
}

test('API refuses everything but auth until signed in; first run reports no users', async () => {
  const e = make(fakeNet());
  assert.deepEqual((await get(e, '/api/auth/status')).body, { loginRequired: true, usersExist: false, signedIn: false });
  assert.equal((await get(e, '/api/bootstrap')).status, 401);
  assert.equal((await get(e, '/api/options')).status, 401);
});

test('signup, login, wrong password, lockout, logout', async () => {
  const e = make(fakeNet());
  const t = await signedIn(e);
  assert.equal((await get(e, '/api/auth/me', t)).body.user.userId, 'asha.rao');
  assert.equal((await post(e, '/api/auth/signup', ACCT)).status, 409);                                     // duplicate
  assert.equal((await post(e, '/api/auth/signup', { ...ACCT, userId: 'other.one', email: 'o@example.com', password: 'password123' })).status, 400);   // common password
  assert.equal((await post(e, '/api/auth/signup', ACCT, null, {})).status, 403);                            // CSRF header required
  assert.equal((await post(e, '/api/auth/login', { userId: 'asha.rao', password: ACCT.password })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await post(e, '/api/auth/login', { userId: 'asha.rao', password: 'nope-nope-nope' })).status, i < 4 ? 401 : 401);
  const locked = await post(e, '/api/auth/login', { userId: 'asha.rao', password: ACCT.password });
  assert.equal(locked.status, 429);                                                                         // correct password is refused while locked
  assert.ok(locked.body.retryAfterSeconds > 0);
  await post(e, '/api/auth/logout', {}, t);
  assert.equal((await get(e, '/api/auth/me', t)).status, 401);
});

test('recovery needs name + email + DOB to all match; credential change ends sessions', async () => {
  const e = make(fakeNet());
  const t = await signedIn(e);
  const who = { name: 'asha  RAO', email: 'ASHA@example.com', dob: '1990-04-02' };
  assert.equal((await post(e, '/api/auth/forgot-user-id', who)).body.userId, 'asha.rao');                    // case/space-insensitive name and email
  assert.equal((await post(e, '/api/auth/forgot-user-id', { ...who, dob: '1990-04-03' })).status, 403);     // one field wrong
  const r = await post(e, '/api/auth/update-credentials', { ...who, newUserId: 'asha.new', newPassword: 'lotus-river-91q' });
  assert.deepEqual(r.body.changed, ['user ID', 'password']);
  assert.equal((await get(e, '/api/auth/me', t)).status, 401);
  assert.equal((await post(e, '/api/auth/login', { userId: 'asha.new', password: 'lotus-river-91q' })).status, 200);
  assert.equal((await post(e, '/api/auth/login', { userId: 'asha.rao', password: ACCT.password })).status, 401);
});

test('bootstrap through a flaky MCP server (half the calls 404), then extras and stock detail with analysis', async () => {
  const net = fakeNet(), e = make(net);
  const t = await signedIn(e);
  const b = await get(e, '/api/bootstrap', t);
  assert.equal(b.status, 200);
  assert.equal(b.body.stocks.length, 3);
  assert.equal(b.body.stale, false);
  assert.equal(b.body.stocks[0].sector, 'Information Technology');
  assert.ok(b.body.stocks[0].techSnap.label);
  assert.ok(net.calls.maxInflight <= 2, `max in flight was ${net.calls.maxInflight}`);                       // the 2-request cap holds
  const s = await get(e, '/api/stock/tcs', t);
  assert.equal(s.status, 200);
  assert.equal(s.body.sym, 'TCS');
  assert.ok(['Bullish', 'Bearish', 'Neutral'].includes(s.body.analysis.tech.label));
  assert.equal(s.body.divTtm, 20);
  assert.equal((await get(e, '/api/stock/bad%20sym!', t)).status, 400);
  const ex1 = await get(e, '/api/extras', t);
  assert.equal(ex1.body.ready, false);
  for (let i = 0; i < 100 && (await get(e, '/api/extras', t)).body.refreshing; i++) await new Promise((r) => setTimeout(r, 20));
  const ex = (await get(e, '/api/extras', t)).body;
  assert.equal(ex.ready, true);
  assert.equal(ex.data.TCS.tech.label.length > 0, true);
  assert.equal(ex.data.TCS.fund.label.length > 0, true);
  const found = (await get(e, '/api/search?q=tcs', t)).body;
  assert.ok(found.results.some((r) => r.symbol === 'TCS' && r.source === 'local'));
  assert.ok(found.results.some((r) => r.symbol === 'TCSELXSI' && r.source === 'nse'));                       // local + NSE merged, as in the desktop fix
});

test('NSE 403 opens the circuit breaker: later calls make no network request, saved snapshot is served as stale', async () => {
  const live = fakeNet(), storage = new MemoryStorage();
  const mk = (net) => createEngine({ storage, fetchFn: net.fetchFn, settings: { cmUrl: CM, bhavcopyUrl: BH, pbkdf2Iterations: 1000, universeSize: 3, refreshList: false, nseDelayMs: 0, feedDelayMs: 0 } });
  let e = mk(live);
  const t = await signedIn(e);
  assert.equal((await get(e, '/api/bootstrap', t)).body.stale, false);
  const blocked = fakeNet({ blockWith: 403 });
  e = mk(blocked);
  e.cache.clear();
  const first = await get(e, '/api/bootstrap', t);                       // answers at once from the saved copy...
  assert.equal(first.status, 200);
  assert.equal(first.body.stocks.length, 3);
  for (let i = 0; i < 100 && (await get(e, '/api/bootstrap', t)).body.refreshing; i++) await new Promise((r) => setTimeout(r, 10));   // ...while the refresh runs and is refused
  const b = await get(e, '/api/bootstrap', t);
  assert.equal(b.status, 200);
  assert.equal(b.body.stale, true);                                       // last good snapshot, flagged
  assert.match(b.body.staleReason, /HTTP 403/);
  await new Promise((r) => setTimeout(r, 30));                            // let requests that were already in flight when the block arrived finish
  const before = blocked.calls.post;
  e.cache.clear();
  const again = await get(e, '/api/bootstrap', t);
  assert.equal(again.body.stale, true);
  assert.equal(blocked.calls.post, before, 'no further requests while the breaker is open');
  assert.ok(b.body.retryInSeconds > 0 || again.body.retryInSeconds > 0);
  const log = (await get(e, '/api/audit', t)).body;
  assert.ok(log.entries.some((x) => x.event === 'upstream_blocked'));
  assert.equal(log.verify.ok, true);
  // a restarted app still honours the persisted breaker
  const restarted = mk(fakeNet());
  await restarted.nse.loadBreaker();
  assert.equal(restarted.nse.available(), false);
});

test('news: India/global split with sentiment, per-stock news, DOCTYPE feed rejected', async () => {
  const net = fakeNet(), e = make(net);
  const t = await signedIn(e);
  const r = (await get(e, '/api/news/india', t)).body;
  assert.equal(r.region, 'india');
  assert.ok(r.items.length >= 1 && r.items[0].sentiment > 0);
  assert.equal((await get(e, '/api/news/global', t)).body.region, 'global');
  await get(e, '/api/bootstrap', t);
  const sn = (await get(e, '/api/news/stock/TCS', t)).body;
  assert.equal(sn.sentiment.n >= 1, true);
  const evil = createEngine({ storage: new MemoryStorage(), settings: { pbkdf2Iterations: 1000, requireLogin: false, feedDelayMs: 0 },
    fetchFn: async () => new Response('<!DOCTYPE x [<!ENTITY a "bbbb">]><rss><channel><item><title>x</title><link>https://a.b</link></item></channel></rss>') });
  assert.equal((await evil.handle('GET', '/api/news/india')).status, 502);
});

test('option chain: import CSV, duplicate detection, rejection reasons, audit chain stays valid', async () => {
  const e = make(fakeNet());
  const t = await signedIn(e);
  const csv = ['OI,CHNG IN OI,VOLUME,IV,LTP,CHNG,BID,ASK,STRIKE,BID,ASK,CHNG,LTP,IV,VOLUME,CHNG IN OI,OI',
    '100,1,2,12,200,1,1,1,24400,1,1,1,50,13,5,1,300', '200,1,2,12,150,1,1,1,24500,1,1,1,100,13,5,1,250', '300,1,2,12,95,1,1,1,24600,1,1,1,150,13,5,1,150'].join('\n');
  const q = '/api/options/import?filename=option-chain-ED-NIFTY-27-Oct-2026.csv';
  const r1 = await post(e, q, csv, t, { ...H, 'content-type': 'text/csv' });
  assert.deepEqual([r1.status, r1.body.status], [200, 'stored']);
  assert.equal((await post(e, q, csv, t)).body.status, 'duplicate');
  const bad = await post(e, '/api/options/import?filename=x.csv', 'hello', t);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /STRIKE/);
  assert.equal((await post(e, q, csv, t, {})).status, 403);
  const chain = (await get(e, '/api/options?symbol=NIFTY', t)).body;
  assert.equal(chain.available, true);
  assert.equal(chain.expiry, '27-Oct-2026');
  assert.equal(chain.rows.length, 3);
  assert.equal(chain.summary.pcr, 1.167);   // puts 700 / calls 600
  assert.equal(chain.spotEstimated, true);
  assert.deepEqual((await get(e, '/api/options/meta', t)).body.symbols.slice(0, 2), ['NIFTY', 'BANKNIFTY']);
  const log = (await get(e, '/api/audit', t)).body;
  assert.deepEqual(log.entries.map((x) => x.event).filter((x) => x.startsWith('import')).reverse(), ['import_ok', 'import_duplicate', 'import_rejected']);
  assert.equal(log.verify.ok, true);
});

test('accounts keep each user separate: a second account sees its own session only', async () => {
  const e = make(fakeNet());
  const a = await signedIn(e);
  const b = (await post(e, '/api/auth/signup', { name: 'Ben Ray', email: 'ben@example.com', dob: '1985-01-01', userId: 'ben.ray', password: 'maple-comet-58z' })).setToken;
  assert.equal((await get(e, '/api/auth/me', a)).body.user.userId, 'asha.rao');
  assert.equal((await get(e, '/api/auth/me', b)).body.user.userId, 'ben.ray');
  assert.notEqual((await get(e, '/api/auth/me', a)).body.user.uid, (await get(e, '/api/auth/me', b)).body.user.uid);
});

test('sessions last 15 days regardless of use, then end; sign-out ends them at once', async () => {
  let t = 1_800_000_000_000;
  const e = createEngine({ storage: new MemoryStorage(), now: () => t, fetchFn: fakeNet().fetchFn, settings: { pbkdf2Iterations: 1000, refreshList: false, nseDelayMs: 0, feedDelayMs: 0 } });
  const token = (await post(e, '/api/auth/signup', ACCT)).setToken;
  const day = 24 * 3600 * 1000;
  t += 14 * day; assert.equal((await get(e, '/api/auth/me', token)).status, 200);        // app was closed for two weeks
  t += day - 3600 * 1000 * 2; assert.equal((await get(e, '/api/auth/me', token)).status, 200);
  t += 3 * 3600 * 1000; assert.equal((await get(e, '/api/auth/me', token)).status, 401); // past 15 days
  const t2 = (await post(e, '/api/auth/login', { userId: ACCT.userId, password: ACCT.password })).setToken;
  assert.equal((await get(e, '/api/auth/me', t2)).status, 200);
  await post(e, '/api/auth/logout', {}, t2);
  assert.equal((await get(e, '/api/auth/me', t2)).status, 401);
  assert.deepEqual((await get(e, '/api/auth/status', t2)).body.signedIn, false);
});

test('sector classification follows the current list even for data saved by an older release', async () => {
  const storage = new MemoryStorage();
  await storage.set('snap:bootstrap', { at: Date.now(), val: { asOf: '2026-10-23', fetchedAt: '2026-10-23T10:00:00', indices: [], valuation: [], sectorIndices: [], mood: {}, breadth: {},
    stocks: [{ sym: 'TCS', sector: 'IT', price: 100, prev: 99 }, { sym: 'RELIANCE', sector: 'Energy', price: 100, prev: 99 }, { sym: 'NOTINLIST', sector: 'IT', price: 5, prev: 5 }] } });
  const e = createEngine({ storage, fetchFn: async () => new Response('', { status: 500 }), optionSource: NOFILE, settings: { requireLogin: false, offline: true, pbkdf2Iterations: 1000 } });
  const s = (await e.handle('GET', '/api/bootstrap')).body.stocks;
  assert.deepEqual(s.map((x) => x.sector), ['Information Technology', 'Oil Gas & Consumable Fuels', 'Other']);
});
