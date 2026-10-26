/* Option-strategy lab for learning: build any textbook strategy from a real option chain and see what it would cost, what it can make and lose, where it breaks
 * even and how it behaves as time passes. Pure functions (no DOM, no network): the paper-trading view feeds them the chain from /api/options.
 *
 * What is real and what is modelled:
 *   - Strikes and premiums come from the chain (the last traded price of each contract in NSE's latest end-of-day file). A missing price is estimated with
 *     Black-Scholes and flagged.
 *   - The payoff at expiry is exact arithmetic on those premiums.
 *   - "Today", the Greeks and the chance of profit are Black-Scholes model estimates (7% interest, no dividends, each contract's own implied volatility):
 *     a way to see the shape of a position, not a forecast.
 * Costs (brokerage, STT, margin) are not modelled. Index options are cash-settled and stock options physically settled on NSE; this lab shows the money result only. */

export const RISK_FREE = 0.07;
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const pdf = (x) => Math.exp(-x * x / 2) / SQRT_2PI;
/** Standard normal cumulative distribution (Abramowitz and Stegun 26.2.17, error below 1e-7). */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x)), p = pdf(x) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

const d12 = (S, K, T, v, r) => { const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)); return [d1, d1 - v * Math.sqrt(T)]; };
/** Black-Scholes price of a European option ('C' or 'P'); at or after expiry (T <= 0) its intrinsic value. */
export function bsPrice(kind, S, K, T, v, r = RISK_FREE) {
  if (T <= 0 || !(v > 0) || S <= 0) return Math.max(kind === 'C' ? S - K : K - S, 0);
  const [d1, d2] = d12(S, K, T, v, r), disc = K * Math.exp(-r * T);
  return kind === 'C' ? S * normCdf(d1) - disc * normCdf(d2) : disc * normCdf(-d2) - S * normCdf(-d1);
}
/** Delta, gamma, theta (per calendar day) and vega (per volatility point) of one option. */
export function greeks(kind, S, K, T, v, r = RISK_FREE) {
  if (T <= 0 || !(v > 0) || S <= 0) return { delta: kind === 'C' ? (S > K ? 1 : 0) : (S < K ? -1 : 0), gamma: 0, theta: 0, vega: 0 };
  const [d1, d2] = d12(S, K, T, v, r), sq = Math.sqrt(T), disc = K * Math.exp(-r * T), base = -(S * pdf(d1) * v) / (2 * sq);
  return {
    delta: kind === 'C' ? normCdf(d1) : normCdf(d1) - 1, gamma: pdf(d1) / (S * v * sq),
    theta: (kind === 'C' ? base - r * disc * normCdf(d2) : base + r * disc * normCdf(-d2)) / 365, vega: (S * pdf(d1) * sq) / 100,
  };
}

/* ---------- the strategy catalogue ----------
 * A leg is [kind, side, offset, expiry]: kind C = call, P = put, U = the underlying itself (futures or shares); side +1 buy / -1 sell; offset = number of strike
 * steps from the at-the-money strike (scaled by the "width" setting); expiry 0 = the chosen expiry, 1 = the next one (calendar and diagonal spreads). */
