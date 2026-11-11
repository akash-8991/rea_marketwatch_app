/* The trading desk's decision logic, as pure functions (no DOM, no network, no clock unless passed in), so every rule can be unit-tested:
 *   agents      turn data into schema-checked proposals (technical, news, fundamental, derivatives, regime): deterministic code, never an order call
 *   fusion      weighted score with explicit handling of missing and conflicting agents (versioned weights)
 *   intents     a candidate trade: size from risk, limit price with a slippage cap, stop and target from ATR, an idempotency key
 *   risk        the pre-trade risk engine: every check runs, every failure is listed, nothing is silently downgraded
 *   execution   the order state machine with idempotency, no blind retry of unknown orders, reconciliation, and a paper broker
 *   audit       an append-only, hash-chained event log that can be verified and exported
 * AI proposes; these deterministic rules decide. Nothing here can place a live order: that path is the server's broker gate (broker.py). */

export const MODES = [
  ['research', 'Research', 'Signals and backtests only. No intents are executed.'],
  ['shadow', 'Shadow', 'Intents are created and logged with a virtual fill. Nothing touches the paper or live account.'],
  ['paper', 'Paper', 'Approved intents execute on the paper account automatically.'],
  ['manual', 'Manual approval', 'Every approved intent waits for your click, then executes on the chosen broker.'],
  ['live', 'Live', 'Approved intents execute automatically on Zerodha. Needs the live flag on the server, a connected broker and a confirmed pre-live checklist.'],
];

export const DEFAULT_LIMITS = {
  maxOrderValue: 100000, maxPositionPct: 20, maxGrossPct: 100, maxSectorPct: 40, perTradeRiskPct: 1, dailyLossPct: 3, maxOpenOrders: 10, maxOps: 5,
  duplicateWindowSec: 300, staleSeconds: 30, maxDeviationPct: 2, minLiquidityCr: 1, marketOrders: false, allowShort: false, tickSize: 0.05, slippageBps: 15, sessionOnly: true,
};

export const FUSION_DEFAULT = {
  version: 'fusion-1', weights: { news: 0.35, technical: 0.25, fundamental: 0.20, derivatives: 0.10, regime: 0.10 }, required: ['technical'],
  minScore: 0.25, minConfidence: 0.5, conflictPenalty: 0.3, conflictAt: 0.4, ttlSeconds: 900,
};

const IST = 5.5 * 3600 * 1000, r2 = (x) => Math.round(x * 100) / 100, clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const inSession = (ms) => { const d = new Date(ms + IST), m = d.getUTCHours() * 60 + d.getUTCMinutes(), w = d.getUTCDay(); return w >= 1 && w <= 5 && m >= 555 && m < 930; };

/* ---------- agents: proposals ---------- */
export const AGENTS = ['news', 'technical', 'fundamental', 'derivatives', 'regime'];
const dirOf = (s, band = 0.2) => (s >= band ? 'BUY' : s <= -band ? 'SELL' : 'HOLD');
const proposal = (agent, sym, score, confidence, { now = Date.now(), ttl = 900, evidence = [], reasons = [], model = `${agent}-rules-1`, horizon = ttl } = {}) =>
  ({ schema_version: '1.0', proposal_id: `${agent}:${sym}:${Math.floor(now / 1000)}`, agent_type: agent, instrument_id: `NSE:${sym}`, direction: dirOf(score), score: r2(clamp(score, -1, 1)), confidence: r2(clamp(confidence, 0, 1)),
    horizon_seconds: horizon, generated_at: now, valid_until: now + ttl * 1000, evidence, reason_codes: reasons, model_version: model, status: 'ok' });

