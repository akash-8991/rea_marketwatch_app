/* The browser side of the backtest gate: fetch up to ten years of daily history, pick and evaluate the strategy (backtest-gate.js does the maths), and draw the report that is
 * shown before a trade. The report states how many years NSE actually provided: ten are requested, whatever exists is used, and the gate fails when there is too little. */
import { esc, money, api } from './lib.js';
import { dailyCandles, indicators, analyse } from './ta.js';
import { selectStrategy, evaluate, gateDecision, summary } from './backtest-gate.js';

const pct = (x, d = 1) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}%`), tone = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');

/** Ten years of daily points [date, close, volume, open, high, low]. The server fetches NSE's history in three-month pieces (about 30 s the first time, then saved). */
export async function fetchHistory(sym, onSlow) {
  const t = setTimeout(() => onSlow && onSlow(), 4000);
  try { const h = await api(`/api/history/${encodeURIComponent(sym)}?range=10Y`, { quiet: true, retries: 1, timeoutMs: 180000 }); if (!h.available) throw new Error(h.reason || 'no price history'); return h; } finally { clearTimeout(t); }
}

/** Run the gate for a symbol: history -> candidate strategies -> best by out-of-sample result -> verdict. `pick` forces one strategy. Returns {points, rep, ranked, summary, candles}. */
export async function validateSymbol(sym, gate, { pick = null, onSlow } = {}) {
  const h = await fetchHistory(sym, onSlow), points = h.points;
  if (points.length < 120) throw new Error('not enough history to backtest (under 120 trading days)');
  let rep, ranked;
  if (pick) { rep = evaluate(points, pick, null, gate); rep.gate = gateDecision(rep, gate); ranked = [rep]; } else { const s = selectStrategy(points, gate); rep = s.best; ranked = s.ranked; }
  if (!rep) throw new Error('no strategy could be evaluated on this history');
  const candles = dailyCandles(points), ind = indicators(candles), an = analyse(candles, ind, '1D');
  return { points, candles, ind, an, rep, ranked, summary: summary(rep, gate), earliest: h.earliest, truncated: h.truncated };
}

/** The report shown before a trade (HTML for the dialog and for the Signals page). */
export function reportHtml(rep, gate, ranked = []) {
  const c = rep.coverage, f = rep.full, o = rep.outOfSample, verdict = rep.gate.pass ? '<span class="state ok">PASSES the gate</span>' : '<span class="state bad">BLOCKED by the gate</span>';
  const cell = (l, v, t = '') => `<div class="kpi"><small>${esc(l)}</small><b class="${t}">${v}</b></div>`;
  return `<div class="note" style="margin-bottom:.5rem"><b>${esc(rep.name)}</b> (${esc(rep.group || '')}) · ${verdict} · today it says <b>${esc(rep.today.position)}</b>${rep.today.since ? ` since ${esc(rep.today.since)}` : ''}</div>
    <div class="note">History used: <b>${c.years.toFixed(1)} years</b> (${esc(c.from)} to ${esc(c.to)}, ${c.days.toLocaleString('en-IN')} trading days) of the ${c.requestedYears} asked for. Costs ${gate.feePct}% fee + ${gate.slipPct}% slippage per trade; ₹${(gate.capital).toLocaleString('en-IN')} start; signals act on the next close; default settings, nothing tuned.</div>
    <div class="desk-kpis" style="margin-top:.5rem">${cell('Return', pct(f.returnPct, 0), tone(f.returnPct))}${cell('Per year', pct(f.cagrPct), tone(f.cagrPct))}${cell('Buy and hold', pct(f.buyHoldPct, 0), tone(f.buyHoldPct))}${cell('Worst fall', pct(f.maxDrawdownPct), 'down')}${cell('Trades', f.trades)}${cell('Winners', f.winRatePct == null ? '—' : `${f.winRatePct.toFixed(0)}%`)}${cell('Sharpe', f.sharpe == null ? '—' : f.sharpe.toFixed(2))}${cell(`Last ${Math.round(gate.oosShare * 100)}% (unseen)`, pct(o.returnPct), tone(o.returnPct))}</div>
    <div class="note">Four consecutive periods: ${rep.folds.map((x) => `<span class="${tone(x.returnPct)}">${pct(x.returnPct, 0)}</span>`).join(' · ')}</div>
    <div class="scroll"><table class="tbl"><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rep.gate.checks.map((k) => `<tr><td>${esc(k.code)}</td><td><span class="state ${k.ok ? 'ok' : 'bad'}">${k.ok ? 'pass' : 'fail'}</span></td><td class="note">${esc(k.detail)}</td></tr>`).join('')}</tbody></table></div>
    ${ranked.length > 1 ? `<div class="note" style="margin-top:.5rem">Strategies tried: ${ranked.slice(0, 6).map((r) => `${esc(r.name)} (${pct(r.outOfSample.returnPct, 0)} unseen, ${r.gate.pass ? 'pass' : 'fail'})`).join(' · ')}. Chosen by the unseen-period result per unit of drawdown among those that trade enough.</div>` : ''}
    <div class="note" style="margin-top:.5rem">A backtest describes the past of this one stock; it is evidence, not a forecast.</div>`;
}
