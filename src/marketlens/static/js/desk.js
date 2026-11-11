/* Desk runtime: the state, the audit log and the order pipeline that the Signals, Orders, Operator and Settings pages share.
 * desk-core.js holds the rules (pure); this file connects them to the browser: per-user storage, the paper account, the quote API and the Zerodha gate on the server. */
import { store, api } from './lib.js';
import * as C from './desk-core.js';
import { normalize as normAcc, placeOrder, valuation } from './paper.js';

const KEY = 'ml.desk', PAPER = 'ml.paper';
export const audit = new C.AuditLog({ get: (k, d) => store.get(k, d), set: (k, v) => store.set(k, v) });
export const load = () => C.normalizeDesk(store.get(KEY, null));
export const save = (d) => store.set(KEY, d);
export const log = (type, data) => audit.append(type, data).catch(() => {});
const JSON_HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'MarketLens' };
export const post = (path, body) => api(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body || {}), quiet: true, retries: 0, timeoutMs: 20000 });

export const paperAccount = () => normAcc(store.get(PAPER, null));
/** Settle a desk fill into the paper account, so the Paper trading page shows it too. */
export function paperSettle({ sym, side, qty, price, note }) {
  try { const { account } = placeOrder(paperAccount(), { sym, side, qty, price, note, strategy: 'desk' }); store.set(PAPER, account); return {}; } catch (e) { return { error: e.message }; }
}

/** Account figures for the risk engine, from the paper account marked at the given prices. */
export function accountContext(prices, sectorOf = () => 'Other') {
  const acc = paperAccount(), v = valuation(acc, prices), d = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10), desk = load();
  const startEquity = desk.startEquityDay && desk.startEquityDay.day === d ? desk.startEquityDay.equity : v.equity;
  if (!desk.startEquityDay || desk.startEquityDay.day !== d) { desk.startEquityDay = { day: d, equity: v.equity }; save(desk); }
  return { account: { equity: v.equity, cash: acc.cash }, positions: v.rows.map((r) => ({ sym: r.sym, qty: r.qty, last: r.last, sector: sectorOf(r.sym) })), startEquity, dayPnl: v.equity - startEquity };
}

export async function quoteFor(sym) {
  const q = await api(`/api/quote/${encodeURIComponent(sym)}`, { quiet: true, retries: 0, timeoutMs: 10000 });
  return { price: q.price, ageSeconds: q.ageMs != null ? q.ageMs / 1000 : (q.status === 'live' ? 0 : null), valueCr: q.valueCr, status: q.status, ts: q.ts };
}

/** The Zerodha adapter, as the desk sees it: every call goes through the server's gate (broker.py), which enforces the live flag, kill switch and limits on its own. */
export const zerodha = { name: 'zerodha',
  async place(payload) { const r = await post('/api/broker/order', { order: payload }); return { status: 'ACKNOWLEDGED', broker_order_id: r.order_id }; },
  async get(id, tag) { return id ? api(`/api/broker/order/${encodeURIComponent(id)}`, { quiet: true, retries: 0 }) : api(`/api/broker/order?tag=${encodeURIComponent(tag || '')}`, { quiet: true, retries: 0 }); } };

export function brokerFor(desk, { priceOf, shadow = false }) {
  if (shadow) return { name: 'shadow', async place(p) { const px = priceOf(p.tradingsymbol); return px > 0 ? { status: 'FILLED', broker_order_id: `SHADOW-${p.tag}`, price: px, filled: p.quantity } : { status: 'REJECTED', reason: 'no price' }; }, async get() { return null; } };
  if (desk.mode === 'live' || (desk.mode === 'manual' && desk.broker === 'zerodha')) return zerodha;
  return C.paperBroker({ priceOf, slippageBps: desk.limits.slippageBps, place: paperSettle });
}

/** Risk-check an intent and, depending on the mode, execute it, queue it for approval, or record it. Everything is audited. Returns {intent, decision, order?, queued?}. */
export async function submit(intent, { quote, prices, sectorOf, brokerStatus = null, lot = 1 }) {
  const desk = load(), now = Date.now(), live = desk.mode === 'live' || (desk.mode === 'manual' && desk.broker === 'zerodha');
  const ac = accountContext(prices, sectorOf);
  const decision = C.riskEvaluate(intent, { ...ac, quote, openOrders: desk.orders.filter((o) => !C.TERMINAL.has(o.status)).length, recentIntents: desk.intents.map((i) => ({ key: i.idempotency_key, at: i.created_at })), recentOrderTimes: desk.recentOrderTimes,
    limits: desk.limits, kill: desk.kill, strategyStatus: desk.strategyStatus, brokerConnected: !!(brokerStatus && brokerStatus.connected && brokerStatus.liveOrdersEnabled && !brokerStatus.killSwitch), live, lot, now });
  desk.decisions[intent.intent_id] = decision; desk.intents = [{ ...intent, status: 'new' }, ...desk.intents].slice(0, 300);
  await log('intent', { intent_id: intent.intent_id, sym: intent.sym, side: intent.side, quantity: intent.quantity, limit_price: intent.limit_price, strategy: intent.strategy_id, rationale: intent.rationale });
  await log('risk_decision', { intent_id: intent.intent_id, decision: decision.decision, reason_codes: decision.reason_codes, mode: desk.mode, limits: decision.limits_snapshot });
  const mark = (status, extra = {}) => { desk.intents = desk.intents.map((i) => (i.intent_id === intent.intent_id ? { ...i, status, ...extra } : i)); };
  if (decision.decision === 'REJECT') { mark('rejected'); save(desk); return { intent, decision }; }
  if (desk.mode === 'research') { mark('research_only'); save(desk); return { intent, decision, note: 'Research mode: nothing is executed. Switch the mode on the Operator page.' }; }
  if (desk.mode === 'manual') { mark('awaiting_approval'); save(desk); return { intent, decision, queued: true }; }
  const out = await run(desk, intent, decision, prices); return { intent, decision, ...out };
}

