/* Trading-strategy simulator for learning: long-only strategies run over a stock's daily closes, with honest execution rules.
 *
 *   - A signal is read from the data up to and including day t and acts on day t+1's close (no peeking at the day it is decided).
 *   - Always all-in or all-out: when flat the whole cash buys whole shares, when the signal ends everything is sold. No shorting, no leverage.
 *   - Every buy and sell pays a fee (default 0.10%, a stand-in for brokerage, taxes and charges) plus optional slippage.
 *   - Results are compared with simply buying on the first day and holding.
 * Pure functions, no DOM, no network: the view feeds them closes from /api/history and renders what they return. */
import { sma, ema, rsi, macd, bollinger, channel, roc } from './indicators.js';

/** Each strategy turns closes into a desired position per day (1 = hold shares, 0 = stay in cash), using only data up to that day. */
export const STRATEGIES = {
  buyhold: {
    name: 'Buy and hold', params: [],
    idea: 'Buy once on day one and never sell. The yardstick every other strategy must beat.',
    buy: 'On the first day.', sell: 'Never.',
    works: 'In long rising markets, where being invested all the time is the whole game.', fails: 'When the stock falls for years: it takes the full drawdown with no way out.',
    lesson: 'Most active strategies underperform this after costs. Always compare with it.',
    signal: (c) => c.map(() => 1),
  },
  sma_cross: {
    name: 'Moving-average crossover', params: [['fast', 'Fast average (days)', 20, 2, 100], ['slow', 'Slow average (days)', 50, 5, 250]],
    idea: 'A short average rising above a long one means recent prices are stronger than the usual level: the trend has turned up.',
    buy: 'The fast average closes above the slow average.', sell: 'The fast average closes below the slow average.',
    works: 'In sustained trends, up or down: it gets you in after a trend starts and out after it ends.', fails: 'In sideways, choppy markets: it buys and sells repeatedly at small losses ("whipsaws"), and it is always late.',
    lesson: 'Trend-following trades some profit away at both ends to avoid the middle of big moves.',
    signal: (c, p) => { const f = sma(c, p.fast), s = sma(c, p.slow); return c.map((_, i) => (f[i] == null || s[i] == null ? 0 : f[i] > s[i] ? 1 : 0)); },
  },
  rsi_reversion: {
    name: 'RSI mean reversion', params: [['period', 'RSI period (days)', 14, 2, 50], ['buyBelow', 'Buy when RSI below', 30, 5, 50], ['sellAbove', 'Sell when RSI above', 55, 50, 90]],
    idea: 'After a sharp fall the RSI (a 0 to 100 gauge of recent gains versus losses) is low; prices often bounce back toward normal.',
    buy: 'RSI drops below the buy level.', sell: 'RSI rises above the sell level.',
    works: 'In range-bound stocks that overshoot both ways and snap back.', fails: 'In a strong downtrend: RSI stays low, you keep "buying the dip" as it keeps dipping.',
    lesson: 'Buying weakness is the opposite bet to trend following; each wins in the other\'s losing market.',
    signal: (c, p) => { const r = rsi(c, p.period); let pos = 0; return c.map((_, i) => { if (r[i] != null) { if (pos === 0 && r[i] < p.buyBelow) pos = 1; else if (pos === 1 && r[i] > p.sellAbove) pos = 0; } return pos; }); },
  },
  macd_cross: {
    name: 'MACD signal crossover', params: [['fast', 'Fast EMA', 12, 2, 50], ['slow', 'Slow EMA', 26, 5, 120], ['signal', 'Signal EMA', 9, 2, 50]],
    idea: 'MACD is the gap between a fast and a slow exponential average; when it crosses its own smoothed line, momentum is changing direction.',
    buy: 'The MACD line crosses above its signal line.', sell: 'The MACD line crosses below its signal line.',
    works: 'When momentum shifts cleanly and then persists.', fails: 'In noisy periods it flips often, like the moving-average crossover but faster.',
    lesson: 'Faster signals react sooner but are wrong more often: a trade-off with no free lunch.',
    signal: (c, p) => { const m = macd(c, p.fast, p.slow, p.signal); return c.map((_, i) => (m.hist[i] == null ? 0 : m.hist[i] > 0 ? 1 : 0)); },
  },
  donchian: {
    name: 'Breakout (Donchian channel)', params: [['entry', 'Buy on new high of last N days', 20, 5, 120], ['exit', 'Sell on new low of last N days', 10, 3, 60]],
    idea: 'A price above everything seen in the last weeks shows buyers overpowering sellers: buy the breakout, leave when it breaks down.',
    buy: 'Today\'s close is above the highest close of the previous N days.', sell: 'Today\'s close is below the lowest close of the previous M days.',
    works: 'When a stock leaves a long base and runs.', fails: 'On false breakouts that reverse straight away.',
    lesson: 'Cutting losses with a clear exit rule matters more than the entry rule.',
    signal: (c, p) => { const up = channel(c, p.entry), dn = channel(c, p.exit); let pos = 0; return c.map((x, i) => { if (up.hi[i] != null) { if (pos === 0 && x > up.hi[i]) pos = 1; else if (pos === 1 && dn.lo[i] != null && x < dn.lo[i]) pos = 0; } return pos; }); },
  },
  bollinger: {
    name: 'Bollinger band reversion', params: [['period', 'Average period (days)', 20, 5, 100], ['k', 'Band width (std. deviations)', 2, 1, 4]],
    idea: 'Prices usually stay within a band around their average; a close below the lower band is unusually cheap and tends to revert.',
    buy: 'The close falls below the lower band.', sell: 'The close returns to the middle average.',
    works: 'In calm, oscillating stocks.', fails: 'When a stock breaks down for real: the lower band keeps moving down with it.',
    lesson: '"Cheap" relative to recent history is not the same as cheap in value.',
    signal: (c, p) => { const b = bollinger(c, p.period, p.k); let pos = 0; return c.map((x, i) => { if (b.mid[i] != null) { if (pos === 0 && x < b.lower[i]) pos = 1; else if (pos === 1 && x >= b.mid[i]) pos = 0; } return pos; }); },
  },
  momentum: {
    name: 'Momentum', params: [['lookback', 'Look-back (days)', 60, 10, 250]],
    idea: 'Stocks that have risen over the last months tend to keep rising for a while; hold only while the past return is positive.',
    buy: 'The price is higher than it was N days ago.', sell: 'The price is at or below its level N days ago.',
    works: 'In steady uptrends and sector rotations.', fails: 'At sharp reversals, when the past return flips only after the fall is well under way.',
    lesson: 'Momentum is one of the most studied effects, and also one of the most crowded.',
    signal: (c, p) => { const r = roc(c, p.lookback); return c.map((_, i) => (r[i] == null ? 0 : r[i] > 0 ? 1 : 0)); },
  },
};

