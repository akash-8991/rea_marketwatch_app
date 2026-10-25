# Assessment: current state, findings, measurements

Scope: MarketLens as a single-user local app (one process, one browser, loopback). Findings that only matter for a
multi-user hosted service are listed as "not applicable here" rather than built.

## Stack
Python 3.9+ standard library only (HTTP server, SQLite, urllib). Front end: plain ES modules, no build step, no
framework, no third-party scripts or fonts. Data: NSE MCP servers (prices, history, corporate actions), Yahoo Finance
and Google News RSS (headlines), CSVs the user downloads (option chain).

## Findings and what was done

| # | Problem (evidence) | Change | Result |
|---|---|---|---|
| 1 | **88.7% of requests failed at 16 concurrent clients** (115,067 of 129,778, connection resets). Cause confirmed with a diagnostic run: 13,134 `ECONNRESET` vs 25,502 successes. Python's listen backlog was 5 and the server spoke HTTP/1.0 (one new connection per request). | HTTP/1.1 keep-alive, listen backlog 128, cap on open connections (256) and in-flight requests (64, then 503 + `Retry-After`). | **0% errors** at 16 clients (18,415 requests) and in a 60 s soak (143,374 requests). |
| 2 | Responses were not compressed or revalidated: `app.js` 55.5 KB and `/api/bootstrap` 36 KB on the wire. | gzip, ETag and `If-None-Match` (304) for static files; gzip for JSON over 1 KB. | `app.js` 16.6 KB (-70%), `/api/bootstrap` 7.0 KB (-80%). Cost: `/api/bootstrap` p50 at 1 client 1.03 → 1.29 ms (compression CPU). |
| 3 | **CLS 0.486 (home) and 0.826 (screener)**, rated "poor" (> 0.25). The footer and status banner jumped as the page filled in. | Reserved page height, banner height and skeleton height. | CLS **0.0014** on both. |
| 4 | Directory listings were served for `/js/` and `/css/`; a missing file crashed the request logger and returned an empty reply. | Own static handler (no listings, path confined to the static folder); logger fixed; regression tests. | 404 for missing paths and traversal attempts. |
| 5 | A flood of rejected requests would itself fill the log (52,446 lines in one 6 s flood). | 429/503 responses are summarised: one log line per route per 5 s, one audit row per class per minute. | 762 lines for a comparable flood. |
| 6 | Audit log: no request correlation, no outcome, an import could in theory succeed without its audit row, no schema version. | Audit schema v2 (uid, outcome, request id, channel), in-place migration that keeps old rows verifiable, snapshot and audit row committed in one transaction. | 6 new tests, including a migration of a v1 database and a forced audit failure (the import rolls back). |
| 7 | No health, readiness, metrics or request IDs. | `/healthz`, `/readyz`, `/api/metrics` (route templates only), `X-Request-ID`, JSON request logs. | Bounded labels verified (30 distinct symbols collapse to one route label). |
| 8 | Page overflowed horizontally on a 360 px phone (Markets table, 554 px). | Controlled horizontal scrolling for wide tables, responsive nav, bottom-sheet popovers. | All 8 pages fit at 360, 768, 1280 and 2560 px. |
| 9 | Colours were hard-coded and not checked for contrast. | Semantic tokens, light and dark; contrast recomputed from the stylesheet in a test. | Text ≥ 5.3:1, control borders ≥ 3.4:1 (WCAG 2.2 AA needs 4.5 and 3). |

## Before / after (same script, same machine, loopback, offline mode with a saved snapshot)

Load test: `python tools/loadtest.py --concurrency 1 16 --seconds 8`. Raw output is in `docs/perf-*.json`.

| | Baseline | After (limiter off) |
|---|---|---|
| 1 client: throughput | 1,804 req/s, 0 errors | 2,008 req/s, 0 errors |
| 1 client: `/api/stock/RELIANCE` p50 / p95 / p99 | 0.79 / 1.08 / 1.54 ms | 0.79 / 0.91 / 1.08 ms |
| 1 client: `/api/bootstrap` p50 / p95 / p99 | 1.03 / 1.32 / 1.80 ms | 1.29 / 1.61 / 1.94 ms |
| 16 clients: errors | **88.7%** | **0%** |
| 16 clients: successful throughput | 14,711 OK in 8 s | 18,415 OK in 8 s (2,296 req/s) |
| 16 clients: p95 / p99 across endpoints | not meaningful (most requests failed) | 2.9–14.5 ms / 3.7–17.9 ms |
| 60 s soak, 4 clients | not run | 143,374 req, 0 errors, worst p99 5.1 ms, RSS +3.1 MB |
| Home page critical path (html+css+js) | 70.0 KB raw, not compressed | 79.9 KB raw, **25.0 KB gzip** (screener module, 8.7 KB gzip, loads only when opened) |
| CLS home / screener | 0.486 / 0.826 | 0.0014 / 0.0014 |

With the default limits on, the same 16-client flood got 2,565 successes and 51,473 `429`s (95%); the server stayed
responsive, wrote 3 audit rows, and normal use (about 3 requests/s) was served again after the buckets refilled.

## Interaction latency (measured in the browser)
Switching screener views, and typing in the symbol filter, each reached the next painted frame in ≈ 33 ms; this is two
animation frames at 60 Hz, the floor of the method used. Target: under 100 ms. Met in these tests.

## What could not be measured, and why
- **LCP / FCP**: the embedded browser pane reports paint timings only once a tab is visible, so the values were
  meaningless (49 s). Measure in a normal foreground browser: `/api/metrics` → `webVitals` aggregates what real page
  loads report.
- **Real network behaviour, other machines, other OSes, long soaks (hours), memory leaks over days**: not tested.
  The 60 s soak grew RSS by 3.1 MB; that is not enough to conclude there is no leak.
- **NSE, Yahoo and Google latency and availability** are outside this app's control and were not load-tested (doing so
  against NSE is what got this machine blocked once; see OPERATIONS.md).
- **Screen readers**: automated checks and a keyboard walkthrough only; no assistive-technology testing.

## Not applicable to this app (deliberately not built)
Multi-tenant isolation, authentication and roles (single local user, loopback only), distributed rate limiting
(single process), message brokers, WebSockets/SSE (see ARCHITECTURE.md), read replicas, CDN.

## Remaining risks and next steps (by value)
1. Run the app for a day against live NSE and read `/api/metrics` and the request log; the hardening above was tested
   offline (NSE has been blocking this machine, see OPERATIONS.md).
2. The option-chain CSV parser has only been tested on synthetic files in NSE's layout, never a real download.
3. Sentiment is keyword counting and skews positive; treat as a hint.
4. Sector labels are a static map for about 60 names; everything else shows no sector.
5. Add real-browser end-to-end tests (Playwright) if the UI grows further.