const T = (group, name, legs, [outlook, idea, whenToUse, maxGain, maxLoss, lesson]) => ({ group, name, legs, outlook, idea, whenToUse, maxGain, maxLoss, lesson });
export const OPTION_STRATEGIES = {
  long_underlying: T('Single position', 'Long underlying (benchmark)', [['U', 1, 0]], ['Bullish', 'Simply own the index future or the shares. The yardstick: every option strategy is a reshaping of this straight line.', 'You expect a rise and accept losses if it falls.', 'Unlimited', 'Large (price to zero)', 'Options let you trade the straight line for a shape that fits your view.']),
  short_underlying: T('Single position', 'Short underlying (benchmark)', [['U', -1, 0]], ['Bearish', 'Sell the future (or borrowed shares) and buy back lower.', 'You expect a fall.', 'Large (price to zero)', 'Unlimited', 'A short has unlimited risk, which is why a defined-risk put spread is often preferred.']),
  long_call: T('Single position', 'Long call', [['C', 1, 0]], ['Bullish', 'Buy the right to buy at a fixed strike. Pay a premium; gain if the price rises beyond strike plus premium.', 'You expect a sharp rise soon and want a known maximum loss.', 'Unlimited', 'The premium paid', 'Time works against you every day (theta): being right too slowly still loses.']),
  long_put: T('Single position', 'Long put', [['P', 1, 0]], ['Bearish', 'Buy the right to sell at a fixed strike. Gain if the price falls below strike minus premium.', 'You expect a fall, or want insurance on holdings.', 'Large (strike minus premium)', 'The premium paid', 'Puts are the simplest hedge: the premium is the insurance cost.']),
  short_call: T('Single position', 'Short (naked) call', [['C', -1, 1]], ['Bearish / neutral', 'Sell a call and keep the premium if the price stays below the strike.', 'You expect the price to stay flat or fall; experienced traders only.', 'The premium received', 'Unlimited', 'You collect small amounts for taking a rare but unlimited loss.']),
  cash_put: T('Single position', 'Short (cash-secured) put', [['P', -1, -1]], ['Neutral / bullish', 'Sell a put below the market: you are paid to agree to buy at that lower price.', 'You would be happy to own the stock cheaper, and expect it to stay above the strike.', 'The premium received', 'Large (strike minus premium)', 'Selling puts is like selling insurance: steady small income, occasional large claims.']),
  bull_call: T('Vertical spreads', 'Bull call spread', [['C', 1, 0], ['C', -1, 2]], ['Bullish', 'Buy a call and sell a higher call to cut the cost, giving up gains above the higher strike.', 'You expect a moderate rise.', 'Difference of strikes minus the net premium', 'The net premium paid', 'Capping the upside is what makes the position cheaper and its loss known.']),
  bear_put: T('Vertical spreads', 'Bear put spread', [['P', 1, 0], ['P', -1, -2]], ['Bearish', 'Buy a put and sell a lower put to cut the cost.', 'You expect a moderate fall.', 'Difference of strikes minus the net premium', 'The net premium paid', 'The mirror image of the bull call spread.']),
  bull_put: T('Vertical spreads', 'Bull put spread (credit)', [['P', -1, 0], ['P', 1, -2]], ['Bullish / neutral', 'Sell a put and buy a lower put as protection; you receive a net credit and keep it if the price stays above the sold strike.', 'You expect the price to hold or rise.', 'The net premium received', 'Difference of strikes minus the credit', 'Credit spreads win often and lose big: the odds are in your favour and the payoff against you.']),
  bear_call: T('Vertical spreads', 'Bear call spread (credit)', [['C', -1, 0], ['C', 1, 2]], ['Bearish / neutral', 'Sell a call and buy a higher call as protection; keep the credit if the price stays below the sold strike.', 'You expect the price to hold or fall.', 'The net premium received', 'Difference of strikes minus the credit', 'Defined risk is the price of sleeping well.']),
  risk_reversal_up: T('Vertical spreads', 'Bullish risk reversal', [['P', -1, -1], ['C', 1, 1]], ['Bullish', 'Sell an out-of-the-money put to pay for an out-of-the-money call.', 'You are bullish and willing to buy the dip.', 'Unlimited', 'Large (put side)', 'Often costs almost nothing, which is not the same as being free: the risk is on the downside.']),
  risk_reversal_down: T('Vertical spreads', 'Bearish risk reversal', [['C', -1, 1], ['P', 1, -1]], ['Bearish', 'Sell an out-of-the-money call to pay for an out-of-the-money put.', 'You are bearish and accept the risk of a rally.', 'Large (put side)', 'Unlimited', 'Financing a bet by selling the other side doubles the exposure.']),
  synthetic_long: T('Synthetic', 'Synthetic long (call + put)', [['C', 1, 0], ['P', -1, 0]], ['Bullish', 'Buy a call and sell a put at the same strike: behaves like owning the underlying, using little capital.', 'You want stock-like exposure through options.', 'Unlimited', 'Large (price to zero)', 'Put-call parity: two options can replicate the underlying exactly.']),
  synthetic_short: T('Synthetic', 'Synthetic short (put + call)', [['P', 1, 0], ['C', -1, 0]], ['Bearish', 'Buy a put and sell a call at the same strike: behaves like being short the underlying.', 'You want short exposure without borrowing shares.', 'Large (price to zero)', 'Unlimited', 'Same parity relationship, in reverse.']),
  covered_call: T('Income and hedging', 'Covered call', [['U', 1, 0], ['C', -1, 2]], ['Neutral / mildly bullish', 'Own the underlying and sell a call against it for income; give up gains above the strike.', 'You hold shares and expect little upside.', 'Strike minus entry, plus premium', 'Large (price to zero, softened by the premium)', 'Income now in exchange for upside later.']),
  protective_put: T('Income and hedging', 'Protective put (married put)', [['U', 1, 0], ['P', 1, -1]], ['Bullish with insurance', 'Own the underlying and buy a put to cap the loss.', 'You hold shares and fear a drop, but do not want to sell.', 'Unlimited', 'Entry minus strike, plus premium', 'Insurance has a cost; this is the cleanest definition of a hedge.']),
  collar: T('Income and hedging', 'Collar', [['U', 1, 0], ['P', 1, -2], ['C', -1, 2]], ['Neutral', 'Own the underlying, buy a put for protection and sell a call to pay for it.', 'You want to hold through uncertainty at near-zero cost.', 'Call strike minus entry, adjusted for net premium', 'Entry minus put strike, adjusted for net premium', 'You trade away big gains to remove big losses.']),
  covered_put: T('Income and hedging', 'Covered put (short + short put)', [['U', -1, 0], ['P', -1, -2]], ['Neutral / mildly bearish', 'Short the underlying and sell a put for extra income.', 'You are short and expect little further fall.', 'Entry minus strike, plus premium', 'Unlimited', 'The bearish twin of the covered call.']),
  covered_strangle: T('Income and hedging', 'Covered strangle', [['U', 1, 0], ['C', -1, 2], ['P', -1, -2]], ['Neutral', 'Own the underlying and sell both an out-of-the-money call and put for double the income.', 'You expect the price to stay in a range and would buy more on a dip.', 'Call strike minus entry, plus premiums', 'Large (falling price)', 'More income, more exposure.']),
  long_straddle: T('Volatility', 'Long straddle', [['C', 1, 0], ['P', 1, 0]], ['Big move, either way', 'Buy a call and a put at the same strike: profit from a large move up or down.', 'Before a major event (results, policy, election) when you expect a move but not its direction.', 'Unlimited', 'The total premium paid', 'The market already prices the event: you need a move bigger than expected.']),
  long_strangle: T('Volatility', 'Long strangle', [['C', 1, 2], ['P', 1, -2]], ['Big move, either way', 'Like the straddle but with out-of-the-money options: cheaper, needs a bigger move.', 'You expect a very large move and want a smaller cost.', 'Unlimited', 'The total premium paid', 'Lower cost means a wider no-profit zone.']),
  strap: T('Volatility', 'Strap (2 calls + 1 put)', [['C', 2, 0], ['P', 1, 0]], ['Big move, upward bias', 'A straddle with an extra call: gains more on a rise than on a fall.', 'You expect volatility with an upward lean.', 'Unlimited', 'The total premium paid', 'Leaning a volatility bet is still a bet on size first.']),
  strip: T('Volatility', 'Strip (1 call + 2 puts)', [['C', 1, 0], ['P', 2, 0]], ['Big move, downward bias', 'A straddle with an extra put: gains more on a fall than on a rise.', 'You expect volatility with a downward lean.', 'Large (on a fall)', 'The total premium paid', 'Mirror of the strap.']),
  long_gut: T('Volatility', 'Long guts (in-the-money strangle)', [['C', 1, -1], ['P', 1, 1]], ['Big move, either way', 'Buy an in-the-money call and put: more expensive, but mostly intrinsic value, which decays less.', 'You expect a big move and prefer paying for value over hope.', 'Unlimited', 'Premium minus the strike gap', 'You pay more for less time-value risk.']),
  call_backspread: T('Volatility', 'Call ratio backspread', [['C', -1, 0], ['C', 2, 2]], ['Strongly bullish, volatile', 'Sell one call and buy two higher calls: small cost or credit, unlimited gain on a big rally, a loss zone in between.', 'You expect a big upward breakout.', 'Unlimited', 'Limited, highest at the bought strike', 'There is a valley of losses if the move is only moderate.']),
  put_backspread: T('Volatility', 'Put ratio backspread', [['P', -1, 0], ['P', 2, -2]], ['Strongly bearish, volatile', 'Sell one put and buy two lower puts: profits from a crash.', 'You expect a sharp fall.', 'Large (on a crash)', 'Limited, highest at the bought strike', 'A cheap crash hedge, with a loss zone in a mild fall.']),
  reverse_iron_condor: T('Volatility', 'Reverse iron condor', [['P', -1, -3], ['P', 1, -2], ['C', 1, 2], ['C', -1, 3]], ['Big move, either way', 'A defined-risk bet on a breakout: buy the inner options, sell the outer ones.', 'You expect a move beyond the inner strikes.', 'Strike gap minus the debit', 'The net premium paid', 'Cheaper than a strangle, with capped gain.']),
  reverse_iron_butterfly: T('Volatility', 'Reverse iron butterfly', [['P', -1, -2], ['P', 1, 0], ['C', 1, 0], ['C', -1, 2]], ['Big move, either way', 'A straddle with the outer wings sold: lower cost, capped gain.', 'You expect a big move and want a capped cost.', 'Wing width minus the debit', 'The net premium paid', 'Capping gains is how you lower the cost.']),
  short_straddle: T('Range and income', 'Short straddle', [['C', -1, 0], ['P', -1, 0]], ['Neutral', 'Sell a call and a put at the same strike: collect the largest premium if the price stays put.', 'You expect very little movement; experienced traders only.', 'The total premium received', 'Unlimited', 'It wins most weeks and can lose a year of premiums in one day.']),
  short_strangle: T('Range and income', 'Short strangle', [['C', -1, 2], ['P', -1, -2]], ['Neutral', 'Sell an out-of-the-money call and put: a wider profit zone than the straddle, smaller premium.', 'You expect the price to stay in a range.', 'The total premium received', 'Unlimited', 'The wide zone raises the win rate and the severity of the losses.']),
  iron_condor: T('Range and income', 'Iron condor', [['P', 1, -3], ['P', -1, -2], ['C', -1, 2], ['C', 1, 3]], ['Neutral', 'A short strangle with protective wings: sell the inner options, buy the outer ones, so the loss is capped.', 'You expect a range and want a known maximum loss.', 'The net premium received', 'Wing width minus the credit', 'The most popular defined-risk range trade: modest credit, capped loss.']),
  iron_butterfly: T('Range and income', 'Iron butterfly', [['P', 1, -2], ['P', -1, 0], ['C', -1, 0], ['C', 1, 2]], ['Neutral', 'Sell the at-the-money straddle and buy wings for protection: higher credit than the condor, narrower profit zone.', 'You expect the price to pin near the current level.', 'The net premium received', 'Wing width minus the credit', 'Higher reward needs more precision.']),
  call_butterfly: T('Range and income', 'Long call butterfly', [['C', 1, -2], ['C', -2, 0], ['C', 1, 2]], ['Neutral', 'Buy one low call, sell two middle calls, buy one high call: a cheap bet that the price finishes near the middle.', 'You expect the price to pin at a level.', 'Wing width minus the debit', 'The net premium paid', 'Low cost, low odds, high reward-to-risk.']),
  put_butterfly: T('Range and income', 'Long put butterfly', [['P', 1, 2], ['P', -2, 0], ['P', 1, -2]], ['Neutral', 'The same shape built from puts.', 'You expect the price to pin at a level.', 'Wing width minus the debit', 'The net premium paid', 'Calls and puts give the same shape; pick whichever is more liquid.']),
  call_condor: T('Range and income', 'Long call condor', [['C', 1, -3], ['C', -1, -1], ['C', -1, 1], ['C', 1, 3]], ['Neutral', 'A butterfly with a flat top: profit across a range instead of at one price.', 'You expect the price to finish in a band.', 'Inner width minus the debit', 'The net premium paid', 'A wider peak is easier to hit and pays less.']),
  broken_wing: T('Range and income', 'Broken-wing butterfly', [['P', 1, 2], ['P', -2, 0], ['P', 1, -3]], ['Neutral / mildly bullish', 'A butterfly with one wing placed further away: usually no risk on one side, in exchange for more risk on the other.', 'You expect a range with a mild upward lean.', 'Depends on the credit or debit', 'Larger on the far-wing side', 'Moving a wing shifts risk from one side to the other; it does not remove it.']),
  call_ratio: T('Range and income', 'Call ratio spread', [['C', 1, 0], ['C', -2, 2]], ['Mildly bullish', 'Buy one call and sell two higher ones: a cheap or credit entry that profits to the short strike and has unlimited risk above.', 'You expect a modest rise and no more.', 'Limited, at the short strike', 'Unlimited', 'The extra short option is naked risk.']),
  put_ratio: T('Range and income', 'Put ratio spread', [['P', 1, 0], ['P', -2, -2]], ['Mildly bearish', 'Buy one put and sell two lower ones.', 'You expect a modest fall and no crash.', 'Limited, at the short strike', 'Large (below the short strike)', 'The extra short option is naked risk.']),
  jade_lizard: T('Range and income', 'Jade lizard', [['P', -1, -1], ['C', -1, 1], ['C', 1, 2]], ['Neutral / mildly bullish', 'Sell an out-of-the-money put and a call spread: the credit can exceed the call spread width, so there is no upside risk.', 'You expect the price to stay flat or drift up.', 'The net premium received', 'Large (falling price)', 'Collect enough premium and one side of the risk disappears.']),
  calendar: T('Time spreads', 'Long calendar spread', [['C', -1, 0, 0], ['C', 1, 0, 1]], ['Neutral', 'Sell the near-expiry call and buy the same strike in the next expiry: the near option decays faster.', 'You expect little movement until the near expiry.', 'Limited, best when the price sits at the strike', 'The net premium paid', 'You are trading time decay at different speeds. Needs the next expiry\'s chain.']),
  diagonal: T('Time spreads', 'Diagonal spread', [['C', -1, 2, 0], ['C', 1, 0, 1]], ['Mildly bullish', 'Sell a near-expiry out-of-the-money call and buy a longer-dated nearer-the-money call.', 'You expect a slow rise and want repeated income from the short leg.', 'Limited', 'The net premium paid', 'It combines direction and time decay; evaluated at the near expiry here. Needs the next expiry\'s chain.']),
};
export const OPTION_GROUPS = ['Single position', 'Vertical spreads', 'Synthetic', 'Income and hedging', 'Volatility', 'Range and income', 'Time spreads'];
export const optionStrategyGroups = () => OPTION_GROUPS.map((g) => [g, Object.entries(OPTION_STRATEGIES).filter(([, s]) => s.group === g).map(([k, s]) => [k, s.name])]);

