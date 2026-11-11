/* The backtest gate: before any trade, the strategy that would make it is run over up to ten years of NSE daily history (with fees and slippage, acting on the next close, no look-ahead),
 * the result is shown to you, and the trade is blocked unless the result clears configurable thresholds. Pure functions: the Signals page fetches the history and draws the report; the
 * risk engine (desk-core.js) enforces the gate.
 *
 * Honesty rules built in:
 *   - "Ten years" is what is asked for. NSE returns what it has; the report states the years actually covered and the gate fails when coverage is below the minimum.
 *   - A strategy is chosen by its out-of-sample result (the last 30 percent of the period, unseen when the parameters were fixed: they are the strategy's defaults, nothing is tuned here),
 *     and consistency across four consecutive periods is reported, so one lucky stretch cannot carry a verdict.
 *   - A backtest describes the past on one stock. It is evidence, not a forecast. */
import { STRATEGIES, backtest, defaultParams } from './strategies.js';

export const GATE_DEFAULT = {
  requireBacktest: true, years: 10, minYearsCovered: 3, minTrades: 8, maxDrawdownPct: 45, minOosReturnPct: 0, minPositiveFolds: 2, oosShare: 0.3, validHours: 24,
  capital: 1_000_000, feePct: 0.1, slipPct: 0.05,
  candidates: ['sma_cross', 'ema_cross', 'macd_cross', 'price_sma', 'supertrend', 'adx_dmi', 'psar', 'donchian', 'turtle', 'momentum', 'tsmom', 'near_high', 'rsi2', 'bollinger', 'aroon', 'heikin', 'chandelier', 'ichimoku'],
};

const YEAR = 365.25 * 86400000;
const dd = (eq) => { let peak = -Infinity, worst = 0; for (const v of eq) { peak = Math.max(peak, v); worst = Math.min(worst, (v - peak) / peak); } return worst * 100; };
const sharpe = (eq) => { if (eq.length < 30) return null; const r = []; for (let i = 1; i < eq.length; i++) r.push(eq[i] / eq[i - 1] - 1); const m = r.reduce((a, b) => a + b, 0) / r.length, v = r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length; return v > 0 ? (m / Math.sqrt(v)) * Math.sqrt(252) : null; };

/** Metrics of one stretch of a finished backtest, from index `a` to `b` of its equity curve and the trades inside it. */
function segment(r, a, b) {
  const eq = r.equity.slice(a, b + 1).map((e) => e[1]), t0 = r.equity[a][0], t1 = r.equity[b][0], years = (Date.parse(t1) - Date.parse(t0)) / YEAR;
  const trades = r.trades.filter((t) => t.date >= t0 && t.date <= t1 && t.pnl != null), wins = trades.filter((t) => t.pnl > 0).length, ret = (eq[eq.length - 1] / eq[0] - 1) * 100;
  return { from: t0, to: t1, years, returnPct: ret, cagrPct: years >= 1 ? (Math.pow(eq[eq.length - 1] / eq[0], 1 / years) - 1) * 100 : null, maxDrawdownPct: dd(eq), sharpe: sharpe(eq), trades: trades.length, winRatePct: trades.length ? (wins / trades.length) * 100 : null };
}

/** One strategy over the whole history: full-period, in-sample and out-of-sample results, four-fold consistency, yearly returns, and today's position. */
export function evaluate(points, key, params = null, gate = GATE_DEFAULT) {
  const S = STRATEGIES[key]; if (!S) throw new Error(`unknown strategy ${key}`);
  const p = params || defaultParams(key), r = backtest(points, key, p, { capital: gate.capital, feePct: gate.feePct, slipPct: gate.slipPct }), n = r.equity.length;
  const split = Math.max(10, Math.floor(n * (1 - gate.oosShare))), full = segment(r, 0, n - 1), ins = segment(r, 0, split), oos = segment(r, split, n - 1);
  const folds = Array.from({ length: 4 }, (_, k) => segment(r, Math.floor((n * k) / 4), Math.max(Math.floor((n * k) / 4) + 1, Math.floor((n * (k + 1)) / 4) - 1)));
  const yearly = {}; for (let i = 1; i < n; i++) { const y = r.equity[i][0].slice(0, 4); (yearly[y] ||= [r.equity[i - 1][1], r.equity[i][1]])[1] = r.equity[i][1]; }
  const bh = r.buyHold.map((e) => e[1]), bhRet = (bh[bh.length - 1] / bh[0] - 1) * 100, bhOos = (bh[n - 1] / bh[split] - 1) * 100;
  const dates = r.equity.map((e) => e[0]), first = dates[0], last = dates[n - 1], years = (Date.parse(last) - Date.parse(first)) / YEAR;
  return { key, name: S.name, group: S.group, params: p, shorts: !!S.shorts, coverage: { requestedYears: gate.years, years, from: first, to: last, days: n }, full: { ...full, buyHoldPct: bhRet, trades: r.metrics.roundTrips, winRatePct: r.metrics.winRatePct, avgTradePct: r.metrics.avgTradePct, exposurePct: r.metrics.exposurePct, feesPaid: r.metrics.feesPaid },
    inSample: ins, outOfSample: { ...oos, buyHoldPct: bhOos }, folds, yearly: Object.entries(yearly).map(([y, [a, b]]) => [y, (b / a - 1) * 100]), today: { position: r.today.position, since: r.today.since }, inputs: { points: n, first, last } };
}

