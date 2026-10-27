# Performance, interface and benchmark report

How the brief's goals were handled, what was measured, what was not, and what could not be met. Every number below was produced by the scripts in `tools/` on one machine
(macOS, Node v26.12.1, loopback and the real NSE MCP servers, market closed at the time) and is reproducible with them. Where a result varies run to run, both runs are shown.
Nothing is estimated except where the word "estimate" appears.

## 1. Executive summary
* The interface was rebuilt as a shadcn/ui-style design system with Tailwind utilities and Lucide icons, an interactive watchlist, a command palette, a price-first stock page
  with 1D to 1Y chart ranges, toasts and clear data states, and a new **Paper trading** page (see [UI.md](UI.md)). It stays a no-build ES-module app: React and the shadcn/ui
  package were **not** adopted (reasoning in [THIRD_PARTY.md](THIRD_PARTY.md)).
* Cached and saved-data reads were already fast (median 0.2 to 1.5 ms on the desktop server); the real latency is NSE's, so work went into **how often and how many times NSE is
  asked**: a pacing delay that sat in every reply was moved off the response path, a lean one-call quote now shows the price while the heavy page loads, a batch endpoint replaced
  one-call-per-stock, requests that cannot finish are answered from saved data after a deadline, and errors back off instead of hammering.
* Measured effect (live NSE, same script, old release against new): time until a stock page can show its price **median 1,011 ms to 180 ms**; a 20-stock watchlist **20.8 s to 4.9 s**
  with 154 requests becoming 50; search **p95 977 to 326 ms**; NSE not answering **10.3 s to 6.0 s**.
* **Not met** (and why, sections 7 and 20): an uncached quote under 300 ms is not reliable, because only about 43% of NSE calls reach a backend that knows the session (measured), which
  puts the floor near 320 ms at the median round trip; a first-ever cold dashboard takes about 1.5 s (two sequential NSE rounds); refreshing data every second is not possible and
  was deliberately not attempted (NSE updates about once a minute).

## 2. Current architecture and request-flow model (before the work)
Static UI served by a Python process, a container, or an Android WebView with the engine ported to JavaScript. Price path: UI → `/api/stock/<symbol>` (four NSE calls: quote, history,
52-week range, corporate actions) → cache → single-flight → two NSE lanes with warm MCP sessions → JSON. Lists came from `/api/bootstrap` (the 50 most traded stocks, one bulk call);
anything else needed one full stock page per symbol.

## 3. Interface problems found
No sorting, filtering or per-row refresh in the watchlist, which could only hold stocks you had opened; search dropdown without keyboard navigation, cancellation or history; chart limited
to 1W, 1M and 3M with no loading, error or no-data states; a stock page that showed nothing until four NSE calls finished; no per-value status (live, delayed, closed, stale); no
notifications for add, remove, refresh or failure; navigation as a wrapped tab strip.

## 4 to 6. Interface architecture, skin plan, interactive features
See [UI.md](UI.md). Implemented: left navigation rail (slide-in on phones), command palette (debounced, cancellable, cached ten minutes, highlighted, recent searches, full keyboard),
watchlist (add and remove with undo and rollback, sort by symbol, price, change in rupees, change in percent, last update; filter positive, negative, unchanged, stale, unavailable;
refresh one or all; auto-refresh toggle and 1, 5, 15, 30, 60 s interval; pause while the tab is hidden; skeletons, error with retry, empty state with a call to action; last-refreshed time,
data-source label, status badges), stock page (company, price, change, exchange, last-trade time, status, source, manual refresh, watchlist toggle, chart ranges), toasts for the
events listed in the brief (not for every normal refresh), light and dark themes.
**Skin decision:** shadcn/ui is React plus Radix; this project has no React and no build step at install time and is delivered from three channels out of one set of files. The shadcn/ui
look, variants, ARIA patterns and token names were re-implemented without the framework (about 14 KB of source) and Tailwind v4 is used as a build-time utility generator whose output
is committed (13 KB, 3 KB compressed). A React migration remains possible; the tokens and component names map one to one.

