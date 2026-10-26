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
