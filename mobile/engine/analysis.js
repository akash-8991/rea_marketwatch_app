/* Technical, fundamental and sentiment scoring: a line-for-line port of src/marketlens/analysis.py.
 * Simple, transparent rule sets for exploration, not investment advice. The golden tests in mobile/tests compare
 * this file's output with the Python module's output on the same inputs. */

export const RULES = {
  techBand: 0.34, smaFast: 20, smaSlow: 50, rsiPeriod: 14, histMinCloses: 20,
  rsiBullLow: 55, rsiBullHigh: 70, rsiBearLow: 30, rsiBearHigh: 45,
  snapMomentumPct: 5, snapMomentumWeight: 1.5, snapRangeHigh: 66, snapRangeLow: 33, snapDayPct: 0.5, snapDayWeight: 0.5,
  sentBand: 0.15, sentNet: 2, sentMaxHeadlines: 8,
  incYieldMult: 1.5, incYearsFull: 3, incHigh: 0.5, incLow: 0.0,
};

/** Python's round(): decided on the exact binary value, exact ties go to the even neighbour.
 * toFixed() is exact for non-ties; a tie only happens when the expansion past digit d is exactly 5000... */
export function pyRound(x, d = 0) {
  if (!Number.isFinite(x)) return x;
  const long = Math.abs(x).toFixed(Math.min(d + 30, 100)), cut = long.length - 30;
  const tail = long.slice(cut);
  if (/^50*$/.test(tail)) {
    const kept = long.slice(0, cut), digits = kept.replace('.', ''), down = Number(kept);
    const r = Number(digits[digits.length - 1]) % 2 === 0 ? down : Number((down + 10 ** -d).toFixed(d));
    return x < 0 ? -r : r;
  }
  return Number(x.toFixed(d));
}

const truthy = (v) => v !== null && v !== undefined && v !== 0 && v !== '' && !Number.isNaN(v);

export const sma = (vals, n) => (vals.length >= n ? vals.slice(-n).reduce((a, b) => a + b, 0) / n : null);

export function emaSeries(vals, n) {
  if (!vals.length) return [];
  const k = 2 / (n + 1); let e = vals[0]; const out = [];
  for (const v of vals) { e = v * k + e * (1 - k); out.push(e); }
  return out;
}

export function rsi(closes, n = RULES.rsiPeriod) {
  if (closes.length <= n) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; gains += Math.max(d, 0); losses += Math.max(-d, 0); }
  let ag = gains / n, al = losses / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (al === 0) return 100.0;
  return 100 - 100 / (1 + ag / al);
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const f = emaSeries(closes, fast), s = emaSeries(closes, slow);
  const line = f.map((a, i) => a - s[i]);
  const sig = emaSeries(line, signal);
  const last = line.length - 1;
  return { macd: line[last], signal: sig[last], hist: line[last] - sig[last] };
}

const label = (score, pos = 'Bullish', neg = 'Bearish', mid = 'Neutral', band = RULES.techBand) => (score >= band ? pos : score <= -band ? neg : mid);

function combine(parts) {
  const total = parts.reduce((a, p) => a + p[2], 0) || 1;
  const score = parts.reduce((a, p) => a + p[1] * p[2], 0) / total;
  return [pyRound(score, 3), parts.map(([name, value, , note]) => ({ name, value, note }))];
}

const f2 = (x) => x.toFixed(2), f1 = (x) => x.toFixed(1);
const sgn = (x, d) => `${x >= 0 ? '+' : '-'}${Math.abs(x).toFixed(d)}`;

