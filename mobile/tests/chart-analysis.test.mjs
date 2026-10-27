// Chart analysis maths, the one-second feed and the intraday recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ta from '../../src/marketlens/static/js/ta.js';
import { applyFeed } from '../../src/marketlens/static/js/pure.js';
import { Ticks } from '../engine/ticks.js';
import { MemoryStorage, Snapshots } from '../engine/storage.js';

const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const trend = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i), o = i ? f(i - 1) : c; return { t: day(i), o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v: 1000 + i }; });
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);

test('daily points become candles; weekly, monthly and yearly candles keep first open, high, low, last close and summed volume', () => {
  const pts = [['2025-01-06', 10, 100, 9, 11, 8], ['2025-01-07', 12, 200, 10, 13, 9], ['2025-01-14', 11, 50, 12, 12, 10], ['2025-02-03', 15, 70, 11, 16, 10], ['2026-01-02', 20, 5, 15, 21, 14]];
  const d = ta.dailyCandles(pts); assert.equal(d.length, 5);
  const w = ta.resampleDaily(d, 'W'); assert.equal(w.length, 4); assert.deepEqual([w[0].o, w[0].h, w[0].l, w[0].c, w[0].v], [9, 13, 8, 12, 300]);
  const m = ta.resampleDaily(d, 'M'); assert.equal(m.length, 3); assert.equal(m[0].c, 11); assert.equal(m[0].v, 350);
  const y = ta.resampleDaily(d, 'Y'); assert.equal(y.length, 2); assert.equal(y[0].h, 16); assert.equal(y[1].c, 20);
});

test('minute bars become 5, 15 and 60 minute candles anchored at the 9:15 open (India time)', () => {
  const base = Date.parse('2026-10-26T09:15:00+05:30') / 1000, bars = [];
  for (let m = 0; m < 75; m++) bars.push([base + m * 60, 100 + m, 101 + m, 99 + m, 100.5 + m, 10]);
  const c5 = ta.resampleIntraday(bars, 5); assert.equal(c5.length, 15); assert.equal(c5[0].t, base); assert.equal(c5[0].o, 100); assert.equal(c5[0].c, 104.5); assert.equal(c5[0].v, 50); assert.equal(c5[0].h, 105);
  assert.equal(ta.resampleIntraday(bars, 15).length, 5); assert.equal(ta.resampleIntraday(bars, 60).length, 2);
  const two = [...bars, [base + 86400 + 60, 1, 2, 1, 2, 1]]; assert.equal(ta.resampleIntraday(two, 60).length, 3, 'a new day starts a new candle');
});

test('a live tick folds into the current candle and opens a new one when the period has passed', () => {
  const t0 = Date.parse('2026-10-26T10:00:00+05:30') / 1000, cs = [{ t: t0, o: 100, h: 101, l: 99, c: 100, v: 5 }];
  const a = ta.applyTick(cs, 102, t0 + 120, '5m'); assert.equal(a.length, 1); assert.equal(a[0].h, 102); assert.equal(a[0].c, 102);
  const b = ta.applyTick(cs, 98, t0 + 400, '5m'); assert.equal(b.length, 2); assert.equal(b[1].o, 100); assert.equal(b[1].l, 98);
  assert.equal(cs[0].c, 100, 'the input is not mutated');
});

test('indicators match hand calculations and are null until warmed up', () => {
  const cs = trend(60, (i) => 100 + i);
  const ind = ta.indicators(cs); assert.equal(ind.sma20[18], null); near(ind.sma20[19], 109.5); assert.ok(ind.rsi[59] > 99); assert.ok(ind.macd.line[59] > 0);
  const a = ta.atr(cs, 14); assert.ok(a[12] === null && a[13] > 0 && a[59] > 0);
  const x = ta.adx(cs, 14); assert.ok(x.adx[59] > 50 && x.plus[59] > x.minus[59], 'a straight rise is a strong up trend');
  const st = ta.supertrend(cs, 10, 3); assert.equal(st.dir[59], 1); assert.ok(st.line[59] < cs[59].c);
  const k = ta.stochastic(cs, 14, 3, 3); assert.ok(k.k[59] > 80);
  const down = ta.indicators(trend(60, (i) => 200 - i)); assert.ok(down.rsi[59] < 1); assert.equal(ta.supertrend(trend(60, (i) => 200 - i)).dir[59], -1);
});