/** Lot sizes change from time to time (NSE revises them): these are starting values the user can edit. Check NSE for the current lot size before relying on money figures. */
export const DEFAULT_LOTS = { NIFTY: 75, BANKNIFTY: 30, FINNIFTY: 65, MIDCPNIFTY: 120, NIFTYNXT50: 25 };
export const defaultLot = (sym) => DEFAULT_LOTS[String(sym).toUpperCase()] || 1;

/* ---------- time and volatility helpers ---------- */
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
/** Expiry ('27-Oct-2026' or '2026-10-27') as the moment trading in it ends (15:30 India time), in milliseconds; null if unreadable. */
export function expiryMs(text) {
  const s = String(text || '').trim(); let y, m, d, k;
  if ((k = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) { y = +k[1]; m = +k[2] - 1; d = +k[3]; }
  else if ((k = /^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ](\d{4})/.exec(s)) && MONTHS[k[2].toUpperCase()] != null) { d = +k[1]; m = MONTHS[k[2].toUpperCase()]; y = +k[3]; }
  else return null;
  return Date.UTC(y, m, d, 10, 0);
}
const toVol = (iv) => (iv > 0 ? (iv > 3 ? iv / 100 : iv) : null);   // the chain gives percent
const atmVol = (rows, atm) => { const r = rows[atm]; const a = [toVol(r?.ce?.iv), toVol(r?.pe?.iv)].filter(Boolean); return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; };

