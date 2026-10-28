// Every NSE-listed equity: a new listing is found by search, has a stock page row, and shows in the New on NSE list, without waiting for an index change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Securities, parseListed, ListError, LISTED_SOURCE, UNCLASSIFIED } from '../engine/securities.js';
import { MemoryStorage } from '../engine/storage.js';

const HEAD = 'SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE\n';
const csv = (extra = []) => HEAD + [...Array.from({ length: 1600 }, (_, i) => `OLD${String(i).padStart(4, '0')},Old Company ${i} Limited,EQ,01-JAN-2010,10,1,INE${String(i).padStart(9, '0')},10`), ...extra].join('\n') + '\n';
const NOW = Date.parse('2026-10-28T10:00:00Z');
const mk = (respond, storage = new MemoryStorage()) => { const asked = [], audit = []; const sec = new Securities({ storage, now: () => NOW, fetchText: async (u) => { asked.push(u); const r = respond(u); if (r instanceof Error) throw r; return r; }, audit: async (...a) => { audit.push(a); } }); return { sec, asked, audit, storage }; };

test('NSE\'s list parses with listing dates and refuses unusable files', () => {
  const m = parseListed(csv(['NEWCO,Newco Technologies Limited,EQ,27-OCT-2026,10,1,INE999Z01012,10']));
  assert.equal(m.size, 1601); assert.deepEqual(m.get('NEWCO'), { company: 'Newco Technologies Limited', series: 'EQ', listed: '2026-10-27', isin: 'INE999Z01012', lot: 1 });
  for (const bad of ['', 'SYMBOL,X\nA,B\n', HEAD + 'ABC,Abc Ltd,EQ,01-JAN-2020,10,1,INE000000001,10\n']) assert.throws(() => parseListed(bad), ListError);
});

test('a new listing appears in search, stock pages and the new-listings list; failures change nothing; the list survives a restart', async () => {
  const { sec, asked, audit, storage } = mk(() => csv(['NEWCO,Newco Technologies Limited,EQ,27-OCT-2026,10,1,INE999Z01012,10', 'SOONCO,Soonco Limited,EQ,30-OCT-2026,10,1,INE999Z01020,10']));
  await sec.load(); assert.equal(sec.get('NEWCO'), null, 'unknown before the download');
  const r = await sec.refreshListed(); assert.deepEqual(asked, [LISTED_SOURCE]); assert.ok(r.added.includes('NEWCO')); assert.equal(audit[0][0], 'securities_updated');
  const row = sec.get('newco'); assert.equal(row.company, 'Newco Technologies Limited'); assert.equal(row.industry, UNCLASSIFIED); assert.equal(row.inIndex, false);
  assert.equal(sec.searchSymbols('newc')[0].symbol, 'NEWCO'); assert.equal(sec.searchNames('Newco Technologies')[0].symbol, 'NEWCO');
  const recent = sec.newListings(30); assert.deepEqual(recent.slice(0, 2).map((x) => x.symbol), ['SOONCO', 'NEWCO']); assert.deepEqual(recent.slice(0, 2).map((x) => x.upcoming), [true, false]);
  assert.deepEqual(await sec.refreshListed(), { skipped: 'checked within the last 6 hours' }); assert.equal(asked.length, 1);
  const again = mk(() => new Error('down'), storage); await again.sec.load(); assert.ok(again.sec.get('NEWCO'), 'read back from storage with no network');
  const failed = await again.sec.refreshListed({ force: true }); assert.match(failed.skipped, /download failed/); assert.ok(again.sec.get('NEWCO'), 'a failed download changes nothing'); assert.equal(again.audit[0][2], 'error');
});

test('the engine serves /api/listings and finds a new listing through search', async () => {
  const { createEngine } = await import('../engine/engine.js');
  const e = createEngine({ storage: new MemoryStorage(), fetchFn: async () => { throw new Error('no network'); }, now: () => NOW, settings: { requireLogin: false, refreshList: false, offline: false, nseDelayMs: 0, feedDelayMs: 0 } });
  e.securities.listed = parseListed(csv(['NEWCO,Newco Technologies Limited,EQ,27-OCT-2026,10,1,INE999Z01012,10'])); e.securities.listedMeta = { updated: NOW };
  const l = (await e.handle('GET', '/api/listings?days=30')).body; assert.equal(l.recent[0].symbol, 'NEWCO'); assert.equal(l.total, 1601);
  const s = (await e.handle('GET', '/api/search?q=newco')).body; assert.equal(s.results[0].symbol, 'NEWCO'); assert.equal(s.results[0].source, 'listed');
  const p = (await e.handle('GET', '/api/peers/NEWCO')).body; assert.equal(p.unclassified, true);
});
