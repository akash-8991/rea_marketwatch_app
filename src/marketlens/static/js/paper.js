/* Paper-trading account: a virtual portfolio that "trades" at real NSE prices with pretend money. Pure functions over a plain object, so every rule can be
 * tested; the view saves the object per user (store 'ml.paper'). Rules: whole shares only, no shorting, no leverage, orders fill at the price you pass in
 * (the latest NSE price or last close), every trade pays the same fee percentage the strategy simulator uses. */

export const START_CASH = 1_000_000;
export const FEE_PCT = 0.1;
export class OrderError extends Error {}
const r2 = (x) => Math.round(x * 100) / 100;

export const newAccount = (cash = START_CASH, now = Date.now()) => ({ version: 1, startCash: cash, cash, createdAt: now, positions: {}, trades: [], realized: 0, feesPaid: 0, nextId: 1 });

/** Validate and apply an order. Returns {account, trade}; the input account is never changed. Throws OrderError with a plain-language reason. */
export function placeOrder(acc, { sym, side, qty, price, ts = Date.now(), feePct = FEE_PCT, note = '', strategy = '' }) {
  sym = String(sym || '').trim().toUpperCase();
  if (!/^[A-Z0-9&_-]{1,24}$/.test(sym)) throw new OrderError('Enter a valid NSE symbol.');
  if (side !== 'BUY' && side !== 'SELL') throw new OrderError('Choose buy or sell.');
  if (!Number.isInteger(qty) || qty < 1) throw new OrderError('Quantity must be a whole number of shares, at least 1.');
  if (!(price > 0) || !Number.isFinite(price)) throw new OrderError('There is no valid price for this symbol right now.');
  const value = qty * price, fee = r2(value * (feePct / 100)), pos = acc.positions[sym];
  const next = { ...acc, positions: { ...acc.positions }, trades: [...acc.trades] };
  let pnl = null;
  if (side === 'BUY') {
    if (value + fee > acc.cash + 1e-9) throw new OrderError(`Not enough cash: this order needs ₹${(value + fee).toLocaleString('en-IN', { maximumFractionDigits: 2 })} and you have ₹${acc.cash.toLocaleString('en-IN', { maximumFractionDigits: 2 })}.`);
    const q = (pos ? pos.qty : 0) + qty, cost = (pos ? pos.qty * pos.avg : 0) + value + fee;
    next.positions[sym] = { qty: q, avg: cost / q };            // average cost includes the buying fee
    next.cash = r2(acc.cash - value - fee);
  } else {
    if (!pos || pos.qty < qty) throw new OrderError(pos ? `You hold only ${pos.qty} share${pos.qty > 1 ? 's' : ''} of ${sym}; short selling is not allowed.` : `You do not hold ${sym}; short selling is not allowed.`);
    pnl = r2(value - fee - qty * pos.avg);
    next.realized = r2(acc.realized + pnl); next.cash = r2(acc.cash + value - fee);
    if (pos.qty === qty) delete next.positions[sym]; else next.positions[sym] = { qty: pos.qty - qty, avg: pos.avg };
  }
  next.feesPaid = r2(acc.feesPaid + fee);
  const trade = { id: acc.nextId, ts, sym, side, qty, price, fee, ...(pnl != null ? { pnl } : {}), ...(note ? { note } : {}), ...(strategy ? { strategy } : {}) };
  next.trades.push(trade); next.nextId = acc.nextId + 1;
  return { account: next, trade };
}

/** Positions priced at `prices` ({SYM: price}); a missing price falls back to the average cost (flagged), so the account never shows a false profit. */
export function valuation(acc, prices = {}) {
  const rows = Object.entries(acc.positions).map(([sym, p]) => {
    const px = prices[sym], priced = px > 0, last = priced ? px : p.avg, value = p.qty * last, cost = p.qty * p.avg;
    return { sym, qty: p.qty, avg: p.avg, last, priced, value, cost, pnl: value - cost, pnlPct: cost ? ((value - cost) / cost) * 100 : 0 };
  }).sort((a, b) => b.value - a.value);
  const invested = rows.reduce((a, r) => a + r.value, 0), equity = acc.cash + invested, unrealized = rows.reduce((a, r) => a + r.pnl, 0);
  rows.forEach((r) => { r.weightPct = equity ? (r.value / equity) * 100 : 0; });
  return { rows, invested, equity, unrealized, realized: acc.realized, totalPnl: equity - acc.startCash, returnPct: ((equity - acc.startCash) / acc.startCash) * 100, cashPct: equity ? (acc.cash / equity) * 100 : 100, feesPaid: acc.feesPaid };
}

/** Whole shares affordable with `budget` rupees at `price`, fee included. */
export const sharesFor = (budget, price, feePct = FEE_PCT) => (price > 0 ? Math.max(0, Math.floor(budget / (price * (1 + feePct / 100)))) : 0);

/** Read a saved account, tolerating junk: anything that does not look like an account becomes a fresh one. */
export function normalize(raw) {
  try {
    if (!raw || raw.version !== 1 || typeof raw.cash !== 'number' || !raw.positions || !Array.isArray(raw.trades)) return newAccount();
    return { ...newAccount(raw.startCash || START_CASH), ...raw };
  } catch (e) { return newAccount(); }
}
