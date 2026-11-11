/* Fundamental screens and a scorecard, from the data NSE's feeds actually provide: dividend yield and its consistency, position in the 52-week range, the 30-day move, traded value, and the
 * sector index's valuation (P/E, P/B, yield). NSE's tools publish no financial statements (no earnings, margins, debt or cash flow), so screens that need them (Piotroski F-score, Graham
 * number, magic formula, DuPont, DCF) cannot be computed honestly and are listed in UNAVAILABLE instead of being faked. Pure functions: the page only draws them. */

export const pos52 = (s) => (s.hi52 > s.lo52 && s.price ? ((s.price - s.lo52) / (s.hi52 - s.lo52)) * 100 : null);
const yld = (s) => (s.div != null ? s.div : s.fund && s.fund.yield != null ? s.fund.yield : null);
const years = (s) => (s.fund && s.fund.dividendYears != null ? s.fund.dividendYears : null);
const secYield = (s) => (s.fund && s.fund.sectorYield != null ? s.fund.sectorYield : null);
const clamp = (x, a = 0, b = 100) => Math.min(b, Math.max(a, x));

/** The 0 to 100 scorecard: value (low in its range, cheap against the sector's yield), income (yield against the index and years of dividends), momentum (30-day move and range position), liquidity. */
export function scorecard(s, ctx = {}) {
  const p = pos52(s), y = yld(s), bench = ctx.benchYield || 1.2, sy = secYield(s), parts = [];
  const value = p == null && y == null ? null : clamp((p == null ? 50 : 100 - p) * 0.6 + (y != null && sy ? clamp((y / sy) * 50) : 25) * 0.4);
  const income = y == null ? null : clamp((y / (bench * 2)) * 70 + (years(s) != null ? (years(s) / 3) * 30 : 10));
  const momentum = s.pct30 == null && p == null ? null : clamp(50 + (s.pct30 ?? 0) * 2.5) * 0.6 + (p == null ? 50 : p) * 0.4;
  const liquidity = s.valueCr > 0 ? clamp((Math.log10(s.valueCr) + 1) * 28) : null;
  for (const [name, v, w] of [['Value', value, 0.3], ['Income', income, 0.25], ['Momentum', momentum, 0.25], ['Liquidity', liquidity, 0.2]]) if (v != null) parts.push({ name, value: Math.round(v), weight: w });
  const W = parts.reduce((a, x) => a + x.weight, 0);
  return { total: W ? Math.round(parts.reduce((a, x) => a + x.value * x.weight, 0) / W) : null, parts };
}

const reason = (...a) => a.filter(Boolean).join(' · ');
export const SCREENS = {
  income: { name: 'Dividend income', idea: 'Stocks that pay a dividend yield well above the Nifty 50\'s, ranked by yield.', basis: 'Dividend yield (last 12 months) against the index yield; needs corporate-action data.',
    pass: (s, c) => yld(s) != null && c.benchYield && yld(s) >= 1.5 * c.benchYield, score: (s) => yld(s), why: (s, c) => `yield ${yld(s).toFixed(2)}% vs index ${c.benchYield.toFixed(2)}%` },
  aristocrat: { name: 'Steady dividend payers', idea: 'Paid a dividend in each of the last three calendar years and yields at least the index.', basis: 'Dividend consistency (years of three) and yield.',
    pass: (s, c) => years(s) === 3 && yld(s) != null && yld(s) >= (c.benchYield || 0), score: (s) => yld(s), why: (s) => `dividends in ${years(s)} of 3 years · yield ${yld(s).toFixed(2)}%` },
  sector_yield: { name: 'Yield above its sector', idea: 'Pays a higher yield than its own sector index: relatively cheap income inside the sector.', basis: 'Stock yield against the sector index yield.',
    pass: (s) => yld(s) != null && secYield(s) != null && yld(s) > secYield(s) * 1.3, score: (s) => yld(s) / secYield(s), why: (s) => `${yld(s).toFixed(2)}% vs sector ${secYield(s).toFixed(2)}%` },
  near_low: { name: 'Near the 52-week low, paying income', idea: 'Priced in the bottom quarter of its yearly range and still paying a dividend: a value watch-list (a low price can also mean trouble).', basis: '52-week position and dividend yield.',
    pass: (s) => pos52(s) != null && pos52(s) <= 25 && yld(s) > 0, score: (s) => 100 - pos52(s), why: (s) => `${pos52(s).toFixed(0)}% of the way up its range · yield ${yld(s).toFixed(2)}%` },
  quality_momentum: { name: 'Leaders: near the high, rising, paying', idea: 'In the top fifth of its yearly range, up over 30 days, and a dividend payer: strength with some income behind it.', basis: '52-week position, 30-day change, dividend yield.',
    pass: (s) => pos52(s) != null && pos52(s) >= 80 && (s.pct30 || 0) > 0 && yld(s) > 0, score: (s) => (s.pct30 || 0) + pos52(s) / 10, why: (s) => `${pos52(s).toFixed(0)}% of range · 30d ${s.pct30 >= 0 ? '+' : ''}${s.pct30.toFixed(1)}%` },
  oversold_income: { name: 'Beaten down but steady', idea: 'Down over 30 days yet a consistent dividend payer: a contrarian screen that needs a look at the news before anything else.', basis: '30-day change and dividend consistency.',
    pass: (s) => (s.pct30 ?? 0) <= -8 && years(s) >= 2, score: (s) => -s.pct30, why: (s) => `30d ${s.pct30.toFixed(1)}% · dividends in ${years(s)} of 3 years` },
  scorecard: { name: 'Composite scorecard', idea: 'Every stock scored 0 to 100 on value, income, momentum and liquidity, ranked.', basis: 'The four components above, weighted 30/25/25/20; missing components are skipped, not guessed.',
    pass: (s, c) => scorecard(s, c).total != null, score: (s, c) => scorecard(s, c).total, why: (s, c) => scorecard(s, c).parts.map((p) => `${p.name} ${p.value}`).join(' · ') },
};

export const UNAVAILABLE = [
  ['Piotroski F-score, Altman Z, Beneish M', 'needs balance sheet, income statement and cash-flow data'], ['Graham number, margin of safety, DCF', 'needs earnings per share, book value and growth forecasts'],
  ['Magic formula, ROIC, ROE, DuPont', 'needs operating profit, capital employed and equity'], ['PEG, earnings revisions, surprise', 'needs earnings and analyst estimates'],
  ['Debt to equity, interest cover, free cash flow yield', 'needs leverage and cash-flow statements'],
];

/** Run one screen over the stocks; returns [{stock, score, why}] best first. */
export function runScreen(key, stocks, ctx = {}) {
  const sc = SCREENS[key]; if (!sc) throw new Error(`unknown screen ${key}`);
  return stocks.filter((s) => { try { return sc.pass(s, ctx); } catch (e) { return false; } }).map((s) => ({ stock: s, score: sc.score(s, ctx), why: sc.why(s, ctx) })).filter((r) => Number.isFinite(r.score)).sort((a, b) => b.score - a.score);
}

/** Sector valuation table from the index rows (P/E, P/B, yield) against the Nifty 50: which sectors are priced above or below the market. */
export function sectorValuation(valuation) {
  const bench = valuation.find((v) => /^nifty 50$/i.test(v.name)), rows = valuation.filter((v) => v.pe && v.pb != null).map((v) => ({ name: v.name, pe: v.pe, pb: v.pb, yield: v.divYield, peVsBench: bench && bench.pe ? ((v.pe / bench.pe - 1) * 100) : null }));
  return rows.sort((a, b) => a.pe - b.pe);
}