test('VWAP restarts each day and is null without volume', () => {
  const t0 = Date.parse('2026-10-26T09:15:00+05:30') / 1000, cs = [{ t: t0, o: 10, h: 12, l: 8, c: 10, v: 100 }, { t: t0 + 300, o: 10, h: 14, l: 10, c: 12, v: 100 }, { t: t0 + 86400, o: 20, h: 22, l: 18, c: 20, v: 50 }];
  const v = ta.vwap(cs); near(v[0], 10); near(v[1], ((10 + 10) / 2 * 0 + (30 / 3) * 100 + (36 / 3) * 100) / 200); near(v[2], 20);
  assert.equal(ta.vwap([{ t: t0, o: 1, h: 1, l: 1, c: 1, v: 0 }])[0], null);
});

test('pivot points and Fibonacci levels follow their formulas', () => {
  const p = ta.pivots({ h: 110, l: 90, c: 100 }); near(p.P, 100); near(p.R1, 110); near(p.S1, 90); near(p.R2, 120); near(p.S2, 80); near(p.R3, 130); near(p.S3, 70);
  const cs = trend(80, (i) => (i < 40 ? 100 + i : 140 - (i - 40) * 0.5)); cs[40].h = 150; cs[10].l = 90;
  const f = ta.fibonacci(cs); assert.ok(f && f.levels.length === 7); near(f.levels[0].price + f.levels[6].price, f.high + f.low);
});

test('support and resistance cluster repeated turning points', () => {
  const cs = []; for (let i = 0; i < 80; i++) { const wave = 100 + 10 * Math.sin(i / 3); cs.push({ t: day(i), o: wave, h: wave + 1, l: wave - 1, c: wave, v: 1 }); }
  const lv = ta.supportResistance(cs); assert.ok(lv.support.length && lv.resistance.length); assert.ok(lv.resistance[0].touches >= 2);
});

test('candlestick patterns: hammer after a fall, bullish engulfing, doji, shooting star after a rise', () => {
  const fall = trend(10, (i) => 120 - i * 2), mk = (o, h, l, c) => ({ t: 'x', o, h, l, c, v: 1 });
  const hammer = ta.candlePatterns([...fall, mk(100, 102, 92, 102)]); assert.ok(hammer.some((p) => p.name === 'Hammer' && p.bias === 'bullish'), JSON.stringify(hammer.map((p) => p.name)));
  const eng = ta.candlePatterns([...fall, mk(104, 105, 99, 100), mk(98, 108, 97, 107)]); assert.ok(eng.some((p) => p.name === 'Bullish engulfing'));
  assert.ok(ta.candlePatterns([...fall, mk(100, 105, 95, 100.2)]).some((p) => p.name === 'Doji'));
  const rise = trend(10, (i) => 100 + i * 2); assert.ok(ta.candlePatterns([...rise, mk(120, 131, 119, 122)]).some((p) => p.name === 'Shooting star' && p.bias === 'bearish'));
});

test('the read: an up trend reads bullish, a down trend bearish, with reasons for each signal; too little data is said plainly', () => {
  const up = ta.analyse(trend(260, (i) => 100 + i * 0.8 + Math.sin(i / 5) * 2), undefined, '1D'), dn = ta.analyse(trend(260, (i) => 300 - i * 0.8 + Math.sin(i / 5) * 2), undefined, '1D');
  assert.ok(up.ok && up.score > 0.4 && /bullish/i.test(up.verdict)); assert.ok(dn.ok && dn.score < -0.4 && /bearish/i.test(dn.verdict));
  assert.ok(up.signals.length >= 8 && up.signals.every((s) => s.text && s.name && s.group)); assert.ok(up.enough.sma200);
  assert.equal(ta.analyse(trend(2, (i) => 100 + i)).ok, false);
  assert.ok(!ta.analyse(trend(40, (i) => 100 + i)).enough.sma200);
});