/** Apply the thresholds. Returns {pass, checks:[{code, ok, detail}]}; every check is reported, none is skipped. */
export function gateDecision(rep, gate = GATE_DEFAULT) {
  const c = [], add = (code, ok, detail) => c.push({ code, ok: !!ok, detail });
  add('COVERAGE', rep.coverage.years >= gate.minYearsCovered, `${rep.coverage.years.toFixed(1)} years of history (of ${gate.years} asked for; at least ${gate.minYearsCovered} needed)`);
  add('TRADES', rep.full.trades >= gate.minTrades, `${rep.full.trades} closed trades (at least ${gate.minTrades})`);
  add('OUT_OF_SAMPLE_RETURN', rep.outOfSample.returnPct > gate.minOosReturnPct, `${rep.outOfSample.returnPct.toFixed(1)}% over the last ${Math.round(gate.oosShare * 100)}% of the period (above ${gate.minOosReturnPct}% needed)`);
  add('DRAWDOWN', rep.full.maxDrawdownPct >= -gate.maxDrawdownPct, `worst fall ${rep.full.maxDrawdownPct.toFixed(1)}% (no worse than -${gate.maxDrawdownPct}%)`);
  add('CONSISTENCY', rep.folds.filter((f) => f.returnPct > 0).length >= gate.minPositiveFolds, `${rep.folds.filter((f) => f.returnPct > 0).length} of 4 consecutive periods were profitable (at least ${gate.minPositiveFolds})`);
  return { pass: c.every((x) => x.ok), checks: c, failed: c.filter((x) => !x.ok).map((x) => x.code) };
}

/** Rank the candidate strategies by out-of-sample return per unit of drawdown (among those that trade enough), and return the best with the gate's verdict. Nothing is tuned: defaults only. */
export function selectStrategy(points, gate = GATE_DEFAULT, candidates = gate.candidates) {
  const reps = [];
  for (const k of candidates) { try { const r = evaluate(points, k, null, gate); reps.push({ ...r, gate: gateDecision(r, gate), score: r.outOfSample.returnPct / Math.max(5, Math.abs(r.full.maxDrawdownPct)) }); } catch (e) { /* a strategy that cannot run on this history is skipped */ }
  }
  reps.sort((a, b) => (b.gate.pass - a.gate.pass) || (b.score - a.score));
  return { best: reps[0] || null, ranked: reps, tried: candidates.length };
}

/** The compact record that travels with a trade intent and goes into the audit log: verdict, headline numbers, inputs. No equity curve. */
export function summary(rep, gate, at = Date.now()) {
  return { at, strategy: rep.key, name: rep.name, params: rep.params, pass: rep.gate.pass, failed: rep.gate.failed, checks: rep.gate.checks, signal: rep.today.position, since: rep.today.since, coverage: rep.coverage,
    full: { returnPct: rep.full.returnPct, cagrPct: rep.full.cagrPct, maxDrawdownPct: rep.full.maxDrawdownPct, sharpe: rep.full.sharpe, trades: rep.full.trades, winRatePct: rep.full.winRatePct, buyHoldPct: rep.full.buyHoldPct },
    outOfSample: { from: rep.outOfSample.from, returnPct: rep.outOfSample.returnPct, maxDrawdownPct: rep.outOfSample.maxDrawdownPct, trades: rep.outOfSample.trades, buyHoldPct: rep.outOfSample.buyHoldPct },
    folds: rep.folds.map((f) => f.returnPct), inputs: rep.inputs, costs: { feePct: gate.feePct, slipPct: gate.slipPct }, validUntil: at + gate.validHours * 3600e3 };
}
