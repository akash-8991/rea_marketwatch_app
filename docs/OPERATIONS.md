# Operations guide

## Run
```bash
marketlens                       # http://127.0.0.1:8080/
marketlens --offline             # serve saved snapshots only, never call NSE
marketlens --audit 20            # print the last 20 audit entries and verify the hash chain (exit 1 if broken)
```
Flags and environment: see the README table. Extra: `--no-rate-limit` (benchmarking on your own machine only).
Environment variables: `NSE_CM_MCP_URL`, `NSE_BHAVCOPY_MCP_URL`, `NSE_FO_MCP_URL`. No secrets are required or stored.

## Endpoints for operators
| Endpoint | Purpose |
|---|---|
| `GET /healthz` | **Liveness**: the process answers. No dependencies checked. |
| `GET /readyz` | **Readiness**: data folder writable, SQLite opens, and a saved snapshot exists or NSE is reachable. `503` otherwise. |
| `GET /api/metrics` (phone engine too) | Per-route request counts by status class, latency p50/p95/p99/max (last 2,000 requests per route), in-flight gauge, counters (`rate_limited`, `load_shed`, `internal_errors`, `connections_refused`), web vitals from real page loads, **data age** per dataset, NSE breaker state, scheduler state. Labels are route templates, never raw paths or IDs. |
| `GET /api/audit?limit=N` | Recent audit entries and whether the hash chain verifies. |
| `GET /api/quote/<SYMBOL>[?fresh=1]` | lean quote: price, change, last-trade time and age, company, a status (`live`, `delayed`, `closed`, `stale`, `unavailable`). One NSE call, shared by simultaneous callers, cached 30 s while the market trades and 15 min otherwise; `fresh=1` bypasses the cache at most once per symbol per 5 s; answers from the saved copy (`stale`) if NSE has not replied in 6 s |
| `GET /api/live?symbols=A,B,…` | the one-second feed (rate class `live`: 120 burst, 40 a second): headline indices, sector tiles and up to 40 stocks or indices (`IDX_` keys come back as quotes) (price, change, open, high, low, volume, status), the market state and the interval the page should use (1 s open, 30 s closed) |
| `GET /api/candles/<SYMBOL or IDX_key>?tf=5m\|15m\|1h` | intraday candles `[epoch s, open, high, low, close, volume]` from Yahoo Finance's chart endpoint (cached 1 min while the market trades, 15 min otherwise; `available:false` with the reason when Yahoo cannot be reached, offline mode is on, or the index has no Yahoo ticker) |
| `GET /api/intraday/<SYMBOL or IDX_key>` | one-minute bars `[epoch s, open, high, low, close, volume]` for the last 5 days, recorded from live quotes while the app was open (NSE keeps daily history only); the chart page builds 5 min, 15 min and hourly candles from them |
| `GET /api/quotes?symbols=A,B,…` | the same for up to 50 symbols at once (invalid and duplicate symbols handled), order kept |
| `GET /api/history/<SYMBOL or IDX_key>?range=1W\|1M\|3M\|6M\|1Y\|5Y\|10Y` | daily candles `[date, close, volume, open, high, low]` (the chart offers up to 1Y; 5Y and 10Y serve the strategy lab); NSE's history starts 1 Jan 2024 so long ranges are truncated and say so; fetched in 3-month pieces and saved for 12 h; `1D` answers `available:false` with the reason (no intraday data exists) |
| `GET /api/peers/<SYMBOL>` | peer comparison for one stock (same industry, most traded); about 11 NSE calls, cached a minute |
| `GET /api/config` | Version, flags, the rating thresholds, the active rate limits. |

## Provisional service objectives (local loopback, validate before relying on them)
| Objective | Target | Measured here |
|---|---|---|
| Local interaction to next frame | < 100 ms | ≈ 33 ms (2 frames) |
| Cached or simple API p95 | < 100 ms | 0.2–1.6 ms (1 client), ≤ 14.5 ms (16 clients) |
| Backend p95 excluding upstream | < 200 ms | same as above (upstream excluded) |
| Data freshness (live mode) | the screens re-check every second; a quote is reused for at most 1 s (more with many symbols: see the budget below); flagged **Delayed** after 10 min | not verified against live NSE: NSE's tool states about one update a minute |
| Errors under 16 clients | 0 | 0 |
These are engineering targets, not guarantees. No claim is made for sub-millisecond or guaranteed refresh rates.