## 7. Data-source performance analysis (measured on the real NSE MCP servers)
| Fact | Measurement |
|---|---|
| Raw round trip of one request | median 83 ms, p95 189 ms (n=10) |
| Tool call on one warm session that reaches the right backend | 17 of 40 (**43%**); latency median 137 ms, p95 361 ms |
| Expected attempts per call, and expected time at the median | 2.35 attempts, about 320 ms |
| Bulk quote for 50 stocks | one call, about 50 ms when it lands |
| Daily history depth | starts 2024-01-01 (694 trading days for one stock; 13 calls, about 8.6 s to fetch all) |
| Live bulk tool (`cm_get_equity_stocks`) | returns an arbitrary 500 of the market; only 7 of the 50 most traded were in it, so it cannot replace per-symbol live quotes |
| NSE's own refresh rate | about once a minute (stated by the tool). The page now re-checks every second, so a change shows within about a second of NSE publishing it; between NSE's updates the numbers repeat |
| Option chain | NSE's live API is bot-protected and is not used; the published end-of-day file is |

## 8. Confirmed bottlenecks (evidence, root cause, effect, confidence, rollback)
| # | Finding | Evidence | Fix | Effect | Rollback |
|---|---|---|---|---|---|
| 1 | A 150 ms politeness pause sat inside every NSE reply | uncached quote median 678 ms; 152 ms after moving the pause to the lane release (same script, n=20) | pacing now holds the lane, not the caller | about 500 ms per call; high confidence | restore the sleep in `nse.js`/`nse.py` |
| 2 | A stock page needed four NSE calls before showing anything | page median 1,011 to 1,179 ms; lean quote 180 to 263 ms | `/api/quote/<sym>` (one call) renders the header first | price visible about 4 to 5 times sooner | UI falls back to `/api/stock` |
| 3 | A watchlist had to issue one full page per symbol | 20 symbols: 20.8 s and 154 requests | `/api/quotes` batch, chunks of 10, saved prices painted at once | 4.9 s and 50 requests; first rows in about a second | batch endpoint is additive |
| 4 | No deadline on a stuck NSE call | benchmark: NSE not answering took 10.3 s | quote answered from the saved copy after 6 s (`stale`), search after 450 ms | bounded tail | settings `quoteDeadlineMs`, `searchDeadlineMs` |
| 5 | Immediate retries on real errors (introduced by fix 1, caught by the benchmark: 14 retries in 0.6 ms) | benchmark scenario "NSE returns errors" | exponential backoff 60 ms to 1 s, give up after 5 hard failures | no hammering; error surfaces in about 1.9 s | constants in `nse.js` |
| 6 | Search waited for NSE's symbol search | p95 977 ms | local matches first, NSE merged if it answers within 450 ms | p95 326 ms | deadline setting |
| 7 | Large lists were rendered whole | 1,000 rows 162 ms, 3,000 rows 438 ms to lay out (sorting and filtering cost under 1.2 ms) | windowing above 300 rows; rows patched individually on refresh | about 40 rows in the page at a time | threshold constant |

## 9. Suspected bottlenecks (not confirmed)
Memory growth over a long session (timers and listeners are removed on navigation; no long-run measurement was made). SQLite on the desktop server (queries use primary keys and one index;
no N+1 pattern found; not measured under write load). JSON size (largest response 7 KB; compression already on). Chart redraw on resize (debounced; not profiled).

## 10. Missing measurements
Largest Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift on a **real device** (the embedded browser used here cannot report them reliably; layout shift was
minimised by reserving heights, not measured). Android WebView behaviour and speed. Behaviour during real market hours (the benchmarks ran with the market closed; the in-session
path was exercised with a simulated clock). NSE's actual rate-limit thresholds (unknown, deliberately not probed). Many simultaneous users (this is a single-user app). Battery and CPU use. Real-world availability.

