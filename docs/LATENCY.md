# Latency: what is under 1 ms and what cannot be

The request was for data refresh, data ingestion and trading to happen within 1 ms. Inside this app that is true of everything the app itself computes, and it is measured, tested and shown on the Operator
page. It cannot be true of the network: NSE's servers, Yahoo Finance and Zerodha are hundreds of milliseconds away, so a price cannot reach this app, or an order reach Zerodha, in 1 ms whatever the software does.
The requirements document itself sets its signal-to-order target at 500 ms and says the product is "near-HFT, not true exchange co-located HFT". So there are two kinds of stage:

| Stage | Where | Budget | Measured (p50 / p99, this Mac) |
|---|---|---|---|
| Apply a feed answer (40 stocks and the indices) to the shared data | browser, `applyFeed` | 1 ms | 0.002 ms / 0.008 ms |
| Fuse five agents' proposals | browser, `fuse` | 1 ms | 0.002 ms / 0.010 ms |
| Build a trade intent | browser, `buildIntent` | 1 ms | 0.002 ms / 0.003 ms |
| Risk engine (24 checks, 28 with the backtest gate) | browser, `riskEvaluate` | 1 ms | 0.001 ms / 0.003 ms |
| Execute on the paper or shadow broker (state machine, idempotency) | browser, `execute` | 1 ms | 0.001 ms / 0.003 ms |
| Signal to order, whole path (fuse, intent, risk, execute) | browser | 1 ms | 0.008 ms / 0.059 ms (rare maximum 1.6 ms: a garbage-collection pause) |
| Queue an audit entry | browser | 1 ms | hashing and saving happen off the path |
| Serve a fully cached live feed (12 symbols) | server, `market.live_feed` | 1 ms | 0.094 ms / 0.32 ms |
| Record a tick (ingestion) | server, `ticks.record` | 1 ms | 0.002 ms / 0.006 ms |
| HTTP round trip to the local server for `/api/live` (keep-alive) | page to server | none (a few ms on slower machines and phones) | 0.12 ms / 0.56 ms |
| Repaint the page | browser DOM | none | about 4 ms / 11 ms |
| Fetch a quote from NSE | network | none | hundreds of ms |
| Fetch history (Yahoo, NSE), place an order at Zerodha | network | none | hundreds of ms or more |

The numbers are from `node tools/bench-desk.mjs` and `python3 tools/bench-latency.py` (5,000 and 2,000 iterations); yours will differ. The tests (`mobile/tests/backtest-latency.test.mjs`, `tests/test_live_feed.py`) fail if the in-process
path's median or 95th percentile goes over the budget. Browsers round timer readings (often to 0.1 ms or more), so on the Operator page tiny stages read as "0.0 µs" or "0.1 ms"; the Node benchmark has the fine-grained numbers.

## What was changed to get there
* The risk engine, fusion and execution were already plain in-memory functions. What cost time was bookkeeping around them, now off the path: the **audit log** hashes and saves in the background (`AuditLog` queues entries in order; saving is batched; `flush()` before verify or export) instead of rewriting the whole log on every entry, and the **desk state** is held in memory and written to storage a moment after a change.
* The server's **quote path** answers from memory without a worker-thread hop when a quote is fresh, and a feed answer for symbols that are all fresh uses no thread pool. A fully cached 12-symbol feed went from milliseconds to about 0.1 ms.
* `ticks.record` and `applyFeed` are O(1) per tick and per symbol.

## Where each hop is slow, and what the app does about it
The page asks the local server every 100 ms and repaints only what changed. The server asks NSE at most 10 stock-quote calls a second in total and reuses a quote for up to a second (NSE's own tool says it updates about once a minute), so a long list is refreshed proportionally less often rather than with more requests. The Operator page, Latency tab, shows every stage with p50, p95, p99, max, and the count of samples over budget, and has a 2,000-run benchmark button. Orders to Zerodha are as fast as Kite Connect answers; the app never retries an order whose outcome is unknown (see [DESK.md](DESK.md)).
