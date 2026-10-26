# MarketLens

A local markets dashboard for NSE-listed stocks. It runs on your own machine, in your browser, and uses only the
Python standard library.

- **Markets and stock pages**: indices, breadth, India VIX, the most-traded stocks, price charts, 52-week range,
  corporate actions.
- **Screener** laid out like a trading-platform screener: filter chips (price, change, turnover, 30-day move, 52-week
  position, dividend yield, sector, and the three ratings), five views (Overview, Performance, Technicals, Sentiment,
  Dividends), a column chooser, sortable headers, paging, saved screens, CSV export. Each stock gets a **technical**
  rating (trend/momentum from daily closes), a **sentiment** rating (keyword scoring of recent headlines) and an
  **income view** (dividends and corporate actions). The exact rules are written out in plain language at the bottom of
  the page, generated from the same constants the code uses.
- **Live news** from Yahoo Finance and Google News, split into **India** and **Global** stocks.
- **Option chain** page backed by a local SQLite database: import CSVs you download from NSE's option-chain page,
  or connect an official derivatives MCP endpoint. Every import is audit-logged. Also ships a small MCP server.
- **Accounts**: sign up with name, email, date of birth, a user ID and a password; several people can have their own
  account on one installation, each with their own watchlist and saved screens. Recovery of a forgotten user ID, and
  changing the user ID or password, ask for name, email and date of birth and only proceed if all three match.
- Dark mode.

> This is an educational app. Nothing shown here is investment advice.

## Get the app (pick one)