/** Build a strategy's legs from a chain.
 *   chain / farChain: {spot, expiry, rows:[{strike, ce:{ltp, iv}, pe:{ltp, iv}}]} (farChain only for calendar and diagonal spreads)
 *   opts: {width (strike steps per unit offset), lots, lot, asOf (ms)}
 * Returns {key, name, legs:[{kind, side, strike, qty, price, iv, estimated, expiry, T}], spot, vol, lot, lots, asOf} or throws a plain-language Error. */
export function buildStrategy(chain, key, { width = 1, lots = 1, lot = 1, asOf = Date.now(), farChain = null } = {}) {
  const tpl = OPTION_STRATEGIES[key]; if (!tpl) throw new Error(`unknown strategy ${key}`);
  const need = (c) => { if (!c || !c.rows || c.rows.length < 3) throw new Error('No option chain with at least three strikes is available for this expiry.'); if (!(c.spot > 0)) throw new Error('The chain has no spot price.'); };
  need(chain); const needsFar = tpl.legs.some((l) => l[3] === 1); if (needsFar) { if (!farChain) throw new Error('This strategy needs the next expiry as well, and that chain is not available.'); need(farChain); }
  const pick = (c) => { let atm = 0; c.rows.forEach((r, i) => { if (Math.abs(r.strike - c.spot) < Math.abs(c.rows[atm].strike - c.spot)) atm = i; }); return atm; };
  const legs = [], w = Math.max(1, Math.round(width)), notes = [];
  for (const [kind, side, off, which = 0] of tpl.legs) {
    const c = which === 1 ? farChain : chain, atm = pick(c), idx = Math.min(c.rows.length - 1, Math.max(0, atm + off * w)), row = c.rows[idx];
    if (idx !== atm + off * w) notes.push('Some strikes were outside the chain, so the nearest available strike was used.');
    const exp = expiryMs(c.expiry), T = exp ? Math.max(0, (exp - asOf) / (365 * 86400000)) : 0, vol = atmVol(c.rows, atm) || 0.2;
    if (kind === 'U') { legs.push({ kind, side: Math.sign(side), strike: null, qty: 1, price: chain.spot, iv: null, estimated: false, expiry: chain.expiry, T }); continue; }
    const q = kind === 'C' ? row.ce : row.pe, iv = toVol(q?.iv) || vol, ltp = q && q.ltp > 0 ? q.ltp : null;
    const est = ltp == null, price = ltp ?? bsPrice(kind, c.spot, row.strike, T, iv);
    legs.push({ kind, side: Math.sign(side), strike: row.strike, qty: Math.abs(side), price, iv, estimated: est, expiry: c.expiry, T });
  }
  const atm0 = pick(chain);
  return { key, name: tpl.name, legs, spot: chain.spot, vol: atmVol(chain.rows, atm0) || 0.2, lot, lots, asOf, notes: [...new Set(notes)] };
}

