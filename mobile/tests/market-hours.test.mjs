// Live during market hours, last update otherwise: the clock rules and the engine behaviour built on them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../engine/engine.js';
import { MemoryStorage } from '../engine/storage.js';
import { inSessionHours, lastSessionDate, marketState, ist } from '../engine/marketclock.js';
import { parseBhavcopy } from '../engine/bhavcopy.js';
import { readFileSync } from 'node:fs';

const at = (isoIst) => Date.parse(isoIst + '+05:30');           // write times the way an Indian user reads them

test('session hours: Mon-Fri 09:15 to 15:30 IST, edges exact', () => {
  assert.equal(inSessionHours(at('2026-10-26T09:14:59')), false);   // Monday
  assert.equal(inSessionHours(at('2026-10-26T09:15:00')), true);
  assert.equal(inSessionHours(at('2026-10-26T15:29:59')), true);
  assert.equal(inSessionHours(at('2026-10-26T15:30:00')), false);
  assert.equal(inSessionHours(at('2026-10-24T11:00:00')), false);   // Saturday
  assert.equal(inSessionHours(at('2026-10-25T11:00:00')), false);   // Sunday
  assert.equal(ist(Date.parse('2026-10-26T20:00:00Z')).date, '2026-10-27');   // 01:30 next day in India
});

test('the date the "last update" belongs to', () => {
  assert.equal(lastSessionDate(at('2026-10-26T08:00:00')), '2026-10-23');   // Monday before the open: Friday
  assert.equal(lastSessionDate(at('2026-10-26T10:00:00')), '2026-10-26');   // Monday during the session
  assert.equal(lastSessionDate(at('2026-10-26T18:00:00')), '2026-10-26');   // Monday after the close
  assert.equal(lastSessionDate(at('2026-10-25T12:00:00')), '2026-10-23');   // Sunday: Friday
  assert.equal(lastSessionDate(at('2026-10-24T12:00:00')), '2026-10-23');   // Saturday: Friday
});

test('market state: open, closed variants, and a holiday recognised from the data', () => {
  const today = { received: 20, newest: '2026-10-26 10:42:11' };
  assert.deepEqual(marketState(at('2026-10-26T10:45:00'), today), { open: true, live: true, label: 'Market open', session: '2026-10-26' });
  assert.match(marketState(at('2026-10-26T16:00:00'), today).label, /closed for the day/);
  assert.match(marketState(at('2026-10-26T08:00:00'), {}).label, /opens at 9:15/);
  assert.match(marketState(at('2026-10-26T09:05:00'), {}).label, /Pre-open/);
  assert.match(marketState(at('2026-10-24T11:00:00'), {}).label, /weekend/);
  // Diwali-style holiday on a weekday: hours say open, but quotes carry Friday's date
  const stale = { received: 40, newest: '2026-10-23 16:00:29' };
  assert.equal(marketState(at('2026-10-26T11:00:00'), stale).live, false);
  assert.match(marketState(at('2026-10-26T11:00:00'), stale).label, /No trading today/);
  assert.equal(marketState(at('2026-10-26T09:20:00'), stale).live, true);          // first minutes: give the first quotes time to arrive
  assert.equal(marketState(at('2026-10-26T11:00:00'), { received: 1, newest: '2026-10-23 16:00:29' }).live, true);   // too few quotes to conclude
});