## 11. Target architecture and 12. Cache and refresh strategy
See [ARCHITECTURE.md](ARCHITECTURE.md). Summary: saved data first; one in-flight request per key; TTLs of 30 s for quotes while the market trades and 15 minutes otherwise, 12 hours for history,
30 minutes for peer ranking; background overlay of live prices during session hours; one catch-up fetch after the close; a refresh never replaces newer data with older. "Refresh now" bypasses the cache
at most once per symbol per 5 seconds. **Latency, throughput, freshness and reliability are kept apart:** latency = lean quote, deadlines; throughput = batch endpoint, bulk quote, two lanes; freshness
= TTLs, live overlay, refresh button; reliability = saved-copy fallback, backoff, circuit breaker.

## 13. MCP and NSE retrieval strategy
Two lanes (never more than two requests in flight), each with a warm session retried in place on a misroute; backoff on real errors; a persisted 15-minute breaker on 401, 403, 429; no browser
imitation, no scraping of protected pages. **Tried and rejected:** sending each quote on both idle lanes at once ("hedging"). Interleaved on live NSE (n=30 each) it was slower (median 300 ms against 237 ms) and used
75% more requests (89 against 51), so it was removed; the 43% figure makes it look attractive on paper, but the second lane's attempt was not independent in practice.

## 14. Database optimisation
SQLite holds accounts, snapshots, audit log and the stock list; access is by primary key or the `snap_lookup` index; the audit chain and snapshot are one transaction. No change was needed; migrations are
versioned (phone) and idempotent (desktop). The phone keeps the same data in IndexedDB.

## 15. Frontend performance
First-paint payload (HTML, CSS and every JavaScript file loaded before the first screen, compressed; `tools/payload.mjs`):
| Build | Desktop page (no engine) | Phone bundle (page + on-device engine) |
|---|---:|---:|
| Previous release | 29.6 KB | 85.0 KB |
| This release | 41.3 KB | 100.4 KB |
The first paint **grew** by about 12 KB (desktop) and 15 KB (phone): the component layer, icons and utility CSS are loaded up front. Everything else new is lazy and loaded on first use (palette 3.4 KB, dashboard 6.4,
chart 3.4, paper trading 10.7, strategies 4.4, indicators 1.1, paper account 2.0, shared logic 1.9; compressed). Time until the home screen is usable (7 loads each, warm cache, same machine, saved data):
**28 ms median (new) against 30 ms (previous)**; first load after a clean start 67 ms against 32 ms. Code splitting, lazy chart, debounced and cancellable search, client caches, windowed tables,
stale-while-revalidate and per-row patching are in; images are not used (no image or font downloads); main-thread work on first paint is the string rendering of one screen. The brief's
"reduce initial bundle" was **not** achieved; the trade for features is stated rather than hidden.

## 16. Accessibility and responsive design
Skip link, landmarks, labelled controls, visible focus, ARIA tablist, listbox and combobox patterns, native dialogs with focus trap, reduced-motion support, 44 px touch targets on touch devices,
status never by colour alone (icon and word on every badge), chart with a text summary and arrow-key reading, tables that scroll inside their own box. Checked at phone width on six screens in light and
dark mode: no sideways page scroll, no wrapped table text, badge text contrast 5.9 to 7.2 (WCAG AA needs 4.5). Not tested with a screen reader.

## 17. Prioritised roadmap (done, and next)
Done: items 1 to 7 of section 8, the interface, paper trading. Next, in order: (1) real-device Web Vitals on Android; (2) show the live-price overlay progress in the banner; (3) a React and shadcn/ui migration only if
the project accepts a build step in every channel.

## 18. Code changes
`mobile/engine/nse.js`, `market.js`, `engine.js`, `metrics.js`, `storage.js` (transport, quotes, history, metrics) and the Python twins `src/marketlens/nse.py`, `market.py`, `marketclock.py`, `server.py`, `store.py`;
interface `static/js/ui.js palette.js dashboard.js chart.js paper-view.js options-view.js options-lab.js paper.js strategies.js indicators.js pure.js icons.js`, `css/style.css`, `css/tailwind.css`; tooling `ui/`, `tools/bench-engine.mjs`, `bench-compare.mjs`, `payload.mjs`.
Migration: none needed for users (data formats unchanged). Rollback: previous tags (`v0.4.0`, `mobile-v0.7.0`); every fix above is also individually revertible as listed.