## Rate limits (per client address, per process; token buckets)
| Class | Applies to | Burst | Sustained |
|---|---|---|---|
| static | HTML, JS, CSS | 400 | 200/s |
| read | cheap API reads from local snapshots | 300 | 100/s |
| expensive | `/api/stock/*`, `/api/search`, `/api/news/*`, `/api/options` (may call NSE, Yahoo or Google) | 40 | 4/s |
| write | CSV import, web vitals | 10 | 0.5/s |
`429` carries `Retry-After`. Health probes are exempt. Beyond 64 in-flight requests the server answers `503` +
`Retry-After: 1`; beyond 256 open connections new ones are refused. If the limiter itself fails, requests are allowed
and an error is logged.

## Audit log
SQLite table `audit_log` in `marketlens.db`; append-only (triggers refuse UPDATE/DELETE) and hash-chained.
Schema v2 fields: `id`, `uid` (random event id), `ts` (UTC), `event`, `actor`, `symbol`, `snapshot_id`, `detail`
(≤ 500 chars, never request bodies or secrets), `sha256` (of the imported data), `outcome` (`ok` / `denied` / `error`),
`request_id` (equals the `X-Request-ID` of the originating request), `channel` (`web`, `mcp`, `inbox`, `system`,
`internal`), `schema_ver`, `prev_hash`, `entry_hash`.