/** Value of one leg per unit if the underlying is S when `t` years from `asOf` have passed. */
function legValue(l, S, t, vol) {
  if (l.kind === 'U') return S;
  const left = Math.max(0, l.T - t);
  return bsPrice(l.kind, S, l.strike, left, l.iv || vol);
}
/** Profit or loss in rupees at underlying price S, t years after `asOf` (default: at the first expiry). */
export function pnlAt(st, S, t = firstExpiry(st)) {
  return st.legs.reduce((a, l) => a + l.side * l.qty * (legValue(l, S, t, st.vol) - l.price), 0) * st.lot * st.lots;
}
export const firstExpiry = (st) => Math.min(...st.legs.filter((l) => l.kind !== 'U').map((l) => l.T), ...(st.legs.some((l) => l.kind !== 'U') ? [] : [0]));

/** Everything worth showing about a strategy: cost, extremes, breakevens, Greeks and a model estimate of the chance of profit. */
export function analyse(st) {
  const t1 = firstExpiry(st), mult = st.lot * st.lots, S0 = st.spot;
  const strikes = st.legs.filter((l) => l.strike != null).map((l) => l.strike);
  const grid = new Set([0, S0]); strikes.forEach((k) => grid.add(k)); for (let i = 0; i <= 600; i++) grid.add((S0 * 3 * i) / 600);
  const xs = [...grid].sort((a, b) => a - b), ys = xs.map((x) => pnlAt(st, x, t1));
  const slopeUp = (pnlAt(st, S0 * 6, t1) - pnlAt(st, S0 * 4, t1)) / mult;
  const hi = Math.max(...ys), lo = Math.min(...ys), up = slopeUp > 1e-9, down = slopeUp < -1e-9;
  const maxProfit = up ? Infinity : hi, maxLoss = down ? -Infinity : lo;
  const be = []; for (let i = 1; i < xs.length; i++) { const a = ys[i - 1], b = ys[i]; if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) { const x = xs[i - 1] + ((0 - a) / (b - a)) * (xs[i] - xs[i - 1]); if (!be.length || Math.abs(x - be[be.length - 1]) > S0 * 0.0005) be.push(x); } }
  const net = st.legs.filter((l) => l.kind !== 'U').reduce((a, l) => a + l.side * l.qty * l.price, 0) * mult;   // positive = money paid (debit)
  // chance of profit: lognormal terminal price with the at-the-money volatility, summed over the grid
  let pop = null; const sig = st.vol, Tq = t1;
  if (Tq > 0 && sig > 0) {
    const m = Math.log(S0) + (RISK_FREE - sig * sig / 2) * Tq, s = sig * Math.sqrt(Tq); let p = 0;
    for (let i = 1; i < xs.length; i++) { if (xs[i] <= 0) continue; const x0 = Math.max(xs[i - 1], 1e-9), x1 = xs[i], mid = (ys[i] + ys[i - 1]) / 2; if (mid > 0) p += normCdf((Math.log(x1) - m) / s) - normCdf((Math.log(x0) - m) / s); }
    pop = Math.min(1, Math.max(0, p)) * 100;
  }
  const g = st.legs.reduce((a, l) => {
    if (l.kind === 'U') { a.delta += l.side; return a; }
    const x = greeks(l.kind, S0, l.strike, l.T, l.iv || st.vol); a.delta += l.side * l.qty * x.delta; a.gamma += l.side * l.qty * x.gamma; a.theta += l.side * l.qty * x.theta; a.vega += l.side * l.qty * x.vega; return a;
  }, { delta: 0, gamma: 0, theta: 0, vega: 0 });
  const unit = (v) => v * mult;
  return {
    net, debit: net > 0, maxProfit, maxLoss, breakevens: be, pop, rewardRisk: Number.isFinite(maxProfit) && Number.isFinite(maxLoss) && maxLoss < 0 ? maxProfit / -maxLoss : null,
    greeks: { delta: g.delta * mult, gamma: unit(g.gamma), theta: unit(g.theta), vega: unit(g.vega) }, daysToExpiry: t1 * 365, estimated: st.legs.some((l) => l.estimated),
    unlimitedLoss: !Number.isFinite(maxLoss), unlimitedProfit: !Number.isFinite(maxProfit),
  };
}

