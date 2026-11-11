# Trading desk: signals, risk, orders, operator

This describes the desk added from the "AI-Assisted Systematic Trading Platform" requirements (PRD and technical specification). It is built inside MarketLens as it is (a local app: Python standard-library server,
no-build browser UI, an on-device engine on the phone), not as the FastAPI / Postgres / Redis microservice stack the specification sketches. Everything that already existed (paper account, strategy lab,
option lab, chart analysis, news sentiment, audit log, rate limits) is reused, not rebuilt.

## What was added

| Page | Route | What it does |
|---|---|---|
| Signals | `#/signals` | Five deterministic agents (technical, news, fundamental, derivatives, regime) emit schema-checked proposals; versioned weighted fusion with missing-agent and conflict handling; a candidate becomes a trade intent |
| Orders & risk | `#/orders` | Order blotter with each order's state history; intents waiting for approval; risk limits and the last decision's checks; a test ticket through the full pipeline; reconciliation |
| Operator | `#/ops` | Feed and data health, trading mode, kill switches, incidents, the verifiable audit log (CSV export), the pre-live checklist |
| Fundamentals | `#/fundamentals` | Seven screens and a 0 to 100 scorecard from the data NSE publishes; sector valuation; a list of what cannot be computed |
| Settings | `#/settings` | Theme, trading defaults, and the Zerodha (Kite Connect) connection (desktop only, see [BROKER.md](BROKER.md)) |

Code: rules in `desk-core.js` (pure, unit-tested), runtime in `desk.js`, pages in `signals-view.js`, `orders-view.js`, `ops-view.js`, `fundamentals-view.js` (rules in `fund-screens.js`), `settings-view.js`; server side `broker.py`.

## The pipeline

```
data -> agents (proposals) -> fusion -> intent -> risk engine -> mode -> broker (paper / shadow / Zerodha) -> order state machine -> audit log
```