## 19. Test plan (what runs in CI)
165 Python tests and 79 JavaScript tests: golden equality of the JavaScript engine with the Python engine; end-to-end through the router with a fake NSE server (misroutes, hangs, errors, stampede, breaker); market-hours clock;
quotes, batch, history, deadlines; update safety (accounts survive updates); strategy simulator (no look-ahead, costs, drawdown, comparison), paper account rules; sorting, filtering, windowing, decimation; stylesheet rules
(contrast, colour classes beat table colours, no wrapping); the built Tailwind and icon files are regenerated in CI and must match what is committed.

## 20. Benchmark: how to run, and the results
```bash
git archive mobile-v0.7.0 mobile/engine | tar -x -C /tmp/old           # the previous release's engine
node tools/bench-engine.mjs --engine /tmp/old/mobile/engine/engine.js --label before --live --out /tmp/before.json
node tools/bench-engine.mjs --engine mobile/engine/engine.js          --label after  --live --out /tmp/after.json
node tools/bench-compare.mjs /tmp/before.json /tmp/after.json
PYTHONPATH=src python3 tools/loadtest.py --url http://127.0.0.1:8080 --concurrency 1 16 --paths /api/bootstrap /api/quote/RELIANCE   # desktop server
node tools/payload.mjs mobile/www                                           # first-paint weight
```
Method: live scenarios use 15 distinct symbols, two lanes, about 300 polite requests per engine; "before" for the single-quote and multi-symbol rows is what the old UI had to call
(`/api/stock/<symbol>`, once per symbol) because the lean endpoints did not exist. In-process scenarios use a fake NSE with 50% misroutes. Times in milliseconds.

| Scenario | Before p50 | After p50 | Before p95 | After p95 | Before p99 | After p99 | Target | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Cached quote (2,000 reads) | 0.00 | 0.01 | 0.01 | 0.01 | 0.03 | 0.04 | p50 < 100 ms | Met |
| Uncached quote, live NSE (15 symbols) | 1,258 | 628 | 2,603 | 3,075 | 2,603 | 3,075 | p50 < 300 ms | Not met |
| Stock page: time until the price shows | 1,011 | 180 | 1,941 | 511 | 1,941 | 511 | p50 < 300 ms | Met |
| Stock page: all data (4 NSE calls) | 1,179 | 592 | 1,669 | 1,067 | 1,669 | 1,067 | p50 < 300 ms | Not met |
| Multi-symbol: 20 symbols, cold | 20,772 | 4,919 | 20,772 | 4,919 | 20,772 | 4,919 | p50 < 300 ms | Not met |
| Dashboard, first ever load (cold) | 1,830 | 1,470 | 2,167 | 2,039 | 2,167 | 2,039 | < 300 ms | Not met |
| Dashboard, saved data (warm) | 0.24 | 0.36 | 0.30 | 0.46 | 0.30 | 0.46 | < 300 ms | Met |
| Search (saved matches + NSE search) | 434 | 202 | 977 | 326 | 977 | 326 | p95 < 300 ms | Not met |
| Market open: cold start until all live prices are in | 11,696 | 10,592 | 11,696 | 10,592 | 11,696 | 10,592 | no target | — |
| 100 identical simultaneous requests (NSE calls 4 → 1) | 33.7 | 10.8 | 33.7 | 10.8 | 33.7 | 10.9 | 1 NSE call | Met |
| NSE stops answering | 10,252 | 6,003 | 10,252 | 6,003 | 10,252 | 6,003 | bounded, no hang | Not met |
| NSE returns errors | 925 | 1,871 | 925 | 1,871 | 925 | 1,871 | bounded, no hammering | Met |
| Storage fails | 0.72 | 0.84 | 0.72 | 0.84 | 0.72 | 0.84 | answers, no crash | Met |
| Watchlist of 50, 4 ms network, 30% misroutes | — | 210 | — | 217 | — | 217 | p95 < 300 ms | Met |