/* ---------- engine: simulated trading ---------- */
const CM = 'https://mcp.test/cm', BH = 'https://mcp.test/bh', SYMS = ['AAA', 'BBB', 'CCC', 'DDD'];
function market({ price, day, hang = false }) {
  const s = { tools: {}, price: () => price.v };
  s.fetch = async (url, init = {}) => {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return new Response('{"jsonrpc":"2.0","id":1,"result":{}}', { headers: { 'Mcp-Session-Id': 's' } });
    if (b.method === 'notifications/initialized') return new Response('', { status: 404 });
    const name = b.params.name, a = b.params.arguments;
    s.tools[name] = (s.tools[name] || 0) + 1;
    let out;
    switch (name) {
      case 'get_top_by_volume': out = { stocks: SYMS.map((symbol) => ({ symbol, series: 'EQ', traded_value: 1e10 })) }; break;
      case 'get_bulk_quote': out = { quotes: a.symbols.map((symbol) => ({ symbol, close: 100, open: 99, high: 101, low: 98, prev_close: 99, volume: 10, date: '2026-10-23' })) }; break;
      case 'cm_get_stock_quote': out = { stock: { lastTradedPrice: price.v, preClosePrice: 100, openPrice: 100, highPrice: price.v, lowPrice: 99, volume: 1000, value: 12.5, fiftyTwoWeekHigh: 150, fiftyTwoWeekLow: 80, perChange30d: 3.3, latestTimestamp: `${day} 10:42:11` } }; break;
      case 'get_index_history': s.lastIndexArgs = a; out = { data: [{ date: '2026-10-22', open: 21900, high: 22100, low: 21800, close: 22000, volume: 5 }, { date: '2026-10-23', open: 22000, high: 22300, low: 21900, close: 22200, volume: 6 }], next_end_date: null }; break;
      case 'cm_get_live_indices': out = { indices: { derivatives: [{ indexName: 'NIFTY 50', last: price.v * 200, previousClose: 20000, percChange: 1 }] } }; break;
      default: out = { date: '2026-10-23' };
    }
    return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(out) }] } }) + '\n\n');
  };
  return s;
}
const mk = (srv, clock, storage = new MemoryStorage()) => createEngine({ storage, fetchFn: srv.fetch, optionSource: { fetchLatest: async () => parseBhavcopy(readFileSync(new URL('./fixtures/bhavcopy-sample.csv', import.meta.url), 'utf8')) },
  now: () => clock.t, settings: { cmUrl: CM, bhavcopyUrl: BH, requireLogin: false, universeSize: 4, refreshList: false, nseDelayMs: 0, feedDelayMs: 0 } });
const get = (e, p) => e.handle('GET', p).then((r) => r.body);
const settle = async (e) => { for (let i = 0; i < 200; i++) { if (!(await get(e, '/api/bootstrap')).refreshing) break; await new Promise((r) => setTimeout(r, 5)); } };

test('during the session prices come live and move on the next refresh; the banner state says open', async () => {
  const clock = { t: at('2026-10-26T10:45:00') }, price = { v: 105 }, srv = market({ price, day: '2026-10-26' }), e = mk(srv, clock);
  await get(e, '/api/bootstrap'); await settle(e);
  let b = await get(e, '/api/bootstrap');
  assert.equal(b.stocks[0].price, 105);                                  // live quote, not the end-of-day 100
  assert.equal(b.stocks[0].hi52, 150); assert.equal(b.stocks[0].pct30, 3.3);
  assert.deepEqual([b.market.open, b.market.live, b.market.label], [true, true, 'Market open']);
  assert.equal(srv.tools.cm_get_stock_quote, 4);
  price.v = 108; clock.t += 61_000;                                      // a minute later the cache has expired
  await get(e, '/api/bootstrap'); await settle(e);
  b = await get(e, '/api/bootstrap');
  assert.equal(b.stocks[0].price, 108);
  assert.equal(srv.tools.cm_get_stock_quote, 8);
});

test('inside the minute nothing is re-fetched; outside the session the refresh interval stretches to half an hour', async () => {
  const clock = { t: at('2026-10-26T10:45:00') }, price = { v: 105 }, srv = market({ price, day: '2026-10-26' }), e = mk(srv, clock);
  await get(e, '/api/bootstrap'); await settle(e);
  const n = srv.tools.get_top_by_volume;
  clock.t += 30_000; await get(e, '/api/bootstrap'); assert.equal(srv.tools.get_top_by_volume, n);
  clock.t = at('2026-10-26T16:00:00'); await settle(e);                  // market closed
  clock.t += 20 * 60_000; await get(e, '/api/bootstrap'); await settle(e);
  assert.equal(srv.tools.get_top_by_volume, n + 1, 'one refresh after the close, then none for 30 minutes');
  clock.t += 5 * 60_000; await get(e, '/api/bootstrap'); await settle(e);
  assert.equal(srv.tools.get_top_by_volume, n + 1);
});

