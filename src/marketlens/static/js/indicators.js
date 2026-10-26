/* Technical indicators on arrays of closes, shared by the strategy simulator. Pure functions, no DOM. Each returns an array the same length as the
 * input, with null where there is not yet enough history. The definitions match mobile/engine/analysis.js (a test compares them). */

export const sma = (v, n) => v.map((_, i) => (i + 1 < n ? null : v.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n));

export function ema(v, n) {
  if (!v.length) return [];
  const k = 2 / (n + 1), out = [];
  let e = v[0];
  for (const x of v) { e = x * k + e * (1 - k); out.push(e); }
  return out;
}

/** Wilder's RSI. */
export function rsi(v, n = 14) {
  const out = v.map(() => null);
  if (v.length <= n) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = v[i] - v[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
  let ag = g / n, al = l / n;
  out[n] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

/** MACD line, signal line and histogram (the EMA seeds with the first close, like the app's analysis). */
export function macd(v, fast = 12, slow = 26, signal = 9) {
  const f = ema(v, fast), s = ema(v, slow), line = f.map((x, i) => x - s[i]), sig = ema(line, signal);
  const warm = slow + signal;
  return { line, signal: sig, hist: line.map((x, i) => (i + 1 < warm ? null : x - sig[i])) };
}

/** Bollinger bands: middle = SMA, upper/lower = middle +/- k population standard deviations. */
export function bollinger(v, n = 20, k = 2) {
  const mid = sma(v, n);
  const sd = v.map((_, i) => { if (i + 1 < n) return null; const w = v.slice(i + 1 - n, i + 1), m = mid[i]; return Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / n); });
  return { mid, upper: mid.map((m, i) => (m == null ? null : m + k * sd[i])), lower: mid.map((m, i) => (m == null ? null : m - k * sd[i])) };
}

/** Highest and lowest close of the previous n days (today excluded, so a breakout is "today above everything before"). */
export function channel(v, n) {
  const hi = v.map((_, i) => (i < n ? null : Math.max(...v.slice(i - n, i)))), lo = v.map((_, i) => (i < n ? null : Math.min(...v.slice(i - n, i))));
  return { hi, lo };
}

/** Rate of change over n days, in percent. */
export const roc = (v, n) => v.map((x, i) => (i < n || !v[i - n] ? null : ((x - v[i - n]) / v[i - n]) * 100));

/** Population standard deviation over the last n values. */
export const stdev = (v, n) => v.map((_, i) => { if (i + 1 < n) return null; const w = v.slice(i + 1 - n, i + 1), m = w.reduce((a, b) => a + b, 0) / n; return Math.sqrt(w.reduce((a, x) => a + (x - m) ** 2, 0) / n); });

/** How many standard deviations the close is above (+) or below (-) its n-day average. */
export function zscore(v, n) { const m = sma(v, n), s = stdev(v, n); return v.map((x, i) => (m[i] == null || !s[i] ? null : (x - m[i]) / s[i])); }

/** Stochastic %K on closes: where the close sits within the n-day closing range, 0 to 100. */
export const stochK = (v, n = 14) => v.map((x, i) => { if (i + 1 < n) return null; const w = v.slice(i + 1 - n, i + 1), hi = Math.max(...w), lo = Math.min(...w); return hi === lo ? 50 : ((x - lo) / (hi - lo)) * 100; });

/** Commodity Channel Index on closes: distance from the average in units of mean deviation (x 0.015). */
export function cci(v, n = 20) {
  const m = sma(v, n);
  return v.map((x, i) => { if (m[i] == null) return null; const w = v.slice(i + 1 - n, i + 1), md = w.reduce((a, y) => a + Math.abs(y - m[i]), 0) / n; return md ? (x - m[i]) / (0.015 * md) : 0; });
}

/** Slope of the least-squares line through the last n closes (price units per day). */
export function slope(v, n) {
  const xm = (n - 1) / 2, sxx = v.length ? Array.from({ length: n }, (_, k) => (k - xm) ** 2).reduce((a, b) => a + b, 0) : 1;
  return v.map((_, i) => { if (i + 1 < n) return null; const w = v.slice(i + 1 - n, i + 1), ym = w.reduce((a, b) => a + b, 0) / n; return w.reduce((a, y, k) => a + (k - xm) * (y - ym), 0) / sxx; });
}

/** TRIX: one-day percentage change of a triple-smoothed EMA. */
export function trix(v, n = 15) { const e = ema(ema(ema(v, n), n), n); return e.map((x, i) => (i < 3 * n || !e[i - 1] ? null : ((x - e[i - 1]) / e[i - 1]) * 100)); }