| Events | Meaning |
|---|---|
| `import_ok`, `import_duplicate`, `import_rejected`, `fetch_ok`, `fetch_failed` | option-chain data in; the success row is committed **with** the snapshot |
| `scan` | the scheduler did something (idle scans are not logged) |
| `rate_limited`, `load_shed` | at most one row per class per minute, outcome `denied` |
| `upstream_blocked` | NSE refused us (401/403/429); NSE traffic paused 15 min |
| `startup` | process start with non-secret settings |
| `securities_updated`, `securities_update_failed` | the weekly refresh of the stock list (how many stocks, added, removed, industry changes), or why the saved list was kept |
Not logged here: high-frequency telemetry (that is `/api/metrics`), authentication (there is none).
Retention: audit rows are never deleted by the app; snapshots keep the newest 300 per symbol and expiry.
Failure behaviour: if the audit write for an import fails, the import rolls back and the user sees an error; for other
events a `{"msg":"audit_write_failed"}` line goes to stderr. Tamper-evidence, not tamper-proof: someone with write
access to the file can rebuild the whole chain. Back up `marketlens.db` (copy it while the app is stopped, or use
SQLite's `.backup`).

### Migration
Opening an older database adds the v2 columns automatically (idempotent). Older rows keep `schema_ver = 1` and their
original hash formula, so the chain verifies across the upgrade. Rollback: v1 code ignores the extra columns, but rows it
writes afterwards will not extend a v2 chain correctly; restore the database from backup if you roll back after writing.

## Accounts
| Event (audit log) | Meaning |
|---|---|
| `signup_ok`, `signup_failed` | account created / refused (duplicate user ID or email) |
| `login_ok`, `login_failed` | sign-in; a lockout is noted in the detail |
| `identity_check_failed`, `user_id_recovered`, `credentials_changed` | recovery and change flows (the detail says *which* things changed, never the values) |
| `password_reset_admin` | `--reset-password` run on the machine (channel `cli`) |
Never recorded: passwords, session tokens, names, emails, dates of birth. The actor is the user ID (or `anonymous` for
failed attempts, so attacker-supplied text cannot be injected into the log).
Tables: `users`, `sessions` (token hashes only), `throttle` (hashed identifiers, failure counts, lockout level).
Sessions: a session lasts 15 days from sign-in (no idle timeout), survives closing the app or browser, and ends on sign-out,
on any credential change, or at 15 days; the UI then returns to the sign-in page. Same on the phone.
Lockouts: 5 consecutive failures per user ID (sign-in) or per email (recovery); 15 min, then 30, 60 ... up to 24 h; a
success clears the counter. An attacker can lock a known user out by failing on purpose; the owner clears it with
`marketlens --reset-password USERID`. `/api/audit` and `/api/metrics` are open to any signed-in user (there are no
administrator roles).
Rotation: change `pbkdf2_iterations` in `config.py` to raise the cost; each stored hash records its own cost, so
existing passwords keep working and are re-hashed only when changed.

## Logs
One JSON line per API request on stderr: `ts`, `level`, `requestId`, `method`, `route` (template), `status`, `bytes`,
`client`, `ms`. Query strings and bodies are never logged. Rejections (429/503) are summarised every 5 s per route.

## Runbook
| Symptom | Likely cause | Action |
|---|---|---|
| Home shows an older date (for example the previous session) | the saved copy is shown while the refresh runs (a few seconds on the phone, about 15 s on the desktop); if it stays old, the banner says why | wait, then check the banner: *Stale* means NSE could not be reached or paused us |
| Status pill says **Stale** (hover it for the reason) and `/api/metrics` → `upstream.nseRetryInSeconds` > 0 | NSE returned 401/403/429; breaker is open (persisted in `breaker.json`) | Wait for the window. Do not restart repeatedly or add retries. Reduce `--option-interval` traffic if you added an endpoint. |
| Status pill says **Disconnected** | the browser lost the local server | Restart `marketlens`; the page retries with backoff by itself. |
| Many `429` | a script or another tab is hammering the API | Check `route` in the log; raise nothing, fix the caller. |
| `503 server busy` | more than 64 requests in flight | Look for slow upstream calls in `routes.*.p99_ms`. |
| `marketlens --audit` prints `BROKEN` | rows edited or removed outside the app, or restoring an old backup | Compare with a backup; the first bad id is reported. |
| Option chain says no data | no CSV imported and no endpoint | Drop a CSV into the inbox folder or use Import CSV. A rejected file's reason is in the audit log. |

## Deploy and rollback
Container: `docker pull ghcr.io/akash-8991/rea_marketwatch_app:<tag>` and recreate the container; the `/data` volume keeps accounts and the
audit log (see INSTALL.md section 2b). Releases and rollbacks of every artifact: RELEASING.md.

Install: `pip install marketlens-<version>-py3-none-any.whl`. Upgrade: install the new wheel over it; the database
migrates itself. Rollback: reinstall the previous wheel (see the migration note above for the database). The package
has no dependencies and bundles no NSE data.

## Latency and load controls (what each one is for)
| Control | Setting | Protects |
|---|---|---|
| Two NSE lanes, each with a warm session | `MAX_WORKERS = 2` | NSE's edge (never more than two requests in flight) and latency (a misrouted call costs one request, not three) |
| Pacing gap after a successful call | 150 ms, held by the lane, not added to the reply | NSE politeness without slowing the caller |
| Backoff after real errors, give up after 5 | 60 ms doubling to 1 s | a failing NSE is not hammered; errors surface in about a second |
| Circuit breaker on 401/403/429 | 15 min, saved on disk | an NSE block is respected across restarts |
| Quote deadline | 6 s (`QUOTE_DEADLINE`, `quoteDeadlineMs`) | a stuck NSE call cannot hold a page; the saved copy is shown as `stale` and the call finishes in the background |
| Search deadline | 450 ms | typing stays smooth when NSE's symbol search is slow |
| Saved data first (home data) | the saved copy answers at once and is refreshed in the background; the page polls while `refreshing` is true | a first load after the app was closed never waits for NSE (it used to wait about 13 s, longer than the page's 10 s timeout) |
| Request coalescing | one in-flight request per key | a burst of identical requests costs one NSE call |
| Cache TTLs | quotes and live indices 1 s while the market trades, stretched to (symbols on screen ÷ 10) seconds when more than 10 are shown, 15 min closed; history 12 h; peers ranking 30 min | the one-second feed: at most 10 NSE stock-quote calls a second in total, so a busy page never sends more requests, it refreshes each row less often |