Reading it honestly:
* "Uncached quote" ran at 628 ms median in this run and 233 ms in an earlier run of the same code; NSE's response time drifts that much. Treat the target as **met in most runs, not guaranteed**.
* In the "100 identical simultaneous requests" row the drop from 4 NSE calls to 1 is the lean quote needing one call where the full page needs four; both versions share one in-flight request between callers.
* "NSE not answering": 6.0 s is the default deadline; before, the same fake NSE held a request for 10.3 s.
* Desktop server, loopback, cached data (offline mode), p50 / p95 / p99 in ms, one client: `/api/bootstrap` 1.5 / 2.1 / 3.0 (before 1.3 / 1.7 / 2.0); `/api/quote/<sym>` 0.4 / 0.6 / 1.0; `/api/quotes` (3 symbols) 1.1 / 1.6 / 2.5;
  `/api/stock/<sym>` 0.8 / 1.1 / 1.7 (unchanged). With 16 clients at once: 6 to 18 ms p50 and under 32 ms p99 for every endpoint, no errors on cached endpoints.
* A watchlist of 50 in one batch against a fake NSE with 4 ms latency and 30% misroutes: 210 ms median.
* Large list: 1,000 rows 162 ms to lay out without windowing; windowed lists draw about 40 rows.
* Raw NSE round trip 83 ms median; 43% of warm-session calls succeed (section 7).

### The brief's targets, one by one
| Target | Result |
|---|---|
| Cached quote under 100 ms | **Met**: 0.01 ms in process; 0.4 ms on the desktop server (loopback; network not included) |
| Uncached quote under 300 ms | **Mostly**: 180 to 263 ms in four runs, 628 ms in one; p95 0.5 to 3 s. Floor about 320 ms from NSE's misroute rate (section 7) |
| Dashboard under 300 ms | **Met with saved data** (under 1 ms plus about 28 ms to draw); **not met** for a first-ever cold load (about 1.5 s: two NSE rounds in sequence) |
| p95 API under 300 ms | **Met** for everything served from cache or saved data; **not met** for calls that wait on NSE |
| p99 API under 150 ms | **Met** for cached paths (under 32 ms at 16 clients); not for uncached NSE calls. (A p99 target below the p95 target is internally inconsistent, since p99 cannot be lower than p95; it was applied to cached paths.) |
| Data refresh interval of 1 second | **Done at our end, bounded by the source**: the feed (`/api/live`, `live.js`) asks every second, never overlaps, pauses when hidden and slows to 30 s when the market is shut; the server reuses a quote for 1 s and spends at most 10 NSE stock-quote calls a second across everything on screen (indices and sector tiles are one call). More symbols on screen mean each is refreshed proportionally less often. Whether the value changes every second is up to NSE: the tool states about one update a minute, which could not be verified here (the market was shut while this was built) |
| Initial usable UI under 100 ms | **Met** on this machine: 28 ms median, 67 ms on a first load. Not measured on a phone |
| Availability above 99% | **Not measurable here.** By design the app keeps working on saved data when NSE fails (tested), but no uptime figure is claimed |

## 21. Observability and alerting
`/api/metrics` (both engines): per-route count, error count, p50, p95, p99, max (labels are route templates, never symbols); cache hits, misses and coalesced requests; NSE requests, sessions and misroutes;
breaker state; market state; data age per dataset (desktop). The audit log records upstream blocks, list refreshes and imports. Suggested alerts for a desktop deployment: breaker open for over 30 minutes,
`stale` quotes for over 10 minutes during market hours, p99 of cached routes over 150 ms, error count rising on any route.

## 22. Risks and rollback
Generated files (`tailwind.css`, `icons.js`) can drift from their sources (CI guards it). The paper account lives only in the browser or app storage (no cloud copy; clearing storage removes it). Strategy results
are simulations on 2.8 years of daily closes; they explain how rules behave and say nothing about the future. Rollback: previous release tags and the per-fix notes in section 8.

## 23. Next three actions
1. Install the Android build and record Web Vitals and real-device timings.
2. Re-run `tools/bench-engine.mjs --live` during market hours and compare in-session numbers.
3. Decide whether a React and shadcn/ui migration is worth a build step in all three delivery channels.