/** Check a proposal against the schema; returns the list of problems (empty = valid). Malformed output fails closed in fuse(). */
export function validateProposal(p) {
  const bad = [];
  if (!p || typeof p !== 'object') return ['not an object'];
  if (!AGENTS.includes(p.agent_type)) bad.push('agent_type');
  if (!/^NSE:[A-Z0-9&_-]{1,24}$/.test(p.instrument_id || '')) bad.push('instrument_id');
  if (!['BUY', 'SELL', 'HOLD'].includes(p.direction)) bad.push('direction');
  for (const k of ['score']) if (!(typeof p[k] === 'number' && p[k] >= -1 && p[k] <= 1)) bad.push(k);
  if (!(typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1)) bad.push('confidence');
  if (!(typeof p.valid_until === 'number')) bad.push('valid_until');
  if (!Array.isArray(p.evidence)) bad.push('evidence');
  if (!p.model_version) bad.push('model_version');
  return bad;
}

/** Technical agent: the chart read (ta.js analyse) as a proposal. */
export function technicalAgent(sym, an, opts = {}) {
  if (!an || !an.ok) return null;
  const conf = clamp(0.35 + Math.abs(an.score) * 0.6, 0, 0.95) * (an.candles >= 120 ? 1 : an.candles >= 60 ? 0.85 : 0.65);
  const top = [...an.signals].sort((a, b) => b.weight * Math.abs(b.bias) - a.weight * Math.abs(a.bias)).slice(0, 4);
  return proposal('technical', sym, an.score, conf, { ...opts, evidence: [{ kind: 'chart_read', id: `${sym}:${an.candles}`, weight: 1 }, ...top.map((s) => ({ kind: 'signal', id: s.name, weight: s.weight }))], reasons: top.map((s) => s.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')) });
}

/** News agent: average headline tone (analysis.sentiment) with confidence from how many headlines and how one-sided. */
export function newsAgent(sym, s, opts = {}) {
  if (!s || s.score == null || !s.n) return null;
  const spread = s.n ? Math.abs(s.pos - s.neg) / s.n : 0, score = clamp(s.score * 2, -1, 1);
  return proposal('news', sym, score, clamp(0.2 + Math.min(1, s.n / 8) * 0.4 + spread * 0.3, 0, 0.9), { ...opts, ttl: 3600, evidence: [{ kind: 'headlines', id: `${sym}:${s.n}`, weight: 1 }], reasons: [`${s.pos}_positive_${s.neg}_negative`], model: 'news-lexicon-1' });
}

/** Fundamental agent: what NSE's data supports (dividend yield and consistency against the index, position in the 52-week range). No earnings data exists in the feeds. */
export function fundamentalAgent(sym, stock, opts = {}) {
  if (!stock) return null;
  const parts = []; const f = stock.fund;
  if (f && f.score != null) parts.push([f.score, 1, 'income_profile']);
  if (stock.hi52 > stock.lo52 && stock.price) { const pos = (stock.price - stock.lo52) / (stock.hi52 - stock.lo52); parts.push([pos < 0.25 ? 0.5 : pos > 0.85 ? -0.2 : 0.1, 0.6, pos < 0.25 ? 'near_52w_low' : pos > 0.85 ? 'near_52w_high' : 'mid_range']); }
  if (!parts.length) return null;
  const w = parts.reduce((a, p) => a + p[1], 0), score = parts.reduce((a, p) => a + p[0] * p[1], 0) / w;
  return proposal('fundamental', sym, score, 0.35 + 0.1 * parts.length, { ...opts, ttl: 6 * 3600, evidence: [{ kind: 'nse_fundamentals', id: sym, weight: 1 }], reasons: parts.map((p) => p[2]), model: 'fundamental-rules-1' });
}

/** Derivatives agent: put-call ratio and max pain against spot from the option chain summary ({pcr, maxPain, spot}). */
export function derivativesAgent(sym, o, opts = {}) {
  if (!o || o.pcr == null) return null;
  let s = o.pcr > 1.3 ? 0.4 : o.pcr > 1.0 ? 0.15 : o.pcr < 0.6 ? -0.4 : o.pcr < 0.9 ? -0.15 : 0; const reasons = [`pcr_${o.pcr}`];
  if (o.maxPain && o.spot) { const gap = (o.maxPain - o.spot) / o.spot; s += clamp(gap * 5, -0.3, 0.3); reasons.push(gap > 0 ? 'spot_below_max_pain' : 'spot_above_max_pain'); }
  return proposal('derivatives', sym, s, 0.4, { ...opts, ttl: 3600, evidence: [{ kind: 'option_chain', id: sym, weight: 1 }], reasons, model: 'derivatives-rules-1' });
}

/** Regime agent: market breadth and India VIX. A weak, broad-market tilt applied to every stock. */
export function regimeAgent(sym, d, opts = {}) {
  const b = d && d.breadth; if (!b || !(b.advances != null && b.declines != null)) return null;
  const tot = b.advances + b.declines || 1; let s = ((b.advances - b.declines) / tot) * 0.8; const reasons = [s > 0 ? 'broad_advance' : 'broad_decline'];
  const vix = d.mood && (d.mood.vix ?? d.mood.indiaVix); if (vix != null) { if (vix > 22) { s -= 0.2; reasons.push('high_vix'); } else if (vix < 14) { s += 0.1; reasons.push('low_vix'); } }
  return proposal('regime', sym, s, 0.45, { ...opts, ttl: 1800, evidence: [{ kind: 'market_breadth', id: 'nse', weight: 1 }], reasons, model: 'regime-rules-1' });
}

/* ---------- signal fusion ---------- */
/** Combine agent proposals for one instrument. Missing optional agents are listed and the weights renormalised; a missing required agent rejects; invalid or expired
 *  proposals count as missing; strong disagreement applies a conflict penalty; every component score is returned for attribution. */
export function fuse(props, cfg = FUSION_DEFAULT, now = Date.now()) {
  const comps = {}, missing = [], invalid = [], reasons = [];
  for (const a of Object.keys(cfg.weights)) {
    const p = (props || []).find((x) => x && x.agent_type === a), bad = p ? validateProposal(p) : ['missing'];
    if (!p) { missing.push(a); continue; }
    if (bad.length) { invalid.push({ agent: a, problems: bad }); missing.push(a); continue; }
    if (p.valid_until < now) { missing.push(a); invalid.push({ agent: a, problems: ['expired'] }); continue; }
    comps[a] = p;
  }
  const out = { version: cfg.version, components: Object.fromEntries(Object.entries(comps).map(([a, p]) => [a, { score: p.score, confidence: p.confidence, weight: cfg.weights[a], direction: p.direction }])), missing, invalid, conflict: false };
  const lostRequired = (cfg.required || []).filter((a) => !comps[a]);
  if (lostRequired.length) return { ...out, direction: 'HOLD', score: 0, confidence: 0, status: 'rejected', reason_codes: lostRequired.map((a) => `required_agent_${a}_missing`) };
  const w = Object.keys(comps).reduce((s, a) => s + cfg.weights[a], 0) || 1;
  let score = Object.entries(comps).reduce((s, [a, p]) => s + (cfg.weights[a] / w) * p.score, 0), conf = Object.entries(comps).reduce((s, [a, p]) => s + (cfg.weights[a] / w) * p.confidence, 0);
  const strong = Object.values(comps).filter((p) => Math.abs(p.score) >= cfg.conflictAt && p.confidence >= 0.5), up = strong.some((p) => p.score > 0), dn = strong.some((p) => p.score < 0);
  if (up && dn) { out.conflict = true; score *= 1 - cfg.conflictPenalty; conf *= 1 - cfg.conflictPenalty; reasons.push('conflicting_agents'); }
  score = r2(score); conf = r2(conf);
  const direction = dirOf(score, cfg.minScore);
  let status = 'candidate';
  if (direction === 'HOLD') { status = 'no_trade'; reasons.push('score_below_threshold'); }
  else if (conf < cfg.minConfidence) { status = 'rejected'; reasons.push('confidence_below_minimum'); }
  const valid_until = Math.min(...Object.values(comps).map((p) => p.valid_until), now + cfg.ttlSeconds * 1000);
  return { ...out, direction, score, confidence: conf, status, reason_codes: reasons, valid_until, weights_used: Object.fromEntries(Object.keys(comps).map((a) => [a, r2(cfg.weights[a] / w)])) };
}

/* ---------- trade intents ---------- */
const snap = (p, tick) => Math.round(p / tick) * tick;
/** FNV-1a hash as hex: a short stable key (the audit chain uses SHA-256; this is only for idempotency keys). */
export function hash32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }

/** A candidate trade from a fused signal: quantity from the per-trade risk budget and the stop distance, capped by order value and position size; LIMIT price with a slippage cap. */
export function buildIntent({ fused, sym, price, atr, equity, limits = DEFAULT_LIMITS, strategyId = 'fusion', now = Date.now(), lot = 1, sector = 'Other' }) {
  const side = fused.direction === 'SELL' ? 'SELL' : 'BUY', slip = limits.slippageBps / 1e4, tick = limits.tickSize || 0.05;
  const stopDist = Math.max(atr ? 2 * atr : price * 0.02, price * 0.002), riskAmt = equity * (limits.perTradeRiskPct / 100);
  let q = Math.floor(Math.min(riskAmt / stopDist, limits.maxOrderValue / price, (equity * limits.maxPositionPct) / 100 / price));
  q = Math.floor(q / lot) * lot; if (q < lot) q = 0;
  const limitPrice = r2(snap(side === 'BUY' ? price * (1 + slip) : price * (1 - slip), tick));
  const bucket = Math.floor(now / (limits.duplicateWindowSec * 1000)), key = `${strategyId}|NSE:${sym}|${side}|${bucket}`;
  return { schema_version: '1.0', intent_id: `i-${hash32(key)}-${Math.floor(now / 1000)}`, idempotency_key: hash32(key), client_order_id: `ML${hash32(key)}`.slice(0, 20), strategy_id: strategyId, instrument_id: `NSE:${sym}`, sym, sector,
    side, quantity: q, order_type: 'LIMIT', limit_price: limitPrice, trigger_price: null, stop_loss: r2(snap(side === 'BUY' ? price - stopDist : price + stopDist, tick)), target: r2(snap(side === 'BUY' ? price + 1.5 * stopDist : price - 1.5 * stopDist, tick)),
    max_slippage_bps: limits.slippageBps, expires_at: now + 5 * 60 * 1000, created_at: now, ref_price: price, rationale: { score: fused.score, confidence: fused.confidence, components: fused.components, reason_codes: fused.reason_codes, weights: fused.weights_used }, signal_snapshot_id: `${fused.version}:${sym}:${Math.floor(now / 1000)}` };
}

/* ---------- risk engine ---------- */
/** Pure pre-trade decision. `ctx` = { account, positions [{sym, qty, last, sector}], quote {price, ts, ageSeconds, valueCr}, openOrders, recentIntents [{key, at}], recentOrderTimes [ms], limits, kill, strategyStatus,
 *  brokerConnected, live, startEquity, dayPnl, now }. Every check runs; the decision lists every failure with its code (persisted by the caller). */
export function riskEvaluate(intent, ctx) {
  const L = { ...DEFAULT_LIMITS, ...(ctx.limits || {}) }, now = ctx.now ?? Date.now(), checks = [], add = (code, ok, detail) => checks.push({ code, ok: !!ok, detail });
  const px = ctx.quote && ctx.quote.price, value = intent.quantity * (intent.limit_price || px || 0), eq = ctx.account.equity, pos = (ctx.positions || []).find((p) => p.sym === intent.sym);
  const gross = (ctx.positions || []).reduce((s, p) => s + Math.abs(p.qty) * (p.last || 0), 0), sectorVal = (ctx.positions || []).filter((p) => p.sector === intent.sector).reduce((s, p) => s + Math.abs(p.qty) * (p.last || 0), 0);
  const kill = ctx.kill || {};
  add('KILL_SWITCH', !(kill.global || (kill.strategies || {})[intent.strategy_id] || (kill.instruments || {})[intent.sym]), kill.global ? 'global kill switch is on' : 'strategy or instrument switch is on');
  add('SESSION', !L.sessionOnly || inSession(now), 'the market is closed (Mon to Fri, 9:15 to 15:30 IST)');
  add('INSTRUMENT_ACTIVE', !!intent.sym && /^[A-Z0-9&_-]{1,24}$/.test(intent.sym), 'invalid symbol');
  add('STRATEGY_STATUS', (ctx.strategyStatus || 'active') === 'active', `strategy is ${ctx.strategyStatus}`);
  add('QUANTITY', Number.isInteger(intent.quantity) && intent.quantity > 0, 'quantity must be a whole number above zero');
  add('LOT_SIZE', !ctx.lot || intent.quantity % ctx.lot === 0, `quantity must be a multiple of the lot size ${ctx.lot}`);
  add('TICK_SIZE', intent.order_type === 'MARKET' || Math.abs(intent.limit_price / L.tickSize - Math.round(intent.limit_price / L.tickSize)) < 1e-6, `price must be a multiple of the tick size ${L.tickSize}`);
  add('ORDER_TYPE', intent.order_type === 'LIMIT' || (intent.order_type === 'MARKET' && L.marketOrders), 'market orders are disabled (enable them in the limits)');
  add('SIDE_ALLOWED', intent.side === 'BUY' || L.allowShort || (pos && pos.qty >= intent.quantity), 'selling needs a holding (short selling is off)');
  add('STALE_DATA', !!ctx.quote && ctx.quote.ageSeconds != null && ctx.quote.ageSeconds <= L.staleSeconds && px > 0, `the quote is older than ${L.staleSeconds} s or missing`);
  add('PRICE_BAND', !px || Math.abs(intent.limit_price - px) / px * 100 <= L.maxDeviationPct, `the limit price is more than ${L.maxDeviationPct}% from the last price`);
  add('LIQUIDITY', !ctx.quote || ctx.quote.valueCr == null || ctx.quote.valueCr >= L.minLiquidityCr, `traded value is below Rs ${L.minLiquidityCr} Cr`);
  add('ORDER_VALUE', value <= L.maxOrderValue, `order value ${Math.round(value)} is above the limit ${L.maxOrderValue}`);
  add('POSITION_SIZE', intent.side === 'SELL' || ((pos ? pos.qty * (pos.last || px) : 0) + value) / eq * 100 <= L.maxPositionPct, `the position would exceed ${L.maxPositionPct}% of the account`);
  add('GROSS_EXPOSURE', intent.side === 'SELL' || (gross + value) / eq * 100 <= L.maxGrossPct, `gross exposure would exceed ${L.maxGrossPct}% of the account`);
  add('SECTOR_EXPOSURE', intent.side === 'SELL' || (sectorVal + value) / eq * 100 <= L.maxSectorPct, `the ${intent.sector} sector would exceed ${L.maxSectorPct}% of the account`);
  add('CASH', intent.side === 'SELL' || value <= (ctx.account.cash ?? Infinity), 'not enough cash');
  const risk = Math.abs((intent.ref_price ?? px ?? 0) - (intent.stop_loss ?? 0)) * intent.quantity;
  add('TRADE_RISK', !intent.stop_loss || risk / eq * 100 <= L.perTradeRiskPct * 1.2, `risk to the stop is above ${L.perTradeRiskPct}% of the account`);
  add('DAILY_LOSS', !(ctx.dayPnl < 0) || Math.abs(ctx.dayPnl) / (ctx.startEquity || eq) * 100 < L.dailyLossPct, `today's loss has reached ${L.dailyLossPct}% of the account`);
  add('OPEN_ORDERS', (ctx.openOrders || 0) < L.maxOpenOrders, `${L.maxOpenOrders} orders are already open`);
  add('DUPLICATE_INTENT', !(ctx.recentIntents || []).some((r) => r.key === intent.idempotency_key && now - r.at < L.duplicateWindowSec * 1000), 'the same intent was already submitted in the duplicate window');
  add('ORDER_RATE', (ctx.recentOrderTimes || []).filter((t) => now - t < 1000).length < L.maxOps, `more than ${L.maxOps} orders in one second`);
  add('EXPIRY', !intent.expires_at || intent.expires_at > now, 'the intent has expired');
  add('COMPLIANCE_TAG', !!intent.client_order_id && /^[A-Za-z0-9]{1,20}$/.test(intent.client_order_id), 'the order needs an algo tag (alphanumeric, up to 20 characters)');
  if (ctx.live) add('BROKER_CONNECTED', !!ctx.brokerConnected, 'the broker is not connected');
  const failed = checks.filter((c) => !c.ok);
  return { intent_id: intent.intent_id, decision: failed.length ? 'REJECT' : 'APPROVE', reason_codes: failed.map((c) => c.code), failures: failed.map((c) => ({ code: c.code, detail: c.detail })), checks, calculated_exposure: { orderValue: Math.round(value), gross: Math.round(gross + value), grossPct: r2((gross + value) / eq * 100) },
    limits_snapshot: L, decided_at: now, risk_engine_version: 'risk-1' };
}

/* ---------- execution ---------- */
export const STATES = ['CREATED', 'RISK_APPROVED', 'SUBMITTING', 'SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'CANCELLED', 'REJECTED', 'UNKNOWN'];
const NEXT = { CREATED: ['RISK_APPROVED', 'REJECTED'], RISK_APPROVED: ['SUBMITTING', 'CANCELLED'], SUBMITTING: ['SUBMITTED', 'REJECTED', 'UNKNOWN'], SUBMITTED: ['ACKNOWLEDGED', 'REJECTED', 'FILLED', 'PARTIALLY_FILLED', 'UNKNOWN', 'CANCEL_REQUESTED'],
  ACKNOWLEDGED: ['PARTIALLY_FILLED', 'FILLED', 'CANCEL_REQUESTED', 'REJECTED', 'UNKNOWN'], PARTIALLY_FILLED: ['FILLED', 'CANCEL_REQUESTED', 'UNKNOWN'], CANCEL_REQUESTED: ['CANCELLED', 'FILLED', 'PARTIALLY_FILLED', 'UNKNOWN'],
  UNKNOWN: ['SUBMITTED', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED'], FILLED: [], CANCELLED: [], REJECTED: [] };
export const TERMINAL = new Set(['FILLED', 'CANCELLED', 'REJECTED']);

export function advance(order, to, at = Date.now(), note = '', patch = {}) {
  if (!(NEXT[order.status] || []).includes(to)) throw new Error(`illegal order transition ${order.status} -> ${to}`);
  return { ...order, ...patch, status: to, updated_at: at, history: [...order.history, { state: to, at, note }] };
}

export const newOrder = (intent, now = Date.now()) => ({ client_order_id: intent.client_order_id, broker_order_id: null, intent_id: intent.intent_id, strategy_id: intent.strategy_id, sym: intent.sym, status: 'CREATED', side: intent.side, quantity: intent.quantity, filled_quantity: 0, average_price: null,
  order_type: intent.order_type, limit_price: intent.limit_price, order_payload: null, broker_response: null, submitted_at: null, updated_at: now, history: [{ state: 'CREATED', at: now, note: '' }] });

/** Run an approved intent through the state machine. `deps.broker` = { name, place(payload) -> {status:'FILLED'|'ACKNOWLEDGED'|'REJECTED', broker_order_id, price, filled, reason} , get(id) };
 *  `deps.orders` is the existing book (for idempotency). A timeout or broker error leaves the order UNKNOWN: it is never re-sent; reconcile() re-queries it. */
export async function execute(intent, decision, deps) {
  const now = deps.now ? deps.now() : Date.now(), existing = (deps.orders || []).find((o) => o.client_order_id === intent.client_order_id);
  if (existing) return { order: existing, duplicate: true };                                     // idempotency: the same intent is never sent twice
  let o = newOrder(intent, now);
  if (decision.decision !== 'APPROVE') return { order: advance(o, 'REJECTED', now, decision.reason_codes.join(',')) };
  o = advance(o, 'RISK_APPROVED', now, decision.risk_engine_version);
  const payload = { tradingsymbol: intent.sym, exchange: 'NSE', transaction_type: intent.side, order_type: intent.order_type, quantity: intent.quantity, price: intent.limit_price, product: 'CNC', validity: 'DAY', tag: intent.client_order_id };
  o = advance(o, 'SUBMITTING', now, deps.broker.name); o = { ...o, order_payload: payload, submitted_at: now };
  let res;
  try { res = await deps.broker.place(payload); } catch (e) { return { order: advance(o, 'UNKNOWN', now, `no answer: ${String(e.message || e).slice(0, 100)}`), unknown: true }; }
  o = { ...o, broker_response: res };
  if (res.status === 'REJECTED') return { order: advance(o, 'REJECTED', now, res.reason || 'rejected by broker') };
  o = advance(o, 'SUBMITTED', now, 'accepted'); o = { ...o, broker_order_id: res.broker_order_id || null };
  if (res.status === 'FILLED') return { order: advance(o, 'FILLED', now, 'filled', { filled_quantity: res.filled ?? intent.quantity, average_price: res.price }), fill: { price: res.price, quantity: res.filled ?? intent.quantity } };
  if (res.status === 'PARTIALLY_FILLED') return { order: advance(advance(o, 'ACKNOWLEDGED', now, 'open'), 'PARTIALLY_FILLED', now, 'partial', { filled_quantity: res.filled, average_price: res.price }) };
  return { order: advance(o, 'ACKNOWLEDGED', now, 'open') };
}

/** Ask the broker where an UNKNOWN or open order stands and move it there. Returns the updated order and whether anything changed. */
export async function reconcileOrder(order, broker, now = Date.now()) {
  if (TERMINAL.has(order.status) || !order.broker_order_id && order.status !== 'UNKNOWN') return { order, changed: false };
  let r; try { r = await broker.get(order.broker_order_id, order.client_order_id); } catch (e) { return { order, changed: false, error: String(e.message || e) }; }
  if (!r || !r.status) return { order, changed: false };
  const to = r.status; if (to === order.status) return { order, changed: false };
  try { return { order: advance(order, to, now, 'reconciled', { filled_quantity: r.filled ?? order.filled_quantity, average_price: r.price ?? order.average_price, broker_order_id: r.broker_order_id || order.broker_order_id }), changed: true }; } catch (e) { return { order, changed: false, error: e.message }; }
}

/** Compare filled orders with the account's positions: any difference is a reconciliation break (3 repeated breaks should pause trading). */
export function reconcilePositions(orders, positions) {
  const fromOrders = {}; for (const o of orders) if (o.status === 'FILLED' || o.status === 'PARTIALLY_FILLED') fromOrders[o.sym] = (fromOrders[o.sym] || 0) + (o.side === 'BUY' ? 1 : -1) * o.filled_quantity;
  const have = Object.fromEntries((positions || []).map((p) => [p.sym, p.qty])), syms = new Set([...Object.keys(fromOrders), ...Object.keys(have)]), breaks = [];
  for (const s of syms) { const a = fromOrders[s] || 0, b = have[s] || 0; if (a !== b) breaks.push({ sym: s, desk: a, account: b, difference: b - a }); }
  return { ok: !breaks.length, breaks };
}

/** Paper broker: fills a marketable limit immediately at the reference price plus slippage (never worse than the limit); a limit away from the market stays open. */
export function paperBroker({ priceOf, slippageBps = 15, place: settle }) {
  return { name: 'paper', async place(p) {
    const last = priceOf(p.tradingsymbol); if (!(last > 0)) return { status: 'REJECTED', reason: 'no price' };
    const slip = slippageBps / 1e4, fillPx = p.transaction_type === 'BUY' ? Math.min(p.price, last * (1 + slip)) : Math.max(p.price, last * (1 - slip));
    const marketable = p.transaction_type === 'BUY' ? p.price >= last : p.price <= last;
    if (!marketable) return { status: 'ACKNOWLEDGED', broker_order_id: `PAPER-${p.tag}` };
    const px = r2(fillPx); if (settle) { const r = settle({ sym: p.tradingsymbol, side: p.transaction_type, qty: p.quantity, price: px, note: `desk ${p.tag}` }); if (r && r.error) return { status: 'REJECTED', reason: r.error }; }
    return { status: 'FILLED', broker_order_id: `PAPER-${p.tag}`, price: px, filled: p.quantity };
  }, async get() { return null; } };
}

/* ---------- audit log ---------- */
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256(text) { return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }

/** Append-only, hash-chained event log: each entry carries the SHA-256 of the previous entry's hash and its own content, so any edit breaks verify(). `kv` = { get(key), set(key, value) }. */
export class AuditLog {
  constructor(kv, key = 'ml.desk.audit', cap = 4000) { this.kv = kv; this.key = key; this.cap = cap; }
  load() { const v = this.kv.get(this.key, null); return v && Array.isArray(v.entries) ? v : { anchor: '0'.repeat(64), entries: [] }; }
  async append(type, data = {}, at = Date.now()) {
    const log = this.load(), prev = log.entries.length ? log.entries[log.entries.length - 1].hash : log.anchor, body = JSON.stringify({ type, data, at });
    const entry = { seq: (log.entries.length ? log.entries[log.entries.length - 1].seq : 0) + 1, at, type, data, prev, hash: await sha256(prev + body) };
    log.entries.push(entry); if (log.entries.length > this.cap) { const cut = log.entries.splice(0, log.entries.length - this.cap); log.anchor = cut[cut.length - 1].hash; }
    this.kv.set(this.key, log); return entry;
  }
  async verify() {
    const log = this.load(); let prev = log.anchor;
    for (const e of log.entries) { const h = await sha256(prev + JSON.stringify({ type: e.type, data: e.data, at: e.at })); if (e.prev !== prev || e.hash !== h) return { ok: false, brokenAt: e.seq, entries: log.entries.length }; prev = e.hash; }
    return { ok: true, entries: log.entries.length, head: prev };
  }
  toCsv() { return ['seq,time,type,hash,data', ...this.load().entries.map((e) => [e.seq, new Date(e.at).toISOString(), e.type, e.hash, JSON.stringify(e.data).replace(/"/g, '""')].map((x) => (/[",\n]/.test(String(x)) ? `"${x}"` : x)).join(','))].join('\n'); }
}

/* ---------- desk state ---------- */
export const newDesk = () => ({ version: 1, mode: 'research', strategyStatus: 'active', limits: { ...DEFAULT_LIMITS }, fusion: JSON.parse(JSON.stringify(FUSION_DEFAULT)), kill: { global: false, strategies: {}, instruments: {}, reason: '', at: null },
  intents: [], decisions: {}, orders: [], incidents: [], recentOrderTimes: [], checklist: {}, reconBreaks: 0, startEquityDay: null });
export function normalizeDesk(raw) { try { if (!raw || raw.version !== 1) return newDesk(); const d = newDesk(); return { ...d, ...raw, limits: { ...d.limits, ...(raw.limits || {}) }, fusion: { ...d.fusion, ...(raw.fusion || {}), weights: { ...d.fusion.weights, ...((raw.fusion || {}).weights || {}) } }, kill: { ...d.kill, ...(raw.kill || {}) } }; } catch (e) { return newDesk(); } }