/** Curves for a chart: profit at the first expiry and profit if the position were closed today (model value). */
export function payoffCurves(st, a = analyse(st), points = 160) {
  const S0 = st.spot, near = a.breakevens.filter((b) => b > S0 * 0.6 && b < S0 * 1.4), ks = st.legs.filter((l) => l.strike != null).map((l) => l.strike), t1 = firstExpiry(st), xs = [];
  const marks = [S0, ...near, ...ks], mn = Math.min(...marks), mx = Math.max(...marks), half = Math.max(S0 * 0.04, ((mx - mn) / 2) * 1.5), mid = (mn + mx) / 2;   // zoom on the strikes, not on a fixed band around spot
  const lo = Math.max(S0 * 0.01, mid - half), hi = mid + half;
  for (let i = 0; i <= points; i++) xs.push(lo + ((hi - lo) * i) / points);
  return { xs, expiry: xs.map((x) => pnlAt(st, x, t1)), today: t1 > 0 ? xs.map((x) => pnlAt(st, x, 0)) : null, spot: S0, breakevens: a.breakevens };
}

/** Run every strategy in the catalogue on the same chain, for the comparison table. A strategy that cannot be built (missing strikes, no far expiry) is skipped. */
export function compareOptionStrategies(chain, farChain, opts) {
  const out = [];
  for (const [key, tpl] of Object.entries(OPTION_STRATEGIES)) {
    try { const st = buildStrategy(chain, key, { ...opts, farChain }); out.push({ key, name: tpl.name, group: tpl.group, outlook: tpl.outlook, ...analyse(st) }); } catch (e) { /* skip */ }
  }
  return out;
}

/** Mark a saved position to market with the latest chain: current premium of each leg and the profit or loss if closed now. */
export function markToMarket(saved, chains) {
  let value = 0, missing = 0;
  for (const l of saved.legs) {
    if (l.kind === 'U') { const sp = chains[l.expiry]?.spot ?? chains._spot; if (sp > 0) value += l.side * (sp - l.price); else missing++; continue; }
    const row = chains[l.expiry]?.rows?.find((r) => r.strike === l.strike), q = row && (l.kind === 'C' ? row.ce : row.pe);
    if (q && q.ltp > 0) value += l.side * l.qty * (q.ltp - l.price); else missing++;
  }
  return { pnl: value * saved.lot * saved.lots, missing };
}

/** Profit or loss of a saved position if every option settles at underlying price S (used once its expiry has passed). */
export function settlePnl(saved, S) {
  return saved.legs.reduce((a, l) => a + l.side * l.qty * ((l.kind === 'U' ? S : Math.max(l.kind === 'C' ? S - l.strike : l.strike - S, 0)) - l.price), 0) * saved.lot * saved.lots;
}