test('candlesFor picks the right source for each timeframe', () => {
  const bars = Array.from({ length: 30 }, (_, i) => [Date.parse('2026-10-26T09:15:00+05:30') / 1000 + i * 60, 1, 2, 1, 2, 1]);
  const pts = Array.from({ length: 30 }, (_, i) => [day(i), 10 + i, 5, 10, 12, 9]);
  assert.equal(ta.candlesFor('5m', { minuteBars: bars, dailyPoints: pts }).length, 6); assert.equal(ta.candlesFor('1D', { minuteBars: bars, dailyPoints: pts }).length, 30);
  assert.ok(ta.candlesFor('1W', { dailyPoints: pts }).length < 8); assert.equal(ta.candlesFor('1Y', { dailyPoints: pts }).length, 1);
  assert.equal(ta.TIMEFRAMES.map((t) => t[0]).join(), '5m,15m,1h,1D,1W,1M,1Y');
});

test('the feed answer is written into the shared data and reports what changed', () => {
  const D = { indices: [{ name: 'NIFTY 50', last: 100, prev: 99 }], sectorIdx: [{ sector: 'Banks', pct: 0.1 }], market: null }, a = { sym: 'AAA', price: 10, prev: 9 }, bySym = { AAA: a };
  const r = { market: { live: true }, indices: [{ name: 'Nifty 50', last: 101, prev: 99 }], sectorIndices: [{ sector: 'Banks', pct: 0.4 }], quotes: [{ sym: 'AAA', price: 11, prev: 9, volume: 5, status: 'live' }, { sym: 'ZZZ', price: 1 }, { sym: 'AAA', price: 0 }] };
  assert.ok(applyFeed(D, bySym, r) >= 4); assert.equal(D.indices[0].last, 101); assert.equal(D.sectorIdx[0].pct, 0.4); assert.equal(a.price, 11); assert.equal(D.market.live, true);
  assert.equal(applyFeed(D, bySym, r), 0, 'the same answer again changes nothing');
});

test('the recorder folds ticks into one-minute bars, ignores repeats, survives a restart and keeps volume as a difference', async () => {
  const st = new MemoryStorage(), snaps = new Snapshots(st, () => Date.now()), clock = { t: Date.parse('2026-10-26T10:00:30+05:30') };
  const k = new Ticks({ snaps, now: () => clock.t });
  assert.ok(await k.record('AAA', 100, 1000, '2026-10-26 10:00:05')); assert.ok(await k.record('AAA', 103, 1500, '2026-10-26 10:00:40')); assert.ok(await k.record('AAA', 99, 1600, '2026-10-26 10:00:50'));
  assert.equal(await k.record('AAA', 99, 1600, '2026-10-26 10:00:50'), false, 'an unchanged repeat');
  assert.ok(await k.record('AAA', 101, 1700, '2026-10-26 10:01:10')); assert.equal(await k.record('AAA', 0, 1, '2026-10-26 10:02:00'), false);
  const bars = await k.bars('AAA'); assert.equal(bars.length, 2); assert.deepEqual(bars[0].slice(1), [100, 103, 99, 99, 600]); assert.deepEqual(bars[1].slice(1), [101, 101, 101, 101, 100]);
  assert.equal(bars[0][0], Date.parse('2026-10-26T10:00:00+05:30') / 1000);
  await k.flushAll(); const k2 = new Ticks({ snaps, now: () => clock.t }); assert.deepEqual(await k2.bars('AAA'), bars);
});
