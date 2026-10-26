/* Trading-strategy simulator for learning: long-only strategies run over a stock's daily closes, with honest execution rules.
 *
 *   - A signal is read from the data up to and including day t and acts on day t+1's close (no peeking at the day it is decided).
 *   - Always all-in or all-out: when flat the whole cash buys whole shares, when the signal ends everything is sold. No shorting, no leverage.
 *   - Every buy and sell pays a fee (default 0.10%, a stand-in for brokerage, taxes and charges) plus optional slippage.
 *   - Results are compared with simply buying on the first day and holding.
 * Pure functions, no DOM, no network: the view feeds them closes from /api/history and renders what they return. */
import { sma, ema, rsi, macd, bollinger, channel, roc, stdev, zscore, stochK, cci, slope, trix } from './indicators.js';

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


/* ---------- more strategies: grouped by what they bet on. All read closes only (no highs or lows), so oscillators use the closing range. ---------- */
const hold = (n, enter, exit) => { let pos = 0; return Array.from({ length: n }, (_, i) => { if (pos === 0 && enter(i)) pos = 1; else if (pos === 1 && exit(i)) pos = 0; return pos; }); };
const flip = (n, up, down, end = () => false) => { let pos = 0; return Array.from({ length: n }, (_, i) => { if (up(i)) pos = 1; else if (down(i)) pos = -1; else if (pos !== 0 && end(i)) pos = 0; return pos; }); };
const ok = (x) => x != null;
const def = (group, name, params, [idea, buy, sell, works, fails, lesson], signal, extra = {}) => ({ group, name, params, idea, buy, sell, works, fails, lesson, signal, ...extra });
const month = (d) => +d.slice(5, 7), dom = (d) => +d.slice(8, 10);