export function technicalFromHistory(closes, price = null) {
  const R = RULES;
  if (closes.length < R.histMinCloses) return null;
  if (price === null || price === undefined) price = closes[closes.length - 1];
  const fast = R.smaFast, slow = R.smaSlow;
  const s20 = sma(closes, fast), s50 = sma(closes, slow), r = rsi(closes), m = macd(closes);
  const parts = [[`Price vs SMA ${fast}`, price > s20 ? 1 : -1, 1, `price ${price > s20 ? 'above' : 'below'} the ${fast}-day average ${f2(s20)}`]];
  if (s50 !== null) parts.push([`SMA ${fast} vs SMA ${slow}`, s20 > s50 ? 1 : -1, 1, `${fast}-day ${s20 > s50 ? 'above' : 'below'} ${slow}-day average ${f2(s50)}`]);
  if (r !== null) {
    const v = R.rsiBullLow <= r && r < R.rsiBullHigh ? 1 : R.rsiBearLow <= r && r < R.rsiBearHigh ? -1 : 0;
    const note = r >= R.rsiBullHigh ? 'overbought, momentum may fade' : r < R.rsiBearLow ? 'oversold, momentum weak' : `RSI ${f1(r)}`;
    parts.push([`RSI (${R.rsiPeriod})`, v, 1, note]);
  }
  if (m !== null) parts.push(['MACD histogram', m.hist > 0 ? 1 : -1, 1, `MACD ${m.hist > 0 ? 'above' : 'below'} its signal line`]);
  const [score, signals] = combine(parts);
  return {
    basis: `${closes.length} daily closes`, score, label: label(score), rsi: truthy(r) ? pyRound(r, 1) : r,
    sma20: pyRound(s20, 2), sma50: truthy(s50) ? pyRound(s50, 2) : s50, macdHist: truthy(m) ? pyRound(m.hist, 3) : m, signals,
  };
}

export function technicalSnapshot(s) {
  const R = RULES;
  const price = s.price, prev = s.prev || s.prevClose, hi = s.hi52, lo = s.lo52, p30 = s.pct30;
  const parts = [];
  if (p30 !== null && p30 !== undefined) {
    const m = R.snapMomentumPct;
    parts.push(['30-day change', p30 > m ? 1 : p30 < -m ? -1 : 0, R.snapMomentumWeight, `${sgn(p30, 1)}% over 30 days`]);
  }
  if (price && hi && lo && hi > lo) {
    const pos = ((price - lo) / (hi - lo)) * 100;
    parts.push(['52-week position', pos >= R.snapRangeHigh ? 1 : pos <= R.snapRangeLow ? -1 : 0, 1, `${pyRound(pos, 0).toFixed(0)}% of the 52-week range`]);
  }
  if (price && prev) {
    const d = ((price - prev) / prev) * 100;
    parts.push(['Day change', d > R.snapDayPct ? 1 : d < -R.snapDayPct ? -1 : 0, R.snapDayWeight, `${sgn(d, 2)}% today`]);
  }
  if (!parts.length) return null;
  const [score, signals] = combine(parts);
  return { basis: 'single quote (no history loaded yet)', score, label: label(score), signals };
}

/* ---------- fundamental (limited to what NSE publishes) ---------- */
export const SECTOR_INDEX = {
  Banking: 'nifty bank', IT: 'nifty it', Auto: 'nifty auto', Pharma: 'nifty pharma', FMCG: 'nifty fmcg', Metals: 'nifty metal',
  Energy: 'nifty energy', Realty: 'nifty realty', Media: 'nifty media', 'Financial services': 'nifty financial services',
};

export function valuationContext(boot) {
  const val = {};
  (boot.valuation || []).forEach((v) => { if (v.name) val[v.name.toLowerCase()] = v; });
  const base = val['nifty 50'] || {};
  const sectors = {};
  Object.entries(SECTOR_INDEX).forEach(([sec, name]) => { if (val[name]) sectors[sec] = val[name]; });
  return { benchYield: base.divYield ?? null, benchPE: base.pe ?? null, sectors };
}

const isoDay = (d) => d.toISOString().slice(0, 10);