async function run(desk, intent, decision, prices) {
  const broker = brokerFor(desk, { priceOf: (s) => (prices && prices[s]) || intent.ref_price, shadow: desk.mode === 'shadow' });
  const res = await C.execute(intent, decision, { broker, orders: desk.orders, now: Date.now });
  desk.orders = [res.order, ...desk.orders.filter((o) => o.client_order_id !== res.order.client_order_id)].slice(0, 500); desk.recentOrderTimes = [...desk.recentOrderTimes.filter((t) => Date.now() - t < 5000), Date.now()];
  desk.intents = desk.intents.map((i) => (i.intent_id === intent.intent_id ? { ...i, status: res.order.status.toLowerCase() } : i));
  if (res.unknown) desk.incidents = [{ at: Date.now(), kind: 'unknown_order', detail: `${intent.sym} ${intent.side} ${intent.quantity}: no answer from ${broker.name}; the order will be reconciled, not resent`, order: res.order.client_order_id }, ...desk.incidents].slice(0, 100);
  save(desk); await log('order', { client_order_id: res.order.client_order_id, status: res.order.status, broker: broker.name, history: res.order.history.map((h) => h.state), duplicate: !!res.duplicate, price: res.order.average_price });
  return { order: res.order, duplicate: !!res.duplicate };
}

/** Approve a queued intent (manual mode): the risk engine runs again on fresh data first. */
export async function approve(intentId, { quote, prices, sectorOf, brokerStatus, lot = 1 }) {
  const desk = load(), intent = desk.intents.find((i) => i.intent_id === intentId); if (!intent) throw new Error('intent not found');
  const live = desk.broker === 'zerodha', ac = accountContext(prices, sectorOf), now = Date.now();
  const decision = C.riskEvaluate(intent, { ...ac, quote, openOrders: desk.orders.filter((o) => !C.TERMINAL.has(o.status)).length, recentIntents: desk.intents.filter((i) => i.intent_id !== intentId).map((i) => ({ key: i.idempotency_key, at: i.created_at })),
    recentOrderTimes: desk.recentOrderTimes, limits: desk.limits, kill: desk.kill, strategyStatus: desk.strategyStatus, brokerConnected: !!(brokerStatus && brokerStatus.connected && brokerStatus.liveOrdersEnabled && !brokerStatus.killSwitch), live, lot, now });
  desk.decisions[intentId] = decision; await log('approval', { intent_id: intentId, by: 'user', decision: decision.decision, reason_codes: decision.reason_codes });
  if (decision.decision === 'REJECT') { desk.intents = desk.intents.map((i) => (i.intent_id === intentId ? { ...i, status: 'rejected' } : i)); save(desk); return { decision }; }
  const out = await run(desk, intent, decision, prices); return { decision, ...out };
}

export async function rejectIntent(intentId, reason = 'rejected by user') {
  const desk = load(); desk.intents = desk.intents.map((i) => (i.intent_id === intentId ? { ...i, status: 'rejected_by_user' } : i)); save(desk); await log('approval', { intent_id: intentId, by: 'user', decision: 'REJECT', reason_codes: [reason] });
}

/** Re-query unknown and open orders at their broker; three reconciliation breaks in a row pause trading by themselves. */
export async function reconcileAll() {
  const desk = load(); let changed = 0;
  for (const o of desk.orders) {
    if (C.TERMINAL.has(o.status)) continue;
    const broker = o.client_order_id && o.broker_order_id && String(o.broker_order_id).startsWith('PAPER') ? null : zerodha;
    if (!broker) continue;
    const r = await C.reconcileOrder(o, broker); if (r.changed) { desk.orders = desk.orders.map((x) => (x.client_order_id === o.client_order_id ? r.order : x)); changed++; await log('reconcile', { client_order_id: o.client_order_id, to: r.order.status }); }
  }
  const acc = paperAccount(), pos = Object.entries(acc.positions).map(([sym, p]) => ({ sym, qty: p.qty })), deskOrders = desk.orders.filter((o) => o.broker_order_id && String(o.broker_order_id).startsWith('PAPER'));
  const rec = C.reconcilePositions(deskOrders, pos.filter((p) => deskOrders.some((o) => o.sym === p.sym)));
  desk.reconBreaks = rec.ok ? 0 : desk.reconBreaks + 1;
  if (desk.reconBreaks >= 3 && !desk.kill.global) { desk.kill = { ...desk.kill, global: true, reason: 'three reconciliation breaks in a row', at: Date.now() }; desk.incidents = [{ at: Date.now(), kind: 'reconciliation', detail: 'trading paused after three reconciliation breaks' }, ...desk.incidents]; await log('kill_switch', { on: true, reason: 'reconciliation breaks' }); }
  save(desk); await log('reconcile_run', { ok: rec.ok, breaks: rec.breaks, changed }); return { ...rec, changed };
}

export async function setKill(on, reason = '') {
  const desk = load(); desk.kill = { ...desk.kill, global: on, reason: on ? reason : '', at: on ? Date.now() : null };
  if (on) desk.incidents = [{ at: Date.now(), kind: 'kill_switch', detail: reason || 'operator pressed the kill switch' }, ...desk.incidents].slice(0, 100);
  save(desk); await log('kill_switch', { on, reason });
  try { await post('/api/broker/kill', { on, reason }); } catch (e) { /* the phone app has no broker server; the page-level switch still applies */ }
  return desk;
}

export async function brokerStatus() { try { return await api('/api/broker/status', { quiet: true, retries: 0 }); } catch (e) { return null; } }
