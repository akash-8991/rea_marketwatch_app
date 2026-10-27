/* Technical analysis on candles, in pure functions (no DOM, no network). A candle is {t, o, h, l, c, v}: t is epoch seconds for intraday candles and 'YYYY-MM-DD'
 * for daily and longer ones. Every indicator returns an array the same length as the candles, with null while there is not enough history.
 * The chart page (chart-view.js) draws these; analyse() turns them into the plain-language read of the chart. */
import { sma, ema, rsi, macd, bollinger } from './indicators.js';

export const TIMEFRAMES = [['5m', '5 min', 5], ['15m', '15 min', 15], ['1h', 'Hourly', 60], ['1D', 'Daily', 0], ['1W', 'Weekly', 0], ['1M', 'Monthly', 0], ['1Y', 'Yearly', 0]];
export const INTRADAY = new Set(['5m', '15m', '1h']);
const IST_MS = 5.5 * 3600 * 1000, OPEN_MIN = 9 * 60 + 15;
const num = (x) => (x == null || Number.isNaN(x) ? null : x);

/* ---------- building candles ---------- */
/** One-minute bars [[epoch s, o, h, l, c, v], ...] to candles of `minutes`, anchored at the 9:15 open each day. */
export function resampleIntraday(bars, minutes) {
  const out = []; let cur = null, key = null;
  for (const [t, o, h, l, c, v] of bars) {
    const ist = new Date(t * 1000 + IST_MS), day = ist.toISOString().slice(0, 10), mod = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const slot = Math.max(0, Math.floor((mod - OPEN_MIN) / minutes)), k = `${day}|${slot}`;
    if (k !== key) { if (cur) out.push(cur); key = k; const start = Date.parse(day + 'T00:00:00Z') / 1000 - IST_MS / 1000 + (OPEN_MIN + slot * minutes) * 60; cur = { t: start, o, h, l, c, v: v || 0 }; }
    else { cur.h = Math.max(cur.h, h); cur.l = Math.min(cur.l, l); cur.c = c; cur.v += v || 0; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Daily points [date, close, volume, open, high, low] to candles. A missing open, high or low falls back to the close (then the candle is a flat line). */
export const dailyCandles = (points) => points.filter((p) => p[1]).map((p) => ({ t: p[0], o: p[3] ?? p[1], h: p[4] ?? p[1], l: p[5] ?? p[1], c: p[1], v: p[2] || 0 }));

const weekKey = (d) => { const x = new Date(d + 'T00:00:00Z'), dow = (x.getUTCDay() + 6) % 7; return new Date(x.getTime() - dow * 86400000).toISOString().slice(0, 10); };
/** Daily candles to weekly (Monday-started), monthly or yearly candles. */
export function resampleDaily(candles, unit) {
  const keyOf = { W: (d) => weekKey(d), M: (d) => d.slice(0, 7), Y: (d) => d.slice(0, 4) }[unit];
  const out = []; let cur = null, key = null;
  for (const c of candles) {
    const k = keyOf(c.t);
    if (k !== key) { if (cur) out.push(cur); key = k; cur = { t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v }; }
    else { cur.h = Math.max(cur.h, c.h); cur.l = Math.min(cur.l, c.l); cur.c = c.c; cur.v += c.v; cur.t = cur.t; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Candles for a timeframe from the two data sources. */
export function candlesFor(tf, { minuteBars = [], dailyPoints = [] }) {
  if (INTRADAY.has(tf)) return resampleIntraday(minuteBars, { '5m': 5, '15m': 15, '1h': 60 }[tf]);
  const d = dailyCandles(dailyPoints);
  return tf === '1D' ? d : resampleDaily(d, { '1W': 'W', '1M': 'M', '1Y': 'Y' }[tf]);
}

/** The newest live price folded into the last candle (or into a new one if the period has moved on): the chart moves between data loads. */
export function applyTick(candles, price, nowSec, tf) {
  if (!candles.length || !(price > 0)) return candles;
  const last = candles[candles.length - 1];
  if (INTRADAY.has(tf)) {
    const minutes = { '5m': 5, '15m': 15, '1h': 60 }[tf], sameSlot = nowSec >= last.t && nowSec < last.t + minutes * 60;
    if (sameSlot) { const n = candles.slice(0, -1); n.push({ ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price }); return n; }
    if (nowSec >= last.t + minutes * 60) { const ist = new Date(nowSec * 1000 + IST_MS), mod = ist.getUTCHours() * 60 + ist.getUTCMinutes(), slot = Math.floor((mod - OPEN_MIN) / minutes); if (slot < 0) return candles; const day = ist.toISOString().slice(0, 10), start = Date.parse(day + 'T00:00:00Z') / 1000 - IST_MS / 1000 + (OPEN_MIN + slot * minutes) * 60; return [...candles, { t: start, o: last.c, h: Math.max(last.c, price), l: Math.min(last.c, price), c: price, v: 0 }]; }
    return candles;
  }
  const n = candles.slice(0, -1); n.push({ ...last, h: Math.max(last.h, price), l: Math.min(last.l, price), c: price }); return n;
}

/* ---------- indicators on OHLC ---------- */
const rma = (v, n) => { const out = v.map(() => null); let s = 0, cnt = 0, prev = null; for (let i = 0; i < v.length; i++) { if (v[i] == null) continue; if (prev == null) { s += v[i]; cnt++; if (cnt === n) { prev = s / n; out[i] = prev; } } else { prev = (prev * (n - 1) + v[i]) / n; out[i] = prev; } } return out; };

export const trueRange = (cs) => cs.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - cs[i - 1].c), Math.abs(c.l - cs[i - 1].c))));
export const atr = (cs, n = 14) => rma(trueRange(cs), n);

/** Wilder's ADX with the two directional indicators. */
export function adx(cs, n = 14) {
  const up = [0], dn = [0];
  for (let i = 1; i < cs.length; i++) { const u = cs[i].h - cs[i - 1].h, d = cs[i - 1].l - cs[i].l; up.push(u > d && u > 0 ? u : 0); dn.push(d > u && d > 0 ? d : 0); }
  const tr = rma(trueRange(cs), n), pu = rma(up, n), pd = rma(dn, n);
  const plus = tr.map((t, i) => (t ? (100 * pu[i]) / t : null)), minus = tr.map((t, i) => (t ? (100 * pd[i]) / t : null));
  const dx = plus.map((p, i) => (p == null || minus[i] == null || p + minus[i] === 0 ? null : (100 * Math.abs(p - minus[i])) / (p + minus[i])));
  return { adx: rma(dx, n), plus, minus };
}

/** Stochastic oscillator: %K smoothed over `k` bars, %D smoothed over `d` bars. */
export function stochastic(cs, n = 14, k = 3, d = 3) {
  const raw = cs.map((c, i) => { if (i + 1 < n) return null; const w = cs.slice(i + 1 - n, i + 1), hh = Math.max(...w.map((x) => x.h)), ll = Math.min(...w.map((x) => x.l)); return hh === ll ? 50 : ((c.c - ll) / (hh - ll)) * 100; });
  const smooth = (a, m) => a.map((_, i) => { const w = a.slice(Math.max(0, i + 1 - m), i + 1); return w.length === m && w.every((x) => x != null) ? w.reduce((x, y) => x + y, 0) / m : null; });
  const kk = smooth(raw, k); return { k: kk, d: smooth(kk, d) };
}

/** Supertrend: a trailing stop built from ATR. dir 1 = up trend (line under price), -1 = down trend (line over price). */
export function supertrend(cs, n = 10, mult = 3) {
  const a = atr(cs, n), line = cs.map(() => null), dir = cs.map(() => 0); let fu = null, fl = null, d = 1;
  for (let i = 0; i < cs.length; i++) {
    if (a[i] == null) continue;
    const mid = (cs[i].h + cs[i].l) / 2, bu = mid + mult * a[i], bl = mid - mult * a[i];
    fu = fu == null || bu < fu || cs[i - 1].c > fu ? bu : fu; fl = fl == null || bl > fl || cs[i - 1].c < fl ? bl : fl;
    if (d === 1 && cs[i].c < fl) d = -1; else if (d === -1 && cs[i].c > fu) d = 1;
    line[i] = d === 1 ? fl : fu; dir[i] = d;
  }
  return { line, dir };
}

/** Volume-weighted average price, restarting each trading day (intraday candles only). Null when there is no volume. */
export function vwap(cs) {
  let day = null, pv = 0, vv = 0;
  if (cs.length && typeof cs[0].t !== 'number') return cs.map(() => null);   // daily and longer candles carry dates, not times
  return cs.map((c) => { const d = new Date(c.t * 1000 + IST_MS).toISOString().slice(0, 10); if (d !== day) { day = d; pv = vv = 0; } pv += ((c.h + c.l + c.c) / 3) * c.v; vv += c.v; return vv ? pv / vv : null; });
}

export const obv = (cs) => { let o = 0; return cs.map((c, i) => { if (i) o += c.c > cs[i - 1].c ? c.v : c.c < cs[i - 1].c ? -c.v : 0; return o; }); };

/** Everything the chart can draw or the read can quote, computed once per candle set. */
export function indicators(cs) {
  const c = cs.map((x) => x.c), m = macd(c, 12, 26, 9), bb = bollinger(c, 20, 2);
  return { sma20: sma(c, 20), sma50: sma(c, 50), sma200: sma(c, 200), ema9: ema(c, 9).map((v, i) => (i < 8 ? null : v)), ema21: ema(c, 21).map((v, i) => (i < 20 ? null : v)),
    bb, rsi: rsi(c, 14), macd: m, atr: atr(cs, 14), adx: adx(cs, 14), stoch: stochastic(cs, 14, 3, 3), st: supertrend(cs, 10, 3), obv: obv(cs), vwap: vwap(cs) };
}

/* ---------- levels ---------- */
/** Swing highs and lows: a bar whose high (low) is the highest (lowest) of `k` bars either side. */
export function swings(cs, k = 3) {
  const hi = [], lo = [];
  for (let i = k; i < cs.length - k; i++) {
    const w = cs.slice(i - k, i + k + 1);
    if (cs[i].h === Math.max(...w.map((x) => x.h))) hi.push(i);
    if (cs[i].l === Math.min(...w.map((x) => x.l))) lo.push(i);
  }
  return { hi, lo };
}

/** Support and resistance: swing points within `tol` of each other are one level, ranked by how often price turned there. */
export function supportResistance(cs, k = 3, tol = 0.006) {
  if (cs.length < 2 * k + 3) return { support: [], resistance: [] };
  const sw = swings(cs, k), pts = [...sw.hi.map((i) => ({ p: cs[i].h, i })), ...sw.lo.map((i) => ({ p: cs[i].l, i }))].sort((a, b) => a.p - b.p), groups = [];
  for (const x of pts) { const g = groups[groups.length - 1]; if (g && x.p <= g.p * (1 + tol)) { g.n++; g.sum += x.p; g.p = g.sum / g.n; g.last = Math.max(g.last, x.i); } else groups.push({ p: x.p, sum: x.p, n: 1, last: x.i }); }
  const price = cs[cs.length - 1].c, lv = groups.map((g) => ({ price: g.p, touches: g.n, last: g.last }));
  const score = (l) => l.touches * 2 + l.last / cs.length;   // more touches and more recent first
  return { support: lv.filter((l) => l.price < price).sort((a, b) => score(b) - score(a)).slice(0, 3).sort((a, b) => b.price - a.price), resistance: lv.filter((l) => l.price > price).sort((a, b) => score(b) - score(a)).slice(0, 3).sort((a, b) => a.price - b.price) };
}

/** Classic floor-trader pivot points from the previous candle's high, low and close. */
export function pivots(prev) {
  if (!prev) return null;
  const { h, l, c } = prev, p = (h + l + c) / 3;
  return { P: p, R1: 2 * p - l, S1: 2 * p - h, R2: p + (h - l), S2: p - (h - l), R3: h + 2 * (p - l), S3: l - 2 * (h - p) };
}

/** Fibonacci retracement of the latest swing: from the last swing low to the last swing high (or the reverse), with the usual ratios. */
export function fibonacci(cs, k = 3) {
  const sw = swings(cs, k), h = sw.hi[sw.hi.length - 1], l = sw.lo[sw.lo.length - 1];
  if (h == null || l == null) return null;
  const up = l < h, a = up ? cs[l].l : cs[l].l, b = cs[h].h, hi = b, lo = a;
  if (hi <= lo) return null;
  const R = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  return { direction: up ? 'up' : 'down', high: hi, low: lo, levels: R.map((r) => ({ ratio: r, price: up ? hi - (hi - lo) * r : lo + (hi - lo) * r })) };
}

/* ---------- patterns ---------- */
/** Candlestick patterns ending at the last candle (and a few steps back), with the trend before them as context. */
export function candlePatterns(cs, lookback = 3) {
  const out = [], n = cs.length;
  const geo = (c) => { const body = Math.abs(c.c - c.o), range = c.h - c.l || 1e-9; return { body, range, up: c.h - Math.max(c.o, c.c), dn: Math.min(c.o, c.c) - c.l, bull: c.c > c.o, bear: c.c < c.o }; };
  for (let i = Math.max(2, n - lookback); i < n; i++) {
    const c = cs[i], g = geo(c), p = cs[i - 1], pg = geo(p), pp = cs[i - 2], ppg = geo(pp), age = n - 1 - i;
    const drift = i >= 6 ? (cs[i - 1].c - cs[i - 6].c) / cs[i - 6].c : 0, down = drift < -0.01, upTr = drift > 0.01, add = (name, bias, text) => out.push({ name, bias, age, text, at: i });
    if (g.body <= 0.1 * g.range) add('Doji', 'neutral', 'Open and close are almost equal: buyers and sellers are balanced, and a turn is possible after a long move.');
    else if (g.dn >= 2 * g.body && g.up <= 0.35 * g.body + 0.05 * g.range && g.body > 0.1 * g.range) add(down ? 'Hammer' : upTr ? 'Hanging man' : 'Long lower shadow', down ? 'bullish' : upTr ? 'bearish' : 'neutral', down ? 'A long lower shadow after a fall: sellers pushed down but buyers took it back. A possible bottom.' : upTr ? 'A long lower shadow after a rise: a warning that selling is appearing.' : 'Price was rejected from lower levels.');
    else if (g.up >= 2 * g.body && g.dn <= 0.35 * g.body + 0.05 * g.range && g.body > 0.1 * g.range) add(upTr ? 'Shooting star' : down ? 'Inverted hammer' : 'Long upper shadow', upTr ? 'bearish' : down ? 'bullish' : 'neutral', upTr ? 'A long upper shadow after a rise: buyers pushed up but sellers took it back. A possible top.' : down ? 'A long upper shadow after a fall: early sign that buyers are testing higher prices.' : 'Price was rejected from higher levels.');
    if (g.body >= 0.9 * g.range && g.body > 0) add(g.bull ? 'Bullish marubozu' : 'Bearish marubozu', g.bull ? 'bullish' : 'bearish', g.bull ? 'A full-bodied rising candle with no shadows: buyers controlled the whole period.' : 'A full-bodied falling candle with no shadows: sellers controlled the whole period.');
    if (g.bull && pg.bear && c.c >= p.o && c.o <= p.c && g.body > pg.body) add('Bullish engulfing', 'bullish', 'A rising candle swallows the previous falling one: buyers have taken over' + (down ? ' after a decline.' : '.'));
    if (g.bear && pg.bull && c.o >= p.c && c.c <= p.o && g.body > pg.body) add('Bearish engulfing', 'bearish', 'A falling candle swallows the previous rising one: sellers have taken over' + (upTr ? ' after an advance.' : '.'));
    if (pg.body > 0.5 * pg.range && g.body < 0.5 * pg.body && Math.max(c.o, c.c) <= Math.max(p.o, p.c) && Math.min(c.o, c.c) >= Math.min(p.o, p.c) && g.body > 0) add(pg.bear ? 'Bullish harami' : 'Bearish harami', pg.bear ? 'bullish' : 'bearish', 'A small candle inside the previous large one: the move is losing force.');
    if (pg.bear && g.bull && c.o < p.c && c.c > (p.o + p.c) / 2 && c.c < p.o) add('Piercing line', 'bullish', 'After a fall, price opens lower but closes above the middle of the previous candle.');
    if (pg.bull && g.bear && c.o > p.c && c.c < (p.o + p.c) / 2 && c.c > p.o) add('Dark cloud cover', 'bearish', 'After a rise, price opens higher but closes below the middle of the previous candle.');
    if (ppg.bear && ppg.body > 0.5 * ppg.range && pg.body < 0.4 * ppg.body && g.bull && c.c > (pp.o + pp.c) / 2) add('Morning star', 'bullish', 'A fall, a hesitation, then a strong rise: a classic three-candle bottom.');
    if (ppg.bull && ppg.body > 0.5 * ppg.range && pg.body < 0.4 * ppg.body && g.bear && c.c < (pp.o + pp.c) / 2) add('Evening star', 'bearish', 'A rise, a hesitation, then a strong fall: a classic three-candle top.');
    if (ppg.bull && pg.bull && g.bull && p.c > pp.c && c.c > p.c && p.o > pp.o && c.o > p.o) add('Three white soldiers', 'bullish', 'Three rising candles in a row, each closing higher: steady buying.');
    if (ppg.bear && pg.bear && g.bear && p.c < pp.c && c.c < p.c && p.o < pp.o && c.o < p.o) add('Three black crows', 'bearish', 'Three falling candles in a row, each closing lower: steady selling.');
  }
  return out.sort((a, b) => a.age - b.age);
}

/** Larger shapes read from the swing points: trend structure, double top or bottom, and range breakouts. */
export function chartPatterns(cs, k = 3) {
  const out = [], sw = swings(cs, k), n = cs.length; if (n < 20) return out;
  const hs = sw.hi.slice(-3), ls = sw.lo.slice(-3), price = cs[n - 1].c;
  if (hs.length >= 2 && ls.length >= 2) {
    const hh = cs[hs[hs.length - 1]].h > cs[hs[hs.length - 2]].h, hl = cs[ls[ls.length - 1]].l > cs[ls[ls.length - 2]].l;
    out.push(hh && hl ? { name: 'Higher highs and higher lows', bias: 'bullish', text: 'The last swing highs and lows are both rising: the shape of an uptrend.' } : !hh && !hl ? { name: 'Lower highs and lower lows', bias: 'bearish', text: 'The last swing highs and lows are both falling: the shape of a downtrend.' } : { name: 'Mixed swings', bias: 'neutral', text: 'Highs and lows are not moving together: a range or a transition.' });
  }
  if (hs.length >= 2) { const a = cs[hs[hs.length - 2]].h, b = cs[hs[hs.length - 1]].h, valley = Math.min(...cs.slice(hs[hs.length - 2], hs[hs.length - 1] + 1).map((x) => x.l)); if (Math.abs(a - b) / a < 0.012 && (Math.min(a, b) - valley) / a > 0.02) out.push({ name: price < valley ? 'Double top (confirmed)' : 'Double top forming', bias: 'bearish', text: `Two peaks near ${a.toFixed(2)} with a dip to ${valley.toFixed(2)} between them. A close below that dip confirms the pattern.` }); }
  if (ls.length >= 2) { const a = cs[ls[ls.length - 2]].l, b = cs[ls[ls.length - 1]].l, peak = Math.max(...cs.slice(ls[ls.length - 2], ls[ls.length - 1] + 1).map((x) => x.h)); if (Math.abs(a - b) / a < 0.012 && (peak - Math.max(a, b)) / a > 0.02) out.push({ name: price > peak ? 'Double bottom (confirmed)' : 'Double bottom forming', bias: 'bullish', text: `Two lows near ${a.toFixed(2)} with a rally to ${peak.toFixed(2)} between them. A close above that rally confirms the pattern.` }); }
  const look = Math.min(20, n - 2), prior = cs.slice(n - 1 - look, n - 1), hi = Math.max(...prior.map((x) => x.h)), lo = Math.min(...prior.map((x) => x.l));
  if (price > hi) out.push({ name: `${look}-bar breakout`, bias: 'bullish', text: `The latest close is above the highest high of the previous ${look} bars (${hi.toFixed(2)}).` });
  else if (price < lo) out.push({ name: `${look}-bar breakdown`, bias: 'bearish', text: `The latest close is below the lowest low of the previous ${look} bars (${lo.toFixed(2)}).` });
  return out;
}

/* ---------- the read ---------- */
const last = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const at = (a, back) => (a.length - 1 - back >= 0 ? a[a.length - 1 - back] : null);
const label = (s) => (s >= 0.5 ? 'Strongly bullish' : s >= 0.2 ? 'Bullish' : s > -0.2 ? 'Neutral' : s > -0.5 ? 'Bearish' : 'Strongly bearish');

/** The technical read of a chart: a verdict, every signal with its reason, key levels, patterns and a short paragraph. */
export function analyse(cs, ind = indicators(cs), tf = '1D') {
  const n = cs.length; if (n < 3) return { ok: false, reason: 'Not enough candles for a technical read yet.' };
  const px = cs[n - 1].c, sig = [], add = (group, name, bias, weight, text) => sig.push({ group, name, bias, weight, text });
  const v = (a) => last(a), f = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));
  // trend
  for (const [k, nm, w] of [['ema21', 'EMA 21', 1], ['sma50', 'SMA 50', 1.5], ['sma200', 'SMA 200', 2]]) { const m = v(ind[k]); if (m != null) add('Trend', `Price vs ${nm}`, px > m ? 1 : -1, w, `Price ${f(px)} is ${px > m ? 'above' : 'below'} the ${nm} (${f(m)}).`); }
  const e9 = v(ind.ema9), e21 = v(ind.ema21); if (e9 != null && e21 != null) add('Trend', 'EMA 9 vs EMA 21', e9 > e21 ? 1 : -1, 1, `The fast average (${f(e9)}) is ${e9 > e21 ? 'above' : 'below'} the slow one (${f(e21)}).`);
  const s50 = v(ind.sma50), s200 = v(ind.sma200); if (s50 != null && s200 != null) add('Trend', s50 > s200 ? 'Golden cross state' : 'Death cross state', s50 > s200 ? 1 : -1, 1.5, `SMA 50 (${f(s50)}) is ${s50 > s200 ? 'above' : 'below'} SMA 200 (${f(s200)}).`);
  const sd = at(ind.st.dir, 0); if (sd) add('Trend', 'Supertrend (10, 3)', sd, 1.5, `The ATR trailing stop is ${sd > 0 ? 'below price (up trend)' : 'above price (down trend)'} at ${f(v(ind.st.line))}.`);
  const ax = v(ind.adx.adx), pdi = v(ind.adx.plus), mdi = v(ind.adx.minus);
  if (ax != null) add('Trend', `ADX ${f(ax, 1)}`, ax >= 25 ? (pdi > mdi ? 1 : -1) : 0, ax >= 25 ? 1.5 : 0.5, ax >= 25 ? `A strong trend (ADX above 25) and the ${pdi > mdi ? 'upward' : 'downward'} directional line leads.` : `ADX below 25: no strong trend, so range tactics suit better than trend following.`);
  // momentum
  const r = v(ind.rsi); if (r != null) add('Momentum', `RSI ${f(r, 1)}`, r > 70 ? -0.5 : r > 55 ? 1 : r < 30 ? 0.5 : r < 45 ? -1 : 0, 1.5, r > 70 ? 'Overbought (above 70): the rise is stretched; pullbacks are common, but strong trends can stay overbought.' : r > 55 ? 'Above 55: momentum favours buyers.' : r < 30 ? 'Oversold (below 30): the fall is stretched; bounces are common, but weak trends can stay oversold.' : r < 45 ? 'Below 45: momentum favours sellers.' : 'Near 50: no momentum edge.');
  const mh = v(ind.macd.hist), mh1 = at(ind.macd.hist, 1); if (mh != null) add('Momentum', 'MACD', mh > 0 ? 1 : -1, 1.5, `MACD is ${mh > 0 ? 'above' : 'below'} its signal line${mh1 != null && Math.sign(mh) !== Math.sign(mh1) ? ' and has just crossed' : ''} (histogram ${f(mh, 3)}).`);
  const sk = v(ind.stoch.k), sdv = v(ind.stoch.d); if (sk != null && sdv != null) add('Momentum', `Stochastic ${f(sk, 0)}`, sk > 80 ? -0.5 : sk < 20 ? 0.5 : sk > sdv ? 0.5 : -0.5, 1, sk > 80 ? 'Above 80: short-term overbought.' : sk < 20 ? 'Below 20: short-term oversold.' : `%K is ${sk > sdv ? 'above' : 'below'} %D.`);
  const roc10 = n > 10 ? (px / cs[n - 11].c - 1) * 100 : null; if (roc10 != null) add('Momentum', `10-bar change ${f(roc10, 1)}%`, roc10 > 0 ? 0.5 : -0.5, 0.5, `Price is ${roc10 > 0 ? 'up' : 'down'} ${f(Math.abs(roc10), 1)}% over the last 10 candles.`);
  // volatility and position
  const a = v(ind.atr), bbU = v(ind.bb.upper), bbL = v(ind.bb.lower), bbM = v(ind.bb.mid);
  if (bbU != null && bbL != null) { const pb = (px - bbL) / (bbU - bbL); add('Volatility', `Bollinger %B ${f(pb * 100, 0)}`, pb > 1 ? -0.5 : pb < 0 ? 0.5 : pb > 0.5 ? 0.5 : -0.5, 1, pb > 1 ? 'Price is above the upper band: stretched, or a breakout beginning.' : pb < 0 ? 'Price is below the lower band: stretched, or a breakdown beginning.' : `Price sits in the ${pb > 0.5 ? 'upper' : 'lower'} half of the bands.`); }
  const vw = v(ind.vwap); if (INTRADAY.has(tf) && vw != null) add('Volume', 'VWAP', px > vw ? 1 : -1, 1, `Price is ${px > vw ? 'above' : 'below'} the day's volume-weighted average (${f(vw)}): ${px > vw ? 'buyers' : 'sellers'} are in control on average.`);
  if (n > 21 && cs.some((c) => c.v > 0)) { const avgV = cs.slice(n - 21, n - 1).reduce((s, c) => s + c.v, 0) / 20, c0 = cs[n - 1]; if (avgV > 0 && c0.v > 1.5 * avgV) add('Volume', 'High volume', c0.c >= c0.o ? 1 : -1, 1, `The latest candle traded ${f(c0.v / avgV, 1)} times the 20-candle average volume on a ${c0.c >= c0.o ? 'rising' : 'falling'} candle: the move has participation.`); }
  const lv = supportResistance(cs), piv = pivots(cs[n - 2]), fib = fibonacci(cs), cp = candlePatterns(cs), chp = chartPatterns(cs);
  for (const p of cp.filter((x) => x.age === 0 && x.bias !== 'neutral')) add('Patterns', p.name, p.bias === 'bullish' ? 1 : -1, 1, p.text);
  for (const p of chp.filter((x) => x.bias !== 'neutral')) add('Patterns', p.name, p.bias === 'bullish' ? 1 : -1, 1.2, p.text);
  const W = sig.reduce((s, x) => s + x.weight, 0), score = W ? sig.reduce((s, x) => s + x.bias * x.weight, 0) / W : 0;
  const groupScore = (g) => { const xs = sig.filter((x) => x.group === g), w = xs.reduce((s, x) => s + x.weight, 0); return w ? xs.reduce((s, x) => s + x.bias * x.weight, 0) / w : null; };
  const trend = groupScore('Trend'), mom = groupScore('Momentum');
  const atrPct = a != null ? (a / px) * 100 : null, sup = lv.support[0], res = lv.resistance[0];
  const parts = [`${label(score)} on this timeframe (${f(score, 2)} on a scale of -1 to +1).`];
  if (trend != null) parts.push(`Trend: ${label(trend).toLowerCase()}.`); if (mom != null) parts.push(`Momentum: ${label(mom).toLowerCase()}.`);
  if (sup || res) parts.push(`${sup ? `Nearest support ${f(sup.price)}` : ''}${sup && res ? ' and ' : ''}${res ? `nearest resistance ${f(res.price)}` : ''}.`);
  if (atrPct != null) parts.push(`Typical range per candle (ATR) is ${f(a)} (${f(atrPct, 1)}% of price).`);
  return { ok: true, score, verdict: label(score), trendScore: trend, momentumScore: mom, signals: sig, levels: lv, pivots: piv, fib, candlePatterns: cp, chartPatterns: chp, atr: a, atrPct, text: parts.join(' '), price: px, candles: n,
    enough: { sma200: v(ind.sma200) != null, sma50: v(ind.sma50) != null } };
}
