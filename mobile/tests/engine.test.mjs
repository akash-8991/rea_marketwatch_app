// Run: node --test mobile/tests   (Node 22+, no dependencies)
// golden.json holds inputs and the outputs the PYTHON engine produced; the JavaScript port must reproduce them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as analysis from '../engine/analysis.js';
import * as options from '../engine/options.js';
import * as news from '../engine/news.js';
import * as market from '../engine/market.js';
import { Accounts } from '../engine/accounts.js';
import { MemoryStorage } from '../engine/storage.js';

const G = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url)));
const today = new Date(G.today + 'T00:00:00Z');
// JSON has no NaN/undefined: compare through a JSON round trip so null/undefined differences do not matter
const j = (x) => JSON.parse(JSON.stringify(x));

test('rules table is identical to the Python RULES', () => assert.deepEqual(j(analysis.RULES), G.rules));

test('technical analysis from history matches Python', () => {
  for (const [k, closes] of Object.entries(G.series)) assert.deepEqual(j(analysis.technicalFromHistory(closes)), G.tech[k], k);
  assert.deepEqual(j(analysis.technicalFromHistory(G.series.up, G.series.up.at(-1) * 0.9)), G.techPrice);
});

test('single-quote technical snapshot matches Python', () => {
  G.snapshots.forEach((s, i) => assert.deepEqual(j(analysis.technicalSnapshot(s)), G.snapOut[i], `case ${i}`));
});

test('fundamental / income profile matches Python', () => {
  const ctx = analysis.valuationContext({ valuation: [{ name: 'NIFTY 50', divYield: 1.3, pe: 22.1 }, { name: 'NIFTY BANK', pe: 14.2, pb: 2.1, divYield: 0.9 }] });
  assert.deepEqual(j(ctx), G.ctx);
  for (const [k, d, p, a, s] of G.fundCases) assert.deepEqual(j(analysis.fundamental(d, p, a, s, ctx, today)), G.fund[k], k);
});

test('headline sentiment scores, labels and aggregates match Python', () => {
  G.headlines.forEach((h, i) => {
    assert.deepEqual(j(analysis.headlineScore(h)), G.sent.scores[i], h);
    assert.equal(analysis.sentimentLabel(...analysis.headlineScore(h)), G.sent.labels[i], h);
  });
  assert.deepEqual(j(analysis.sentiment(G.headlines)), G.sent.agg_all);
  assert.deepEqual(j(analysis.sentiment([G.headlines[0], G.headlines[5], G.headlines[8]])), G.sent.agg_pos);
  assert.deepEqual(j(analysis.sentiment([])), G.sent.agg_none);
});

test('trailing-twelve-month dividend matches Python', () => assert.equal(market.ttmDividend(G.ttmActions, today), G.ttm));

test('option CSV parsing, summary, spot estimate and file-name guess match Python', () => {
  const p = options.parseCsv(G.csv, 'option-chain-ED-NIFTY-27-oct-2026.csv', null, null, 24510.0);
  assert.deepEqual(j(p), G.parsed);
  assert.deepEqual(j(options.summarize(p.rows, 24510.0)), G.summary);
  assert.equal(options.estimateSpot(p.rows), G.estSpot);
  ['option-chain-ED-NIFTY-27-Oct-2026.csv', 'option_chain_EQ_RELIANCE_3_nov_2026.csv', 'random.csv'].forEach((n, i) => assert.deepEqual(options.guessFromFilename(n), G.fnGuess[i], n));
});

test('rejected CSVs give the same reasons as Python', () => {
  assert.throws(() => options.parseCsv('a,b\n1,2', 'option-chain-NIFTY-1-Jan-2026.csv'), (e) => e.message === G.badCsv.no_header);
  assert.throws(() => options.parseCsv('CALLS,,STRIKE,PUTS\nOI,x,STRIKE,OI\n5,1,100,5', 'option-chain-NIFTY-1-Jan-2026.csv'), (e) => e.message === G.badCsv.few);
});

test('RSS parsing and merge match Python; DOCTYPE feeds are refused; javascript: links dropped', () => {
  assert.deepEqual(j(news.parseRss(G.rssYahoo, 'yahoo')), G.rss.yahoo);
  assert.deepEqual(j(news.parseRss(G.rssGoogle, 'google')), G.rss.google);
  assert.throws(() => news.parseRss('<!DOCTYPE x [<!ENTITY a "b">]><rss></rss>', 'yahoo'), (e) => e.message === G.rss.doctype);
  assert.deepEqual(j(news.merge([news.parseRss(G.rssYahoo, 'yahoo'), news.parseRss(G.rssGoogle, 'google')], 60)), G.merged);
});

test('audit chain written by Python verifies in JavaScript, and JavaScript rows extend it', async () => {
  const st = new MemoryStorage();
  await st.set('audit', G.auditRows);
  const store = new options.OptionStore(st);
  assert.deepEqual(await store.verifyAudit(), { ok: true, entries: 3, firstBadId: null });
  await store.audit('startup', 'system', 'from js', { channel: 'system' });
  assert.deepEqual(await store.verifyAudit(), { ok: true, entries: 4, firstBadId: null });
  const log = await st.get('audit');
  log[1].detail = 'tampered';
  await st.set('audit', log);
  assert.deepEqual(await store.verifyAudit(), { ok: false, entries: 4, firstBadId: log[1].id });
});

test('password hashes are interchangeable with Python (same PBKDF2-SHA256 format)', async () => {
  const acc = new Accounts(new MemoryStorage(), null, { iterations: 1000 });
  assert.equal(await acc.verifyPassword('correct horse battery', G.pwHash), true);
  assert.equal(await acc.verifyPassword('wrong horse battery', G.pwHash), false);
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
  assert.equal(await acc.hashPassword('correct horse battery', salt, 1000), G.pwHash);   // byte-identical to Python's output
});