export const defaultParams = (key) => Object.fromEntries(STRATEGIES[key].params.map(([k, , d]) => [k, d]));

/** Clamp user-edited parameters to the allowed range and make them integers (except the band width), so a typo cannot crash or distort a run. */
export function cleanParams(key, raw = {}) {
  const out = {};
  for (const [k, , d, lo, hi] of STRATEGIES[key].params) { const n = Number(raw[k]); out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, k === 'k' ? n : Math.round(n))) : d; }
  return out;
}

const maxDrawdown = (eq) => { let peak = -Infinity, worst = 0; for (const v of eq) { peak = Math.max(peak, v); worst = Math.min(worst, (v - peak) / peak); } return worst * 100; };

/** Run one strategy. `points` = [[date, close], ...] oldest first. Returns equity curves, trades, metrics and the position the strategy holds today. */
export function backtest(points, key, rawParams = {}, { capital = 1_000_000, feePct = 0.1, slipPct = 0.05 } = {}) {
  if (!STRATEGIES[key]) throw new Error(`unknown strategy ${key}`);
  if (!points || points.length < 3) throw new Error('not enough price history to run a strategy');
  const params = cleanParams(key, rawParams), closes = points.map((p) => p[1]), want = STRATEGIES[key].signal(closes, params);
  const fee = feePct / 100, slip = slipPct / 100;
  let cash = capital, qty = 0, entry = null, feesPaid = 0, held = 0;
  const equity = [], trades = [], rounds = [];
  for (let i = 0; i < points.length; i++) {
    const px = closes[i], target = i === 0 ? 0 : want[i - 1];      // yesterday's signal acts at today's close
    if (target === 1 && qty === 0) {
      const buyPx = px * (1 + slip), n = Math.floor(cash / (buyPx * (1 + fee)));
      if (n > 0) { const cost = n * buyPx, f = cost * fee; cash -= cost + f; feesPaid += f; qty = n; entry = { date: points[i][0], px: buyPx, cost: cost + f, n }; trades.push({ date: points[i][0], side: 'BUY', price: buyPx, qty: n, fee: f }); }
    } else if (target === 0 && qty > 0) {
      const sellPx = px * (1 - slip), proceeds = qty * sellPx, f = proceeds * fee; cash += proceeds - f; feesPaid += f;
      const pnl = proceeds - f - entry.cost; rounds.push({ from: entry.date, to: points[i][0], pnl, pct: (pnl / entry.cost) * 100, days: i });
      trades.push({ date: points[i][0], side: 'SELL', price: sellPx, qty, fee: f, pnl, pct: (pnl / entry.cost) * 100 }); qty = 0; entry = null;
    }
    if (qty > 0) held++;
    equity.push([points[i][0], cash + qty * px]);
  }
  // buy and hold with the same costs
  const bhBuy = closes[0] * (1 + slip), bhN = Math.floor(capital / (bhBuy * (1 + fee))), bhCash = capital - bhN * bhBuy * (1 + fee);
  const bh = closes.map((c, i) => [points[i][0], bhCash + bhN * c]);
  const endVal = equity[equity.length - 1][1], bhEnd = bh[bh.length - 1][1];
  const years = (Date.parse(points[points.length - 1][0]) - Date.parse(points[0][0])) / (365.25 * 86400000);
  const wins = rounds.filter((r) => r.pnl > 0).length;
  const metrics = {
    finalValue: endVal, returnPct: ((endVal - capital) / capital) * 100, buyHoldPct: ((bhEnd - capital) / capital) * 100,
    excessPct: ((endVal - bhEnd) / capital) * 100, maxDrawdownPct: maxDrawdown(equity.map((e) => e[1])), buyHoldDrawdownPct: maxDrawdown(bh.map((e) => e[1])),
    roundTrips: rounds.length, winRatePct: rounds.length ? (wins / rounds.length) * 100 : null, avgTradePct: rounds.length ? rounds.reduce((a, r) => a + r.pct, 0) / rounds.length : null,
    exposurePct: (held / points.length) * 100, feesPaid, years, cagrPct: years >= 1 ? (Math.pow(endVal / capital, 1 / years) - 1) * 100 : null, days: points.length,
  };
  const today = want[want.length - 1], changedAt = (() => { for (let i = want.length - 1; i > 0; i--) if (want[i] !== want[i - 1]) return points[i][0]; return null; })();
  return { key, params, equity, buyHold: bh, trades, rounds, metrics, today: { position: today === 1 ? 'long' : 'flat', since: changedAt, open: qty > 0 ? { qty, entry: entry.px, date: entry.date } : null } };
}

/** All strategies with their default parameters on the same data: the "how would the others have done" comparison. */
export function compareAll(points, opts) {
  return Object.keys(STRATEGIES).map((key) => { try { const r = backtest(points, key, defaultParams(key), opts); return { key, name: STRATEGIES[key].name, ...r.metrics, today: r.today.position }; } catch (e) { return { key, name: STRATEGIES[key].name, error: e.message }; } });
}