test('after the close the last update of the day is fetched once, kept, and shown as closed', async () => {
  const storage = new MemoryStorage();
  // Monday 16:00: end-of-day bulk file still shows Friday; NSE's own quotes carry Monday's close
  const clock = { t: at('2026-10-26T16:00:00') }, price = { v: 111 }, srv = market({ price, day: '2026-10-26' }), e = mk(srv, clock, storage);
  await get(e, '/api/bootstrap'); await settle(e);
  const b = await get(e, '/api/bootstrap');
  assert.equal(b.stocks[0].price, 111, 'Monday close, not Friday bulk data');
  assert.equal(b.market.live, false); assert.match(b.market.label, /closed for the day/); assert.equal(b.market.session, '2026-10-26');
  const calls = srv.tools.cm_get_stock_quote;
  clock.t = at('2026-10-26T19:00:00'); e.cache.clear(); await get(e, '/api/bootstrap'); await settle(e);
  assert.equal(srv.tools.cm_get_stock_quote, calls, 'the catch-up is not repeated for the same day');
  // a later app start (new engine, same storage) answers from the saved last update with no live calls at all
  const srv2 = market({ price: { v: 999 }, day: '2026-10-26' }), e2 = mk(srv2, { t: at('2026-10-27T07:00:00') }, storage);
  const b2 = await get(e2, '/api/bootstrap');
  assert.equal(b2.stocks[0].price, 111); assert.match(b2.market.label, /opens at 9:15/);
});

test('weekday holiday: hours say open, NSE quotes carry the old date, so the app says there is no trading and does not claim Live', async () => {
  const clock = { t: at('2026-10-26T11:30:00') }, srv = market({ price: { v: 100 }, day: '2026-10-23' }), e = mk(srv, clock);
  await get(e, '/api/bootstrap'); await settle(e);
  const b = await get(e, '/api/bootstrap');
  assert.equal(b.market.live, false); assert.match(b.market.label, /No trading today/);
});

test('option chain: contracts stay from the last file, the spot and ATM row go live while the market trades', async () => {
  const clock = { t: at('2026-10-26T10:45:00') }, price = { v: 113 }, srv = market({ price, day: '2026-10-26' }), e = mk(srv, clock);
  await get(e, '/api/bootstrap'); await settle(e);
  const live = await get(e, '/api/options?symbol=NIFTY');                // NIFTY 50 live = 113 * 200 = 22,600
  assert.equal(live.spotLive, true); assert.equal(live.spot, 22600); assert.equal(live.meta.tradeDate, '2026-10-23');
  price.v = 112.5; clock.t += 61_000; e.cache.clear();
  const moved = await get(e, '/api/options?symbol=NIFTY');
  assert.equal(moved.spot, 22500); assert.equal(moved.summary.atm, 22500);   // ATM follows the live spot
  clock.t = at('2026-10-26T16:00:00');
  const closed = await get(e, '/api/options?symbol=NIFTY');
  assert.equal(closed.spotLive, undefined); assert.equal(closed.spot, 22600);   // file's own underlying price after the close
});