Object.assign(STRATEGIES, {
  ema_cross: def('Trend following', 'Exponential average crossover', [['fast', 'Fast EMA (days)', 12, 2, 100], ['slow', 'Slow EMA (days)', 26, 5, 250]],
    ['Like the moving-average crossover, but recent days count for more, so it reacts sooner.', 'The fast EMA closes above the slow EMA.', 'The fast EMA closes below the slow EMA.', 'In trends that start cleanly.', 'In choppy markets, where faster means more false signals.', 'Quicker reaction costs more whipsaws.'],
    (c, p) => { const f = ema(c, p.fast), s = ema(c, p.slow); return c.map((_, i) => (i < p.slow ? 0 : f[i] > s[i] ? 1 : 0)); }),
  triple_ma: def('Trend following', 'Triple moving-average alignment', [['fast', 'Fast (days)', 5, 2, 50], ['mid', 'Middle (days)', 20, 5, 100], ['slow', 'Slow (days)', 50, 10, 250]],
    ['Three averages in order (fast above middle above slow) is a stricter test of a healthy trend than two.', 'Fast > middle > slow.', 'The order breaks.', 'In smooth, persistent trends.', 'Late: three averages must all line up first.', 'More confirmation means fewer false entries but later ones.'],
    (c, p) => { const f = sma(c, p.fast), m = sma(c, p.mid), s = sma(c, p.slow); return c.map((_, i) => (ok(f[i]) && ok(m[i]) && ok(s[i]) && f[i] > m[i] && m[i] > s[i] ? 1 : 0)); }),
  golden_cross: def('Trend following', 'Golden cross / death cross (50 and 200 day)', [['fast', 'Fast average (days)', 50, 10, 120], ['slow', 'Slow average (days)', 200, 100, 300]],
    ['The best-known long-term trend signal: the 50-day average crossing above the 200-day.', 'The 50-day average closes above the 200-day.', 'The 50-day closes below the 200-day (the "death cross").', 'In multi-year bull markets.', 'It needs 200 days of history before the first signal, so choose a 3-year or longer period; it is very slow.', 'Slow signals avoid noise but give back a lot at turning points.'],
    (c, p) => { const f = sma(c, p.fast), s = sma(c, p.slow); return c.map((_, i) => (ok(f[i]) && ok(s[i]) && f[i] > s[i] ? 1 : 0)); }),
  price_sma: def('Trend following', 'Price above its moving average', [['period', 'Average (days)', 100, 10, 250]],
    ['The simplest trend filter: be invested only while the price is above its own long-term average.', 'The close is above the average.', 'The close is below the average.', 'In trending markets; it sidesteps long declines.', 'Around the average line, where it flips repeatedly.', 'One rule and one number can capture most of what complex trend systems do.'],
    (c, p) => { const m = sma(c, p.period); return c.map((x, i) => (ok(m[i]) && x > m[i] ? 1 : 0)); }),
  macd_zero: def('Trend following', 'MACD above zero line', [['fast', 'Fast EMA', 12, 2, 50], ['slow', 'Slow EMA', 26, 5, 120]],
    ['When the fast average is above the slow one, the MACD line is positive: the medium-term trend is up.', 'The MACD line is above zero.', 'The MACD line is at or below zero.', 'In established trends.', 'Slower than the signal-line crossover, so it exits late.', 'The zero line separates the trend from the timing signals around it.'],
    (c, p) => { const m = macd(c, p.fast, p.slow, 9); return c.map((_, i) => (i + 1 < p.slow ? 0 : m.line[i] > 0 ? 1 : 0)); }),
  linreg: def('Trend following', 'Linear-regression trend', [['period', 'Window (days)', 30, 10, 120]],
    ['Fit a straight line through the last N closes; if it slopes up, the recent trend is up.', 'The fitted line slopes upward.', 'The fitted line slopes downward.', 'In smooth trends.', 'At turning points: a line cannot see a reversal coming.', 'Statistics describe the past trend; they do not promise it continues.'],
    (c, p) => { const s = slope(c, p.period); return c.map((_, i) => (ok(s[i]) && s[i] > 0 ? 1 : 0)); }),
  trix: def('Trend following', 'TRIX (triple-smoothed momentum)', [['period', 'EMA period (days)', 15, 3, 50]],
    ['Smooth the price three times to remove noise, then follow its direction: positive means rising trend.', 'TRIX turns above zero.', 'TRIX turns below zero.', 'In noisy but trending markets.', 'It is very slow and needs three times the period before the first signal.', 'More smoothing means less noise and more delay.'],
    (c, p) => { const t = trix(c, p.period); return c.map((_, i) => (ok(t[i]) && t[i] > 0 ? 1 : 0)); }),
  rsi_trend: def('Momentum', 'RSI above 50 (trend filter)', [['period', 'RSI period (days)', 14, 2, 50]],
    ['In an uptrend the RSI tends to live above 50: use it as a trend gauge instead of an overbought/oversold signal.', 'RSI is above 50.', 'RSI is at or below 50.', 'In steady trends.', 'In range-bound markets where RSI crosses 50 constantly.', 'The same indicator can be read as trend or as reversal: the rule you attach to it decides.'],
    (c, p) => { const r = rsi(c, p.period); return c.map((_, i) => (ok(r[i]) && r[i] > 50 ? 1 : 0)); }),
  rsi_momentum: def('Momentum', 'RSI momentum band (60 in, 45 out)', [['period', 'RSI period (days)', 14, 2, 50], ['buyAbove', 'Buy when RSI above', 60, 50, 90], ['sellBelow', 'Sell when RSI below', 45, 10, 55]],
    ['Strong stocks keep RSI high; buy strength and leave when momentum fades, with a gap between the two levels to avoid flip-flopping.', 'RSI rises above the buy level.', 'RSI falls below the sell level.', 'In strong, persistent rallies.', 'In weak markets it rarely triggers; at tops it exits after a fall has begun.', 'A gap between entry and exit levels (hysteresis) cuts needless trades.'],
    (c, p) => { const r = rsi(c, p.period); return hold(c.length, (i) => ok(r[i]) && r[i] > p.buyAbove, (i) => ok(r[i]) && r[i] < p.sellBelow); }),
  stochastic: def('Momentum', 'Stochastic oscillator reversion', [['period', 'Range (days)', 14, 3, 60], ['buyBelow', 'Buy when %K below', 20, 5, 40], ['sellAbove', 'Sell when %K above', 70, 50, 95]],
    ['%K shows where today\'s close sits in the recent closing range. Near the bottom (below 20) the stock is stretched down and may bounce.', '%K drops below the buy level.', '%K rises above the sell level.', 'In range-bound stocks.', 'In strong downtrends, where %K stays pinned near zero.', 'Oscillators work in ranges and fail in trends: know which market you are in.'],
    (c, p) => { const k = stochK(c, p.period); return hold(c.length, (i) => ok(k[i]) && k[i] < p.buyBelow, (i) => ok(k[i]) && k[i] > p.sellAbove); }),
  cci: def('Momentum', 'CCI momentum', [['period', 'CCI period (days)', 20, 5, 100], ['buyAbove', 'Buy when CCI above', 100, 50, 200]],
    ['The Commodity Channel Index measures how far the price is from its average. A reading above +100 marks unusual strength.', 'CCI rises above the buy level.', 'CCI falls below zero.', 'When strength persists.', 'In whipsaw markets: a +100 spike can be the top.', 'Strength can be a signal to join or a warning of exhaustion; the exit rule matters.'],
    (c, p) => { const v = cci(c, p.period); return hold(c.length, (i) => ok(v[i]) && v[i] > p.buyAbove, (i) => ok(v[i]) && v[i] < 0); }),
  tsmom: def('Momentum', 'Time-series momentum (skip last days)', [['lookback', 'Look-back (days)', 126, 40, 250], ['skip', 'Skip most recent (days)', 10, 0, 30]],
    ['The classic momentum measure ignores the very latest days, which tend to reverse briefly: judge the stock on the move before that.', 'The return from N days ago to a few days ago is positive.', 'That return turns negative.', 'In trending markets.', 'In sharp reversals.', 'Academic momentum signals skip the most recent days on purpose.'],
    (c, p) => c.map((_, i) => (i - p.lookback < 0 || !c[i - p.lookback] ? 0 : c[i - p.skip] / c[i - p.lookback] - 1 > 0 ? 1 : 0))),
  near_high: def('Momentum', 'Near the 52-week high', [['lookback', 'High over (days)', 250, 60, 500], ['within', 'Buy within (% of high)', 5, 1, 20], ['exit', 'Sell when below (% of high)', 15, 3, 40]],
    ['Stocks close to their yearly high tend to keep outperforming: investors anchor on old highs and under-react to good news.', 'The close is within the set percentage of the highest close of the period.', 'The close falls further than the exit percentage below that high.', 'In bull markets and leadership stocks.', 'When a market-wide fall drags even leaders down.', 'Buying what looks "expensive" is a documented edge, and feels wrong.'],
    (c, p) => { const hi = c.map((_, i) => (i + 1 < Math.min(p.lookback, 60) ? null : Math.max(...c.slice(Math.max(0, i + 1 - p.lookback), i + 1)))); return hold(c.length, (i) => ok(hi[i]) && c[i] >= hi[i] * (1 - p.within / 100), (i) => ok(hi[i]) && c[i] < hi[i] * (1 - p.exit / 100)); }),
  rsi2: def('Mean reversion', 'Short-term RSI(2) pullback in an uptrend', [['trend', 'Only above average of (days)', 100, 20, 250], ['buyBelow', 'Buy when RSI(2) below', 10, 1, 30], ['sellAbove', 'Sell when RSI(2) above', 70, 50, 99]],
    ['A very short RSI spikes to extremes. Buying a sharp dip inside a long-term uptrend tries to catch short bounces with the trend on your side.', 'RSI(2) is below the buy level while the price is above its long average.', 'RSI(2) rises above the sell level.', 'In healthy uptrends with frequent small dips.', 'In bear markets (the trend filter keeps you out), and when a dip becomes a crash.', 'Combining a trend filter with a dip signal is a common recipe for avoiding falling knives.'],
    (c, p) => { const r = rsi(c, 2), m = sma(c, p.trend); return hold(c.length, (i) => ok(r[i]) && ok(m[i]) && c[i] > m[i] && r[i] < p.buyBelow, (i) => ok(r[i]) && r[i] > p.sellAbove); }),
  zscore: def('Mean reversion', 'Z-score reversion', [['period', 'Window (days)', 20, 5, 100], ['entry', 'Buy when z below -', 2, 1, 4]],
    ['A z-score counts how many standard deviations the price is from its average. At -2 the price is unusually low for this stock.', 'The z-score falls below minus the entry level.', 'The z-score returns to zero (the average).', 'In stocks that oscillate around a stable level.', 'In real breakdowns, where "cheap" gets cheaper.', 'Statistical cheapness is not value: the average itself can be moving down.'],
    (c, p) => { const z = zscore(c, p.period); return hold(c.length, (i) => ok(z[i]) && z[i] < -p.entry, (i) => ok(z[i]) && z[i] >= 0); }),
  sma_dip: def('Mean reversion', 'Buy a dip below the average', [['period', 'Average (days)', 20, 5, 100], ['dip', 'Dip below average (%)', 5, 1, 30]],
    ['Prices stretched several percent under their average often drift back to it.', 'The close is the set percentage below its average.', 'The close is back at or above the average.', 'In steady, range-bound stocks.', 'When the average itself is falling.', 'A fixed percentage is simple but ignores how volatile the stock is.'],
    (c, p) => { const m = sma(c, p.period); return hold(c.length, (i) => ok(m[i]) && c[i] < m[i] * (1 - p.dip / 100), (i) => ok(m[i]) && c[i] >= m[i]); }),
  down_days: def('Mean reversion', 'Consecutive down days', [['days', 'Buy after N down closes in a row', 3, 2, 8]],
    ['After several falling days in a row, sellers are often exhausted and a small bounce is common.', 'The close has fallen N days in a row.', 'The first close higher than the day before.', 'In choppy, mean-reverting markets.', 'In crashes: it keeps buying a falling stock.', 'Short-term reversal is a real, small effect that costs eat quickly.'],
    (c, p) => hold(c.length, (i) => i >= p.days && c.slice(i - p.days, i + 1).every((x, k, a) => k === 0 || x < a[k - 1]), (i) => i > 0 && c[i] > c[i - 1])),
  boll_break: def('Breakout and volatility', 'Bollinger band breakout', [['period', 'Average (days)', 20, 5, 100], ['k', 'Band width (std. deviations)', 2, 1, 4]],
    ['The opposite reading of the bands: a close above the upper band shows strength, so join it and stay until the price falls back to the middle.', 'The close is above the upper band.', 'The close falls below the middle average.', 'When a move gathers pace.', 'On spikes that reverse straight away.', 'The same bands support opposite strategies; markets decide which one works.'],
    (c, p) => { const b = bollinger(c, p.period, p.k); return hold(c.length, (i) => ok(b.upper[i]) && c[i] > b.upper[i], (i) => ok(b.mid[i]) && c[i] < b.mid[i]); }),
  turtle: def('Breakout and volatility', 'Turtle breakout (55 in, 20 out)', [['entry', 'Buy on new high of last N days', 55, 10, 250], ['exit', 'Sell on new low of last N days', 20, 5, 120]],
    ['The famous 1980s "Turtle Traders" system: buy a 55-day high, exit on a 20-day low, and let winners run.', 'The close is above the highest close of the previous 55 days.', 'The close is below the lowest close of the previous 20 days.', 'In big, long trends.', 'In ranges: many small losses before the rare big win.', 'Trend systems lose often and win big: the average win must beat the average loss.'],
    (c, p) => { const up = channel(c, p.entry), dn = channel(c, p.exit); return hold(c.length, (i) => ok(up.hi[i]) && c[i] > up.hi[i], (i) => ok(dn.lo[i]) && c[i] < dn.lo[i]); }),
  squeeze: def('Breakout and volatility', 'Volatility squeeze breakout', [['period', 'Band window (days)', 20, 10, 60], ['look', 'Squeeze = narrowest in (days)', 60, 20, 200]],
    ['When the Bollinger bands narrow to their tightest in months, a big move often follows. Wait for the close above the upper band to pick the direction.', 'A close above the upper band within 5 days of a squeeze.', 'The close falls below the middle average.', 'Before earnings-style or news-driven moves.', 'When calm just continues: no breakout, no trade.', 'Low volatility does not say which way the move goes; the breakout does.'],
    (c, p) => { const b = bollinger(c, p.period, 2), bw = c.map((_, i) => (ok(b.mid[i]) ? (b.upper[i] - b.lower[i]) / b.mid[i] : null)), sq = c.map((_, i) => { if (!ok(bw[i]) || i + 1 < p.look) return false; const w = bw.slice(i + 1 - p.look, i + 1).filter(ok); return w.length && bw[i] <= Math.min(...w); });
      return hold(c.length, (i) => ok(b.upper[i]) && c[i] > b.upper[i] && sq.slice(Math.max(0, i - 5), i + 1).some(Boolean), (i) => ok(b.mid[i]) && c[i] < b.mid[i]); }),
  trailing_stop: def('Risk rules', 'Buy and hold with a trailing stop', [['stop', 'Trailing stop (% below the high)', 10, 2, 40], ['reenter', 'Re-enter on new high of (days)', 20, 5, 120]],
    ['Hold the stock, but sell if it falls a set percentage from its highest price since you bought. Re-enter when it makes a fresh high.', 'On day one, and again on a new N-day high after a stop-out.', 'The close is the stop percentage below the highest close since entry.', 'In long trends with sudden crashes.', 'In choppy markets: stopped out, then the stock recovers.', 'A stop limits the worst loss and costs some of the trend: the price of insurance.'],
    (c, p) => { const ch = channel(c, p.reenter); let pos = 0, peak = 0; return c.map((x, i) => { if (pos === 0 && (i === 0 || (ok(ch.hi[i]) && x > ch.hi[i]))) { pos = 1; peak = x; } else if (pos === 1) { peak = Math.max(peak, x); if (x < peak * (1 - p.stop / 100)) pos = 0; } return pos; }); }),
  sma_stop: def('Risk rules', 'Trend entry with stop-loss and target', [['period', 'Trend average (days)', 50, 10, 200], ['stop', 'Stop-loss (%)', 7, 1, 30], ['target', 'Profit target (%)', 15, 2, 100]],
    ['Enter when the price crosses above its average, but decide the exit in advance: a fixed stop-loss below and a profit target above.', 'The close crosses above its average.', 'The loss reaches the stop, the gain reaches the target, or the close falls below the average.', 'When trends are moderate and steady.', 'In strong trends, the target cuts profits short.', 'Knowing the maximum loss before entering is the core of risk management; it is also why profit targets cap upside.'],
    (c, p) => { const m = sma(c, p.period); let pos = 0, e = 0; return c.map((x, i) => { if (pos === 0 && ok(m[i]) && i > 0 && ok(m[i - 1]) && x > m[i] && c[i - 1] <= m[i - 1]) { pos = 1; e = x; } else if (pos === 1 && (x <= e * (1 - p.stop / 100) || x >= e * (1 + p.target / 100) || (ok(m[i]) && x < m[i]))) pos = 0; return pos; }); }),
  sip: def('Investing', 'Monthly SIP (rupee-cost averaging)', [['every', 'Invest every N months', 1, 1, 12]],
    ['Invest an equal amount on a fixed schedule instead of all at once, so you buy more shares when the price is low and fewer when it is high.', 'On the first trading day of every Nth month, with the starting money split evenly across all instalments.', 'Never.', 'In volatile or falling-then-recovering markets, and for investors who add money from salary.', 'In steadily rising markets: part of the money waits in cash while the price climbs.', 'SIP reduces the risk of a bad entry date, not the risk of the market. It trades some return for peace of mind.'],
    (c) => c.map(() => 1), { kind: 'sip' }),
  tom: def('Calendar', 'Turn of the month', [['from', 'Buy from day of month', 26, 20, 31], ['to', 'Sell after day of month', 3, 1, 10]],
    ['Prices have often been stronger around the month boundary, when salaries and fund flows arrive. Hold only from late month to early next month.', 'On the set day of the month (default 26th) or later.', 'After the set early-month day (default 3rd).', 'Where monthly flows move the market.', 'When the pattern fades once it is widely known.', 'Calendar effects are small and unstable: treat any result as a curiosity, not a plan.'],
    (c, p, d) => d.map((x) => { const k = dom(x); return k >= p.from || k <= p.to ? 1 : 0; }), { needsDates: true }),
  halloween: def('Calendar', 'Halloween: November to April only', [['start', 'Buy from month (1-12)', 11, 1, 12], ['end', 'Sell after month (1-12)', 4, 1, 12]],
    ['"Sell in May and go away": in many markets, returns have been better in the winter half of the year than in the summer half.', 'On the first trading day of the start month.', 'After the end month.', 'If the seasonal pattern holds.', 'When it does not: you sit out summer rallies.', 'A pattern found by looking at old data needs a reason and out-of-sample proof before it deserves money.'],
    (c, p, d) => d.map((x) => { const m = month(x); return p.start <= p.end ? (m >= p.start && m <= p.end ? 1 : 0) : (m >= p.start || m <= p.end ? 1 : 0); }), { needsDates: true }),
  sma_ls: def('Long and short', 'Moving-average crossover, long and short', [['fast', 'Fast average (days)', 20, 2, 100], ['slow', 'Slow average (days)', 50, 5, 250]],
    ['The crossover idea, but it also profits from falling markets by selling short while the fast average is below the slow one.', 'Fast average above slow: go long.', 'Fast average below slow: sell short (borrowed shares), then buy back.', 'In long trends in either direction.', 'In choppy markets, where it loses on both sides.', 'Shorting adds a second way to win and a second way to lose: a short has unlimited upside risk. Paper only: your paper account cannot short.'],
    (c, p) => { const f = sma(c, p.fast), s = sma(c, p.slow); return c.map((_, i) => (ok(f[i]) && ok(s[i]) ? (f[i] > s[i] ? 1 : -1) : 0)); }, { shorts: true }),
  macd_ls: def('Long and short', 'MACD crossover, long and short', [['fast', 'Fast EMA', 12, 2, 50], ['slow', 'Slow EMA', 26, 5, 120], ['signal', 'Signal EMA', 9, 2, 50]],
    ['Always in the market: long while MACD is above its signal line, short while it is below.', 'MACD above its signal line.', 'MACD below its signal line: sell short.', 'In momentum-driven markets.', 'In noise: constant flipping.', 'Always being in the market doubles the exposure to whipsaws.'],
    (c, p) => { const m = macd(c, p.fast, p.slow, p.signal); return c.map((_, i) => (m.hist[i] == null ? 0 : m.hist[i] > 0 ? 1 : -1)); }, { shorts: true }),
  momentum_ls: def('Long and short', 'Momentum, long and short', [['lookback', 'Look-back (days)', 60, 10, 250]],
    ['Buy what has risen, sell short what has fallen over the same look-back.', 'The price is above its level N days ago.', 'The price is below its level N days ago: sell short.', 'In persistent trends either way.', 'At reversals.', 'Long-short momentum is a staple of professional funds, with leverage and risk controls that a simple version lacks.'],
    (c, p) => { const r = roc(c, p.lookback); return c.map((_, i) => (r[i] == null ? 0 : r[i] > 0 ? 1 : r[i] < 0 ? -1 : 0)); }, { shorts: true }),
  donchian_ls: def('Long and short', 'Channel breakout, long and short', [['period', 'Breakout over last N days', 20, 5, 120]],
    ['Buy a new N-day high, sell short a new N-day low, and hold until the opposite breakout.', 'The close is above the highest close of the last N days.', 'The close is below the lowest close of the last N days: sell short.', 'In strong trends.', 'In ranges, with repeated false breakouts.', 'Symmetric rules treat up and down alike; markets do not (they fall faster than they rise).'],
    (c, p) => { const ch = channel(c, p.period); return flip(c.length, (i) => ok(ch.hi[i]) && c[i] > ch.hi[i], (i) => ok(ch.lo[i]) && c[i] < ch.lo[i]); }, { shorts: true }),
  bollinger_ls: def('Long and short', 'Bollinger reversion, long and short', [['period', 'Average (days)', 20, 5, 100], ['k', 'Band width (std. deviations)', 2, 1, 4]],
    ['Buy below the lower band, sell short above the upper band, and close either at the middle average.', 'The close is below the lower band.', 'The close is above the upper band: sell short. Both close at the middle average.', 'In range-bound stocks.', 'In strong trends, where it shorts the rally.', 'Fading strength is the most dangerous trade when a trend is real.'],
    (c, p) => { const b = bollinger(c, p.period, p.k); let pos = 0; return c.map((x, i) => { if (!ok(b.mid[i])) return 0; if (pos === 0) { if (x < b.lower[i]) pos = 1; else if (x > b.upper[i]) pos = -1; } else if ((pos === 1 && x >= b.mid[i]) || (pos === -1 && x <= b.mid[i])) pos = 0; return pos; }); }, { shorts: true }),
  rsi_ls: def('Long and short', 'RSI reversion, long and short', [['period', 'RSI period (days)', 14, 2, 50], ['low', 'Buy when RSI below', 30, 5, 45], ['high', 'Short when RSI above', 70, 55, 95]],
    ['Buy oversold, short overbought, and close either side when RSI returns to 50.', 'RSI below the low level.', 'RSI above the high level: sell short. Both close at RSI 50.', 'In range-bound markets.', 'In trends, where RSI stays extreme.', 'Overbought can stay overbought; shorting it can hurt for a long time.'],
    (c, p) => { const r = rsi(c, p.period); let pos = 0; return c.map((_, i) => { if (!ok(r[i])) return 0; if (pos === 0) { if (r[i] < p.low) pos = 1; else if (r[i] > p.high) pos = -1; } else if ((pos === 1 && r[i] >= 50) || (pos === -1 && r[i] <= 50)) pos = 0; return pos; }); }, { shorts: true }),
});
for (const [k, g] of Object.entries({ buyhold: 'Benchmark', sma_cross: 'Trend following', macd_cross: 'Trend following', momentum: 'Momentum', rsi_reversion: 'Mean reversion', bollinger: 'Mean reversion', donchian: 'Breakout and volatility' })) STRATEGIES[k].group = g;
export const GROUP_ORDER = ['Benchmark', 'Trend following', 'Momentum', 'Mean reversion', 'Breakout and volatility', 'Risk rules', 'Investing', 'Calendar', 'Long and short'];
export const strategyGroups = () => GROUP_ORDER.map((g) => [g, Object.entries(STRATEGIES).filter(([, s]) => s.group === g).map(([k, s]) => [k, s.name])]).filter(([, l]) => l.length);

