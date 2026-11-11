import test from 'node:test';
import assert from 'node:assert/strict';
import { economyTopics } from '../engine/analysis.js';
import { News } from '../engine/news.js';

const CASES = [
  ['RBI keeps repo rate unchanged at 5.5% - Wire', ['central_bank']],
  ['India GDP grows 7.8% in Q1 - Wire', ['growth']],
  ['HSBC India manufacturing PMI at 58.3 - Wire', ['pmi']],
  ['CAD widens as oil imports jump - Wire', ['external', 'trade']],
  ["India's CAS turns to surplus on current account - Wire", ['external']],
  ['GST collections hit record Rs 2 lakh crore - Wire', ['tax']],
  ['Retail inflation eases to 4.2% in October - Wire', ['inflation']],
  ['Exports rise 6% while trade deficit narrows - Wire', ['trade']],
];

test('headlines map to economy topics (same fixtures as tests/test_economy.py)', () => {
  for (const [t, want] of CASES) { const got = economyTopics(t); for (const w of want) assert.ok(got.includes(w), `${t}: ${got}`); }
});
test('non-economy headlines have no topics', () => {
  for (const t of ['Cad Smith joins Infosys board - Wire', 'Nifty gains as banks rally - Wire', 'Reliance shares jump on new launch - Wire']) assert.deepEqual(economyTopics(t), [], t);
});
test('economy region keeps only economy headlines', async () => {
  const rss = `<rss><channel><item><title>RBI cuts repo rate - Wire</title><link>https://e.example/1</link><pubDate>Wed, 07 Oct 2026 06:20:00 +0000</pubDate></item>
<item><title>Cad Smith joins board - Wire</title><link>https://e.example/2</link><pubDate>Wed, 07 Oct 2026 06:21:00 +0000</pubDate></item></channel></rss>`;
  const store = new Map();
  const cache = { cached: async (_k, _t, f) => f() };
  const snaps = { put: async (k, v) => store.set(k, v), get: async (k) => store.get(k), age: async () => 0 };
  const n = new News({ cache, snaps, delayMs: 0, fetchFn: async () => ({ ok: true, text: async () => rss }) });
  const out = await n.regionNews('economy');
  assert.equal(out.items.length, 1);
  assert.ok(out.items[0].title.startsWith('RBI'));
  assert.ok(out.items[0].topics.includes('central_bank'));
});