* **Agents** read data the app already has and return `agent.proposal.v1`-shaped records (direction, score -1..1, confidence, validity window, evidence references, reason codes, model version). Malformed or expired output is treated as missing. Agents cannot place orders: they are pure functions.
* **Fusion** (`fusion-N`): default weights news 0.35, technical 0.25, fundamental 0.20, derivatives 0.10, regime 0.10 (from the specification), renormalised over the agents that answered. The technical agent is required. If two strong agents (|score| of 0.4 or more, confidence 0.5 or more) disagree, score and confidence are cut by the conflict penalty. Component scores are returned for attribution. Weights are versioned; every change is audited.
* **Intent**: quantity from the per-trade risk budget and a 2 x ATR stop, capped by the order-value limit and the position-size limit; LIMIT price with a slippage cap and tick alignment; stop and target; an idempotency key and an algo tag (alphanumeric, at most 20 characters) derived from strategy, instrument, side and a time window.
* **Risk engine** (`riskEvaluate`, pure; 24 checks plus the four backtest-gate checks): every check always runs and every failure is listed with a reason code: kill switch (global, strategy, instrument), session hours, instrument, strategy status, quantity, lot size, tick size, order type (market orders off by default), short selling, stale data, price band, liquidity, order value, position size, gross exposure, sector exposure, cash, risk to the stop, daily loss, open orders, duplicate intent, orders per second, expiry, compliance tag, broker connection (live only). Nothing is silently downgraded.
* **Modes**: research (no execution), shadow (virtual fills, logged, no account change), paper (auto-execute on the paper account, so fills also appear on the Paper trading page), manual approval (each intent waits for your click, the risk engine runs again on fresh data, then it executes on the paper account or Zerodha), live (auto-execute on Zerodha; locked unless the server has `--enable-live-orders`, the broker is connected, the pre-live checklist is complete, and you confirm). Mode changes ask for confirmation and are audited. The default is research.
* **Order state machine**: CREATED, RISK_APPROVED, SUBMITTING, SUBMITTED, ACKNOWLEDGED, PARTIALLY_FILLED, FILLED, CANCEL_REQUESTED, CANCELLED, REJECTED, UNKNOWN, with only the legal transitions. The same intent is never sent twice (idempotency by client order id). A timeout leaves the order UNKNOWN: it is never re-sent; reconciliation asks the broker where it stands (by id or by tag). Three reconciliation breaks in a row pause trading and open an incident.
* **Audit log**: append-only and hash-chained (SHA-256 of the previous entry's hash plus the entry), stored per user in the browser or app, verifiable and exportable. It records signal runs, weight changes, intents with their rationale, risk decisions with every reason, approvals, orders and state paths, reconciliation, mode changes, limit changes, checklist ticks and the kill switch. Broker actions (login, orders, kill switch) are also written to the server's existing audit log, which does not contain secrets.

## The backtest gate (before any trade)
Before an intent can exist, the strategy that would make the trade is backtested on up to **ten years** of NSE daily history and the result is shown to you; a trade whose strategy does not clear the gate is blocked.
* **What runs** (`backtest-gate.js`, `desk-backtest.js`): the Signals page fetches `/api/history/<symbol>?range=10Y` (40 pieces of three months from NSE, about 30 s the first time, then saved), runs 18 candidate strategies from the lab with their **default** settings (nothing is tuned), with fees, slippage, a start of Rs 10 lakh and signals acting on the next close, and picks the one with the best result on the **unseen last 30 percent** of the period per unit of drawdown among those that clear the gate. The report has the full-period return, per-year return, worst fall, trades, win rate, Sharpe, buy and hold, the unseen-period result, four consecutive periods, yearly returns, today's position of the strategy, and the verdict.
* **Honest coverage**: ten years are requested; NSE returns what it has, and the report says how many years were actually used. The gate fails below the minimum (default 3 years).
* **Thresholds** (Signals page, saved and audited): minimum years 3, closed trades 8, worst fall 45 percent, unseen-period return above 0, at least 2 of 4 periods profitable, backtest valid for 24 hours.
* **Shown before the trade**: pressing *Intent* opens the report; a passing report offers *Continue to the risk engine*, a failing one only closes. The same report appears on the Orders page test ticket.
* **Enforced by the risk engine** (four more checks, 28 in all): `BACKTEST_PRESENT`, `BACKTEST_GATE`, `BACKTEST_FRESH`, and `STRATEGY_SIGNAL` (the strategy must say long today for a buy, and not long for a sell). The intent carries a compact copy of the report and the trade is attributed to that strategy. The report summary is written to the audit log. The gate is required by default; it can be switched off only in the risk limits, for testing.
* A backtest describes the past of one stock; it is evidence, not a forecast, and a passing strategy can still lose money.

## Requirements coverage

| Requirement (PRD / spec) | Status |
|---|---|
| FR-1 market data: quotes, LTP, OHLC, volume, timestamps, stale and gap detection | Existing live feed (NSE tools); the Operator page shows lag, gaps, reconnects and clock skew. Depth, open interest ticks and a Kite WebSocket are not included |
| FR-2 historical data, replay, no look-ahead | Daily OHLCV history up to ten years; strategies act on the next close (tested); the backtest gate above. A tick-level replay engine is not included |
| FR-3 news and event intelligence | Existing headline sentiment (Yahoo, Google) feeds the news agent. Licensed newswire adapters, entity linking and LLM classification are not included |
| FR-4 technical analysis | Chart analysis page, `ta.js`, 65 backtestable strategies |
| FR-5 fundamental analysis | Fundamentals page on what NSE publishes (dividends, 52-week range, valuation). No financial statements exist in the feeds, so earnings-based screens are listed as unavailable, not approximated. Point-in-time snapshots are not stored |
| FR-6 derivatives analysis | Option chain, 41 option strategies, derivatives agent (PCR, max pain). Futures basis and rollover features are not included |
| FR-7 AI agents | Deterministic rule-based agents with schema validation, expiry and no order access. No LLM-backed agent (the specification allows LLMs only for extraction and classification) |
| FR-8 signal fusion | Done (weights, missing, conflict, expiry, minimum confidence, attribution) |
| FR-9 risk engine | Done (list above); tested rule by rule |
| FR-10 execution | Limit orders, idempotency, state machine, no blind retry, reconciliation. Bracket workflows are not included. Market orders are off by default |
| FR-11 modes | Research, shadow, paper, manual approval, live (locked by default). A separate backtest mode is the Strategy lab |
| FR-12 monitoring and alerts | Health page. Email, Telegram or webhook alerts are not included |
| FR-13 audit and reproducibility | Hash-chained log with inputs' summaries, weights version, risk decision, order path. Full raw-input storage for exact replay is not included |
| Zerodha adapter (login, margins, positions, orders) | Done for the desktop app, see [BROKER.md](BROKER.md); not tested against Zerodha's live servers |
| Static IP, registration, tagging | Cannot be arranged by software: the pre-live checklist and the tag on every order cover what the app can |
| Kill switch halting orders within one second inside the application | Done: checked before every order and mirrored to the server gate |
| Latency (the request for 1 ms) | The in-process decision, feed-apply and ingestion paths are under 1 ms and measured; network hops cannot be: see [LATENCY.md](LATENCY.md) |
| Postgres, Redis, event bus, Kubernetes, Prometheus, multi-service layout | Not used: single local app by design (see [ARCHITECTURE.md](ARCHITECTURE.md)). `/api/metrics` and the audit log cover the local equivalents |
| Operator UI with MFA and role-based access | Single-user local app with the existing sign-in; no roles or MFA |

Nothing here is investment advice and nothing guarantees a profit; the live path is off unless you enable it on purpose.