export const defaultParams = (key) => Object.fromEntries(STRATEGIES[key].params.map(([k, , d]) => [k, d]));

/** Clamp user-edited parameters to the allowed range and make them integers (except the band width), so a typo cannot crash or distort a run. */
export function cleanParams(key, raw = {}) {
  const out = {};
  for (const [k, , d, lo, hi] of STRATEGIES[key].params) { const n = Number(raw[k]); out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, k === 'k' ? n : Math.round(n))) : d; }
  return out;
}

const maxDrawdown = (eq) => { let peak = -Infinity, worst = 0; for (const v of eq) { peak = Math.max(peak, v); worst = Math.min(worst, (v - peak) / peak); } return worst * 100; };

/** Run one strategy. `points` = [[date, close], ...] oldest first. Returns equity curves, trades, metrics and the position the strategy holds today.
 *  A signal of 1 = long, 0 = cash, -1 = short (only the "long and short" strategies use it); a "sip" strategy invests in equal instalments instead. */
export function backtest(points, key, rawParams = {}, { capital = 1_000_000, feePct = 0.1, slipPct = 0.05 } = {}) {
  if (!STRATEGIES[key]) throw new Error(`unknown strategy ${key}`);
  if (!points || points.length < 3) throw new Error('not enough price history to run a strategy');
  const S = STRATEGIES[key], params = cleanParams(key, rawParams), closes = points.map((p) => p[1]), dates = points.map((p) => p[0]);
  const want = S.signal(closes, params, dates), fee = feePct / 100, slip = slipPct / 100;
  let cash = capital, qty = 0, entry = null, feesPaid = 0, held = 0, spent = 0;
  const equity = [], trades = [], rounds = [];
  const instalments = S.kind === 'sip' ? (() => { const out = new Set(); let last = null, n = 0; dates.forEach((d, i) => { const m = d.slice(0, 7); if (m !== last) { if (n % params.every === 0) out.add(i); n++; last = m; } }); return out; })() : null;
  const perInstalment = instalments ? capital / instalments.size : 0;
  const close = (i, px) => {   // leave the current position at today's close
    const long = qty > 0, n = Math.abs(qty), fillPx = long ? px * (1 - slip) : px * (1 + slip), gross = n * fillPx, f = gross * fee;
    cash += long ? gross - f : -(gross + f); feesPaid += f;
    const pnl = long ? gross - f - entry.cost : entry.credit - (gross + f), base = long ? entry.cost : entry.credit;
    rounds.push({ from: entry.date, to: dates[i], pnl, pct: (pnl / base) * 100, days: i });
    trades.push({ date: dates[i], side: long ? 'SELL' : 'COVER', price: fillPx, qty: n, fee: f, pnl, pct: (pnl / base) * 100 }); qty = 0; entry = null;
  };
  const open = (i, px, dir) => {
    if (dir === 1) {
      const buyPx = px * (1 + slip), n = Math.floor(cash / (buyPx * (1 + fee)));
      if (n > 0) { const cost = n * buyPx, f = cost * fee; cash -= cost + f; feesPaid += f; qty = n; entry = { date: dates[i], px: buyPx, cost: cost + f, n }; trades.push({ date: dates[i], side: 'BUY', price: buyPx, qty: n, fee: f }); }
    } else {
      const sellPx = px * (1 - slip), n = Math.floor(cash / (sellPx * (1 + fee)));
      if (n > 0) { const gross = n * sellPx, f = gross * fee; cash += gross - f; feesPaid += f; qty = -n; entry = { date: dates[i], px: sellPx, credit: gross - f, n }; trades.push({ date: dates[i], side: 'SHORT', price: sellPx, qty: n, fee: f }); }
    }
  };
  for (let i = 0; i < points.length; i++) {
    const px = closes[i];
    if (instalments) {   // equal instalments, whole shares, never sold
      if (instalments.has(i)) { const buyPx = px * (1 + slip), n = Math.floor(Math.min(cash, perInstalment) / (buyPx * (1 + fee))); if (n > 0) { const cost = n * buyPx, f = cost * fee; cash -= cost + f; feesPaid += f; spent += cost + f; qty += n; trades.push({ date: dates[i], side: 'BUY', price: buyPx, qty: n, fee: f }); } }
    } else {
      const target = i === 0 ? 0 : want[i - 1];   // yesterday's signal acts at today's close
      if (qty !== 0 && Math.sign(qty) !== target) close(i, px);
      if (qty === 0 && target !== 0) open(i, px, target);
    }
    if (qty !== 0) held++;
    equity.push([dates[i], cash + qty * px]);
  }
  // buy and hold with the same costs
  const bhBuy = closes[0] * (1 + slip), bhN = Math.floor(capital / (bhBuy * (1 + fee))), bhCash = capital - bhN * bhBuy * (1 + fee);
  const bh = closes.map((c, i) => [dates[i], bhCash + bhN * c]);
  const endVal = equity[equity.length - 1][1], bhEnd = bh[bh.length - 1][1];
  const years = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / (365.25 * 86400000);
  const wins = rounds.filter((r) => r.pnl > 0).length;
  const metrics = {
    finalValue: endVal, returnPct: ((endVal - capital) / capital) * 100, buyHoldPct: ((bhEnd - capital) / capital) * 100,
    excessPct: ((endVal - bhEnd) / capital) * 100, maxDrawdownPct: maxDrawdown(equity.map((e) => e[1])), buyHoldDrawdownPct: maxDrawdown(bh.map((e) => e[1])),
    roundTrips: rounds.length, winRatePct: rounds.length ? (wins / rounds.length) * 100 : null, avgTradePct: rounds.length ? rounds.reduce((a, r) => a + r.pct, 0) / rounds.length : null,
    exposurePct: (held / points.length) * 100, feesPaid, years, cagrPct: years >= 1 ? (Math.pow(endVal / capital, 1 / years) - 1) * 100 : null, days: points.length,
  };
  const last = instalments ? 1 : want[want.length - 1], changedAt = (() => { if (instalments) return null; for (let i = want.length - 1; i > 0; i--) if (want[i] !== want[i - 1]) return dates[i]; return null; })();
  return { key, params, equity, buyHold: bh, trades, rounds, metrics, today: { position: last === 1 ? 'long' : last === -1 ? 'short' : 'flat', since: changedAt, open: qty > 0 ? { qty, entry: entry ? entry.px : closes[closes.length - 1], date: entry ? entry.date : dates[0] } : null, invested: instalments ? spent : null } };
}

/** All strategies with their default parameters on the same data: the "how would the others have done" comparison. */
export function compareAll(points, opts) {
  return Object.keys(STRATEGIES).map((key) => { try { const r = backtest(points, key, defaultParams(key), opts); return { key, name: STRATEGIES[key].name, ...r.metrics, today: r.today.position }; } catch (e) { return { key, name: STRATEGIES[key].name, error: e.message }; } });
}