export function fundamental(divTtm, price, actions, sector = null, ctx = null, today = null) {
  ctx = ctx || {};
  today = today || new Date();
  const list = actions || [];
  const divs = list.filter((a) => a.actionType === 'DIVIDEND' && a.exDate);
  const cutoff = isoDay(new Date(today.getTime() - (3 * 365 + 5) * 86400000));
  const years = new Set(divs.filter((a) => a.exDate >= cutoff).map((a) => a.exDate.slice(0, 4)));
  const yld = truthy(divTtm) && truthy(price) ? pyRound((divTtm / price) * 100, 2) : divTtm === 0 ? 0.0 : null;
  const bonus = list.filter((a) => ['BONUS', 'SPLIT', 'STOCK SPLIT'].includes(a.actionType)).length;
  const sec = (ctx.sectors || {})[sector || ''] || {};
  const secOut = { sectorPE: sec.pe ?? null, sectorPB: sec.pb ?? null, sectorYield: sec.divYield ?? null };
  if (yld === null && !divs.length) return { label: 'No data', score: null, yield: null, signals: [], basis: 'no corporate-action data loaded yet', ...secOut };
  const bench = ctx.benchYield;
  const parts = [];
  if (yld !== null && bench) {
    parts.push(['Dividend yield vs Nifty 50', yld >= RULES.incYieldMult * bench ? 1 : yld > 0 ? 0 : -1, 1, yld ? `${f2(yld)}% vs index ${f2(bench)}%` : 'no dividend in the last 12 months']);
  }
  const consistency = years.size;
  parts.push(['Dividend consistency', consistency >= RULES.incYearsFull ? 1 : consistency === RULES.incYearsFull - 1 ? 0.5 : consistency === 1 ? 0 : -1, 1, `dividends in ${consistency} of the last 3 calendar years`]);
  const [score, signals] = combine(parts);
  const lab = score >= RULES.incHigh ? 'Income-oriented' : score >= RULES.incLow ? 'Moderate income' : 'Little or no dividend income';
  return { label: lab, score, yield: yld, dividendsTtm: divTtm, dividendYears: consistency, bonusOrSplit: bonus, signals,
    basis: 'dividends and corporate actions published by NSE; no earnings, debt or growth data', ...secOut };
}

/* ---------- sentiment (headline lexicon) ---------- */
const words = (s) => new Set(s.split(/\s+/).filter(Boolean));
export const POSITIVE = words(`surge surges surged rally rallies rallied gain gains gained jump jumps jumped soar soars soared rise rises rose higher
record beat beats upgrade upgrades upgraded bullish strong strength growth profit profits outperform outperforms boost boosts boosted win wins
won expands expansion recovery recover recovers rebound rebounds rebounded positive optimism optimistic approval approves approved
breakthrough upbeat robust improves improved improving buyback surpass surpasses`);
export const NEGATIVE = words(`fall falls fell drop drops dropped slump slumps slumped plunge plunges plunged tumble tumbles tumbled sink sinks sank slip slips
slipped lower loss losses miss misses missed downgrade downgrades downgraded bearish weak weakness fear fears crash crashes probe fraud penalty
fine fined lawsuit default cuts cut warns warning warn concern concerns risk risks decline declines declined layoffs resigns ban banned delay
delays selloff sell-off pressure pressured volatile uncertainty hike slowdown`);
const NEGATORS = new Set(['not', 'no', 'never', 'without', 'fails', 'fail', 'failed', 'unlikely']);

export function headlineScore(text) {
  const toks = (String(text || '').toLowerCase().match(/[a-z][a-z\-']*/g)) || [];
  let pos = 0, neg = 0;
  toks.forEach((t, i) => {
    if (t === 'record' && i + 1 < toks.length && (toks[i + 1] === 'date' || toks[i + 1] === 'dates')) return;
    const flipped = i > 0 && NEGATORS.has(toks[i - 1]);
    if (POSITIVE.has(t)) { if (flipped) neg++; else pos++; } else if (NEGATIVE.has(t)) { if (flipped) pos++; else neg++; }
  });
  const n = pos + neg;
  return [n ? (pos - neg) / n : 0.0, pos, neg];
}

export function sentimentLabel(score, pos, neg) {
  if (score === null || score === undefined) return 'No news';
  const net = pos - neg, band = RULES.sentBand, need = RULES.sentNet;
  return score >= band && net >= need ? 'Positive' : score <= -band && net <= -need ? 'Negative' : 'Neutral';
}

export function sentiment(headlines) {
  const scores = headlines.filter(Boolean).map(headlineScore);
  if (!scores.length) return { score: null, label: 'No news', n: 0, pos: 0, neg: 0 };
  const avg = scores.reduce((a, s) => a + s[0], 0) / scores.length;
  const pos = scores.filter((s) => s[0] > 0).length, neg = scores.filter((s) => s[0] < 0).length;
  return { score: pyRound(avg, 3), label: sentimentLabel(avg, pos, neg), n: scores.length, pos, neg };
}