| You have | Do this | Time |
|---|---|---|
| **An Android phone** | On the phone, tap **[Download MarketLens for Android](https://github.com/akash-8991/rea_marketwatch_app/raw/main/downloads/MarketLens-android.apk)** (a ready-built `.apk`, nothing to run), open the downloaded file, allow the install, create an account. Standalone: no computer needed. Details: [docs/MOBILE.md](docs/MOBILE.md). | 2 min |
| **Docker** | `docker run -d --name marketlens -p 127.0.0.1:8080:8080 -v marketlens-data:/data ghcr.io/akash-8991/rea_marketwatch_app:latest`, then open <http://127.0.0.1:8080>. Or use [docker-compose.yml](docker-compose.yml). | 1 min |
| **Python 3.9+** | `pip install marketlens-0.5.0-py3-none-any.whl` (from `dist/`), then `marketlens`. | 2 min |
| **An iPhone** | Not available yet; needs a Mac with Xcode to build. See [docs/MOBILE.md](docs/MOBILE.md), section 7. | |

The first screen asks you to create an account; after that you sign in with your user ID and password. You then stay signed in
(even after closing the app) until you sign out, for at most 15 days. Everything is
stored on your own device (phone storage, the container's `/data` volume, or your user data folder).

Updating keeps your user ID, password and sign-in (install the new version over the old one; do not uninstall).
**What the interface offers (desktop, container and phone):** a left navigation rail (a slide-in menu on phones) and a command palette (Ctrl or Cmd + K, or `/`) that searches by symbol or company name with recent searches and full keyboard control; an interactive **Watchlist** (add and remove with undo, sort, filter, refresh one or all, auto-refresh from 1 to 60 seconds that pauses when the tab is hidden, status badges that never rely on colour alone); a **stock page** that shows the price first and then a chart with 1D, 1W, 1M, 3M, 6M, 1Y, 5Y and 10Y ranges (NSE keeps daily history from 1 January 2024 and the chart says so; there is no intraday data) with a keyboard-readable crosshair; and **Paper trading**: a pretend ₹10,00,000 account at real NSE prices, an order ticket, and a strategy lab that runs seven textbook strategies (buy and hold, moving-average crossover, RSI reversion, MACD, breakout, Bollinger, momentum) over a stock's real history with fees, a comparison against buy and hold, and an explanation of when each works and fails. Details: [docs/UI.md](docs/UI.md). Measured speed and the method: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

Everywhere: increases are green and decreases red, table text never wraps (tables scroll sideways), and news and updates use a medium text size.

Guides: **[docs/INSTALL.md](docs/INSTALL.md)** (install, containers, background running, upgrade, backup, troubleshooting),
**[docs/MOBILE.md](docs/MOBILE.md)** (Android app), **[docs/UI.md](docs/UI.md)** (interface and paper trading), **[docs/PERFORMANCE.md](docs/PERFORMANCE.md)** (bottlenecks, measurements, benchmark), **[docs/RELEASING.md](docs/RELEASING.md)** (how builds and releases
happen on GitHub), [docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

> **On the phone**, stock prices are live while the market is open (Mon-Fri 9:15-15:30 IST) and show the day's last update otherwise, the option chain loads by itself from NSE's published end-of-day derivatives file (no CSV upload; end-of-day, not
> live; during market hours its spot price is live), every screen answers from saved data first and refreshes in the background, and the layout keeps clear of the camera cut-out.

> The Android app and container are built by GitHub Actions. The Android app has not been run on a real phone yet and
> the container image's first publish happens when this change reaches `main`; see "What has been verified" in
> docs/MOBILE.md and the Actions tab for build status.

## Install and run

Requires Python 3.9 or newer (tested on 3.12, 3.13 and 3.14; 3.9-3.11 are untested).

```bash
pip install marketlens-0.5.0-py3-none-any.whl     # or: pip install .  from a source checkout
marketlens                                         # opens http://127.0.0.1:8080/
marketlens-options-mcp --data-dir <data folder>    # optional: MCP (stdio) server over the option-chain database
```

Options:

| Flag | Meaning |
| --- | --- |
| `--port 8080` / `--host 127.0.0.1` | Where to listen. Keep it on localhost: the app speaks plain HTTP (accounts protect data, not the wire). |
| `--data-dir PATH` | Where snapshots and caches are stored (default: your user data folder). |
| `--offline` | Never call NSE; serve the last saved snapshot only. |
| `--no-news` | Do not fetch Yahoo Finance / Google News headlines. |
| `--fo-mcp-url URL` | NSE derivatives MCP endpoint for the option chain (or env `NSE_FO_MCP_URL`). |
| `--option-inbox PATH` | Folder you drop downloaded option-chain CSVs into (default: `<data dir>/option-inbox`). |
| `--option-interval 150` | Seconds between inbox scans and endpoint fetches (default 150 = 2.5 minutes, `0` = off). |
| `--no-login` | Turn accounts off (no sign-in screen). Only for one trusted user on one machine. |
| `--list-users` | Print the registered user IDs and exit. |
| `--reset-password USERID` | Set a new password for a user (asks for it twice, hidden) and exit. For the machine's owner. |
| `--no-open` | Do not open a browser window. |
| `--audit [N]` | Print the last N audit entries (default 20), verify the hash chain, and exit. |
| `--no-rate-limit` | Disable per-client rate limits (for benchmarking on your own machine). |

Environment overrides: `NSE_CM_MCP_URL`, `NSE_BHAVCOPY_MCP_URL`, `NSE_FO_MCP_URL`.

## Where the data comes from

| Data | Source |
| --- | --- |
| Prices, OHLC, 52-week range, volume, turnover, indices, breadth, VIX, daily history, corporate actions, index P/E, P/B and dividend yield | NSE's MCP servers (`mcp.nseindia.in`), fetched on demand through the local server |
| Headlines | Yahoo Finance RSS and Google News RSS (Google Finance has no public feed; this is its news source). Only the headline, publisher, time and link are used; links open the publisher. |
| Option chain | CSV files **you download yourself** from NSE's option-chain page, and/or an official NSE derivatives MCP endpoint **you configure**. The default NSE servers are cash-market only and have no option tool. MarketLens never fetches nseindia.com or drives a browser. |

**First run and the saved snapshot.** On a fresh install there is no snapshot, so the first start needs NSE to be
reachable. Every successful fetch is saved in the data folder and is served (with a warning banner) when NSE is
unreachable or `--offline` is used. **No NSE data is bundled in this package.**

### What is not available, and how it is handled
NSE's feeds do not include per-stock P/E, market cap, earnings, debt or growth, company names, news articles or
intraday charts, so none are shown. The "income view" is therefore **not** a full fundamental analysis: it compares
dividend yield with the Nifty 50 and checks dividend consistency over three years, and shows the sector index's
P/E and P/B for context. Sectors, company names and NSE codes come from NSE Indices' Nifty Total Market constituents list (about 750 stocks, 22 industries), kept in the app's
database and refreshed once a week from the official download (NSE's archive, with Nifty Indices' site as a second source; a failed or invalid download
changes nothing). A copy ships with the package (`src/marketlens/data/ind_niftytotalmarket_list.csv`) as the starting point; to update it by hand replace that
file and run `PYTHONPATH=src python3 mobile/scripts/gen-sectors.py > mobile/engine/sectors.js`. Stocks that are not in the list show as "Other". The file is NSE
Indices' published list, kept only for classification (symbol, industry, company name); check NSE's terms if you redistribute the package.
**Stock page:** the header shows the company name and industry, and the Peers card compares the stock with the 10 most-traded stocks of its industry
(price, change, volume, turnover, and its move against the peer median). Search also finds a stock by company name. NSE returns about three months of daily history, so SMA 200 is not computed.

### How the analysis works
- **Technical**: price vs 20-day average, 20- vs 50-day average, RSI(14), MACD histogram, combined into a score
  from -1 to 1 (Bullish at 0.34 or above, Bearish at -0.34 or below). With no history loaded it falls back to
  30-day change, 52-week position and day change, and the badge is marked `*`.
- **Sentiment**: counts positive and negative finance words in recent headlines for the symbol (with simple
  negation handling). It is approximate, can match unrelated stories, and is computed in the background about one
  stock every second.
- **Income view**: yield vs the Nifty 50, plus dividends in each of the last three calendar years.

## Option chain, the database and the audit log

1. Open NSE's option-chain page in your own browser and use its CSV download.
2. Drop the file into the inbox folder (shown on the Option chain page), or use **Import CSV** on that page.
   Name the file like `option-chain-ED-NIFTY-27-Oct-2026.csv` so the symbol and expiry are read from it, or type them in.
3. Every `--option-interval` seconds (2.5 minutes by default) MarketLens ingests new files, moves them to `processed/` or
   `rejected/`, and the page refreshes itself. If `--fo-mcp-url` is set it also fetches NIFTY and BANKNIFTY from that endpoint.

Snapshots and the audit log live in one SQLite file, `marketlens.db`, in the data folder (SQLite is public domain and
part of Python). Identical data is stored once, and the newest 300 snapshots per symbol and expiry are kept.
The `audit_log` table records every import, duplicate, rejection and failed fetch (idle scans are not logged). It is
**append-only** (database triggers refuse UPDATE and DELETE) and **hash-chained**, so rows edited or removed outside the
app are detected; the page shows "Chain intact" or "Chain broken". This is tamper-evidence, not protection: someone with
write access to the file can still rebuild the whole chain.

The CSV reader expects NSE's layout (CALLS | STRIKE | PUTS, quoted numbers, `-` for blanks). It is tested against
synthetic files in that layout, **not** against a real NSE download, so if a real file is rejected, the audit log says why.
The scheduled endpoint path is tested only against a fake MCP server I wrote, not a real NSE derivatives endpoint.
When spot is not in the CSV it is estimated from put-call parity and labelled as an estimate.

### MCP server for the database
`marketlens-options-mcp` speaks MCP over stdio and exposes: `option_chain_latest`, `option_chain_snapshots`,
`option_chain_import_csv` (CSV text, or a file inside the inbox folder only) and `option_chain_audit_log`. It reads and
writes the same database; it downloads nothing. Example client config:

```json
{"mcpServers": {"marketlens-options": {"command": "marketlens-options-mcp", "args": ["--data-dir", "/path/to/data"]}}}
```

## Why there is no automatic download from NSE's website
NSE's site is protected against automated access. A scheduled script or headless browser that fetches the option-chain
page would have to imitate a normal browser, which MarketLens does not do, and NSE's own MCP servers already
rate-limit and block clients that send bursts. Use the CSV workflow above or an official endpoint.

## Being a good NSE client
NSE's edge rate-limits aggressive clients. MarketLens makes at most two concurrent NSE calls, caches results,
loads history in the background, and stops all NSE traffic for 15 minutes if it is ever refused (HTTP 401/403/429).
That pause is saved on disk, so restarting does not retry immediately. Please do not remove these limits.
NSE's data is for information and education under NSE's own terms; check them before using it beyond personal,
local use.

## Privacy and security
- Binds to `127.0.0.1` by default, sends a strict Content-Security-Policy, rejects requests whose Host or Origin is not the
  local address (DNS-rebinding and cross-site protection), and requires a custom header for CSV uploads. There is no
  login, so do not expose it to a network.
- Your browser talks only to the local server. The server contacts NSE, Yahoo Finance and Google News; nothing
  else is called and no analytics are used. Watchlist and screener settings stay in your browser's local storage.

## Accounts and what they do and do not protect
- **Stored in `marketlens.db`** (SQLite, file readable by the owner only): user ID, name, email, date of birth, and a
  salted PBKDF2-SHA256 hash of the password (600,000 rounds). The password itself is never stored or logged.
- **Sessions**: a random token in an `HttpOnly`, `SameSite=Strict` cookie; only its hash is stored. You stay signed in, even
  after closing the app, until you sign out; a session ends automatically 15 days after sign-in, on sign-out, and on any credential change.
- **Abuse limits**: 5 failed attempts lock that user ID (sign-in) or email (recovery) for 15 minutes, doubling up to
  24 hours; sign-in and recovery endpoints also share a strict per-client rate limit. Failure messages never say which
  detail was wrong.
- **Recovery is deliberately simple and therefore weak.** Anyone who knows your name, email and date of birth can use it
  to see your user ID or set a new password, and nothing verifies that the email address is really yours. If you forget
  everything, the person who runs the app can run `marketlens --reset-password USERID` on the machine.
- Accounts keep people apart **inside one installation**; they do not make it safe to expose the app to a network (it
  speaks plain HTTP). Keep it on `127.0.0.1`. Each user's watchlist and saved screens live in that browser's storage,
  under their account number; option-chain snapshots and the audit log are shared by everyone using the installation.
- The date of birth, name and email are stored as readable text because recovery needs to compare them. Back up and
  share the data folder accordingly.

## Operating it
`/healthz` (liveness), `/readyz` (readiness) and `/api/metrics` (latency percentiles per route, counters, data age, web
vitals) are built in. Requests get an `X-Request-ID` and one JSON log line each. Per-client rate limits return
`429` with `Retry-After`; overload returns `503`. See `docs/OPERATIONS.md` (limits, audit schema, runbook),
`docs/ARCHITECTURE.md` (diagram and trade-offs) and `docs/ASSESSMENT.md` (findings and measured before/after).

## Design and accessibility
Colours are semantic tokens in light and dark themes (system preference by default); a test recomputes WCAG 2.2 AA
contrast from the stylesheet. System fonts only (no downloads), tabular numerals for figures, visible focus rings,
skip link, reduced-motion support, large touch targets on touch devices, no horizontal page overflow from 360 px to
ultrawide screens (wide tables scroll inside their own container). Tested with automated checks and a keyboard
walkthrough, not with a screen reader.

## Development

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e .
PYTHONPATH=src python -m unittest discover -s tests     # offline tests, no network needed
python tools/loadtest.py --url http://127.0.0.1:8080 --concurrency 1 16 --seconds 8   # load test your own local server
pip wheel . --no-deps -w dist                           # build the wheel
```

Mobile engine tests (Node 22+, no dependencies): `cd mobile && node --test`. They compare the JavaScript engine with
the Python engine's output stored in `mobile/tests/golden.json` (regenerate with
`PYTHONPATH=src python3 mobile/scripts/gen-golden.py`).

Layout: `src/marketlens/` (`nse.py` MCP client and rate limiting, `market.py` data assembly, `analysis.py` scoring,
`news.py` feeds and sentiment, `options.py` option-chain adapter, `optiondb.py` SQLite store, CSV parser and audit log,
`scheduler.py` 2.5-minute refresh, `options_mcp.py` MCP server, `ratelimit.py` and `metrics.py` traffic control and
telemetry, `server.py` HTTP server and API, `static/` web app: `lib.js` shared helpers and API client, `app.js` router and
views, `screener.js` lazy-loaded screener, `css/style.css` design tokens and components).

## Licence
MIT, Copyright (c) 2026 akash-8991. See `LICENSE`.