test('one-second feed: indices, sectors and the requested stocks, reused inside the second, refetched after it, recorded as intraday bars', async () => {
  const clock = { t: at('2026-10-26T10:45:00') }, price = { v: 105 }, srv = market({ price, day: '2026-10-26' }), e = mk(srv, clock);
  const live = await get(e, '/api/live?symbols=AAA,BBB,nope!');
  assert.equal(live.market.live, true); assert.equal(live.intervalMs, 1000);
  assert.deepEqual(live.indices.map((i) => i.name), ['NIFTY 50']); assert.equal(live.indices[0].last, 105 * 200);
  assert.deepEqual(live.quotes.map((q) => q.sym), ['AAA', 'BBB']); assert.equal(live.quotes[0].price, 105); assert.ok('open' in live.quotes[0] && 'high' in live.quotes[0]);
  assert.equal(srv.tools.cm_get_stock_quote, 2); assert.equal(srv.tools.cm_get_live_indices, 1);
  await get(e, '/api/live?symbols=AAA,BBB'); assert.equal(srv.tools.cm_get_stock_quote, 2, 'nothing is re-fetched inside the second');
  price.v = 107; clock.t += 1100;
  const again = await get(e, '/api/live?symbols=AAA,BBB'); assert.equal(again.quotes[0].price, 107); assert.equal(srv.tools.cm_get_stock_quote, 4); assert.equal(again.indices[0].last, 107 * 200);
  const id = await get(e, '/api/intraday/AAA'); assert.ok(id.bars.length >= 1); assert.equal(id.bars[id.bars.length - 1][4], 107); assert.match(id.source, /daily history only/);
  assert.equal((await e.handle('GET', '/api/intraday/!!')).status, 400);
});

test('one-second feed after the close: slow cadence, no hammering', async () => {
  const clock = { t: at('2026-10-26T16:30:00') }, srv = market({ price: { v: 105 }, day: '2026-10-26' }), e = mk(srv, clock);
  const r = await get(e, '/api/live?symbols=AAA'); assert.equal(r.market.live, false); assert.equal(r.intervalMs, 30000);
  clock.t += 5000; await get(e, '/api/live?symbols=AAA'); assert.equal(srv.tools.cm_get_stock_quote, 1, 'the market is shut: the answer is reused');
});

test('with many symbols on screen each is refreshed proportionally less often (a fixed budget of upstream calls)', async () => {
  const clock = { t: at('2026-10-26T10:45:00') }, srv = market({ price: { v: 105 }, day: '2026-10-26' }), e = mk(srv, clock);
  const syms = Array.from({ length: 30 }, (_, i) => `S${i}`).join(',');
  await get(e, `/api/live?symbols=${syms}`); assert.equal(srv.tools.cm_get_stock_quote, 30);
  clock.t += 1500; await get(e, `/api/live?symbols=${syms}`); assert.equal(srv.tools.cm_get_stock_quote, 30, '30 symbols at 10 calls a second: 3 s between refreshes');
  clock.t += 2000; await get(e, `/api/live?symbols=${syms}`); assert.equal(srv.tools.cm_get_stock_quote, 60);
});

test('indices can be charted: daily history by key, a live quote under the key, and intraday bars recorded from the feed', async () => {
  const clock = { t: at('2026-10-26T10:45:00') }, price = { v: 105 }, srv = market({ price, day: '2026-10-26' }), e = mk(srv, clock);
  const h = await get(e, '/api/history/IDX_NIFTY_50?range=1Y');
  assert.equal(h.available, true); assert.deepEqual(h.points[0], ['2026-10-22', 22000, 5, 21900, 22100, 21800]); assert.equal(srv.lastIndexArgs.indexName, 'NIFTY 50');
  const live = await get(e, '/api/live?symbols=IDX_NIFTY_50,AAA');
  const ix = live.quotes.find((q) => q.sym === 'IDX_NIFTY_50'); assert.equal(ix.price, 105 * 200); assert.equal(ix.prev, 20000); assert.equal(ix.status, 'live'); assert.ok(live.quotes.some((q) => q.sym === 'AAA'));
  await new Promise((r) => setTimeout(r, 20));
  const bars = (await get(e, '/api/intraday/IDX_NIFTY_50')).bars; assert.ok(bars.length >= 1 && bars[bars.length - 1][4] === 105 * 200);
  assert.ok((await get(e, '/api/intraday/IDX_NIFTY_BANK')).bars.length === 0, 'an index that is not in the mock feed has no bars');
});
