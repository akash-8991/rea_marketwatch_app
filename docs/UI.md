# Interface guide

One interface, three channels (desktop server, container, Android app): `src/marketlens/static/`. No framework and no build step at install time.

## Stack and why
| Layer | Choice | Notes |
|---|---|---|
| Components | shadcn/ui **design system** re-implemented in `static/js/ui.js` | Same variants (default, secondary, outline, ghost, destructive, link), badges, alerts, tabs, dialog, toasts, dropdown, skeleton, command palette. Not the React package; see [THIRD_PARTY.md](THIRD_PARTY.md) for the reasoning and the migration path. |
| Styling | Tailwind CSS v4 utilities (generated, `css/tailwind.css`, ~13 KB, ~3 KB compressed) over the tokens in `css/style.css` | The generated file is committed; `cd ui && npm run build` regenerates it and CI checks it is current. |
| Icons | Lucide, 58 icons as inline SVG (`js/icons.js`) | stroke is `currentColor`, so icons follow theme and text colour. |
| Charts | one hand-written SVG chart (`js/chart.js`), no library | smaller than any charting dependency; decimates to ~600 points, keeps every peak and trough. |
| Theming | light and dark through CSS variables; `Toggle` in the top bar | contrast of every token pair is recomputed in `tests/test_design.py`. |

## Layout
Top bar (menu on phones, logo, search box that opens the palette, market/data status pill, user, theme) above a left navigation rail with icons. On phones the rail
slides in over a dimmed page, starts below the status bar, and closes on selection. The first screen reserves its space (skeletons, fixed heights) so nothing jumps.

### Screen sizes
The layout is fluid and works from a 280 px folded phone to a 4K display, in portrait and landscape, light and dark.

| Width | What changes |
|---|---|
| ≤ 340 px | status pill hides (the banner under the bar says the same); search trigger shrinks to an icon |
| ≤ 380 px | smaller gutters and base font, narrower menu |
| ≤ 640 px | sign-out becomes an icon, index tiles scroll sideways instead of wrapping, tighter cards and table cells |
| ≤ 860 px | navigation rail becomes a slide-in menu (with the signed-in user at its foot) |
| ≤ 1100 px | narrower rail, user name leaves the top bar |
| ≥ 1500 px / ≥ 2200 px | content centred with a wider maximum; larger base font and rail on very large displays |
| landscape, ≤ 520 px high | slimmer top bar, shorter charts |

Rules that make it hold: grid and flex children may shrink (`min-width: 0`), so a wide table scrolls inside its own box and can never stretch the page;
grid minimums use `min(100%, …)`; charts size to the window height; dialogs and toasts never exceed the viewport; touch screens get 44 px targets
(including sort buttons and stars); pinch-zoom is never disabled.

**Checking it:** `tests/test_design.py` guards these rules. For a visual sweep, serve `mobile/www`, load `mobile/dev/browser-mock.js` then
`mobile/dev/layout-check.js`, set the window size and run `await __layoutCheck(['#/', '#/markets', '#/screener', '#/options', '#/watchlist', '#/paper', '#/news', '#/updates', '#/quote/INFY'])`.
It reports sideways page growth, elements poking out of the window, wrapping controls, clipped text, overlapping top-bar items and small tap targets.
Last run at 280, 320, 390, 667×375, 768, 1024 and 1920 px: no findings (the only reports left are headlines that wrap onto several lines, which is intended).

## Keyboard
| Keys | Does |
|---|---|
| `Ctrl/Cmd + K`, or `/` outside a text field | open the command palette |
| `↑ ↓ Home End`, `Enter`, `Esc` in the palette | move, open, close |
| `← →` (and `Shift` for 10 days) on the chart | move the crosshair; `Esc` hides it |
| `← → Home End` on any tab strip | switch tab |
| `↑ ↓ Esc` in menus | move, close |
All controls have visible focus rings; dialogs trap focus and restore it; reduced-motion preferences switch animation off; touch devices get 44 px targets.

## Data status, never by colour alone
| Badge | Meaning |
|---|---|
| ● **Live** | market open and the latest NSE price is under 5 minutes old |
| ◷ **Delayed** | market open, price older than 5 minutes |
| ☾ **Closed** | market shut: the last update of the day is shown |
| ⚠ **Stale** | NSE could not be reached; a saved copy is shown (also announced in a toast) |
| ✕ **Unavailable** | no data for this symbol, with the reason beside it |
| ⛁ **Cached** | a row that is being added and has not been fetched yet |
Green, red and a muted blue-grey (unchanged) carry direction; every one also has an arrow, a sign or a word.

## Watchlist
Add by symbol (suggestions from the stock list), remove with **Undo**, sort by symbol, price, change ₹, change % or last update (unavailable rows always last), filter
by positive, negative, unchanged, stale or unavailable, search within the list, refresh one row or all, and choose auto-refresh (1, 5, 15, 30 or 60 s; off pauses it;
it also pauses while the browser tab is hidden and refreshes the moment you return). NSE itself updates about once a minute, so intervals under 30 s re-read the
app's own cache and do not multiply traffic to NSE; "Refresh" buttons bypass the cache, but at most once per symbol every 5 seconds. Adds and removes are applied
at once and rolled back if NSE rejects the symbol. Lists over 300 rows are windowed (about 40 rows in the page at a time); measured: 1,000 rows took 162 ms to lay
out, so a plain 50-row list is left as is.

## Stock page
The price header comes from one lean request (`/api/quote/<symbol>`): company, industry, exchange, price, change in ₹ and %, last-trade time and its age, source, status
badge, refresh and watchlist buttons. The chart and the detail tabs load independently below it. Chart ranges: 1D (honestly unavailable: NSE's servers have daily data
only), 1W, 1M, 3M, 6M, 1Y (the API still accepts 5Y and 10Y, which the strategy lab uses for all of NSE's history; a saved 5Y or 10Y choice from an older version falls back to 3M). NSE's history starts on 1 January 2024. Each range is fetched once, cached, and
a request that is no longer wanted (you switched range) is cancelled.

## Paper trading
Four tabs.
* **Portfolio**: value, profit and loss, cash, invested, realised and unrealised result, fees paid; allocation bar; positions (average cost includes the buying fee); trade
  history with CSV download (spreadsheet formulas neutralised); reset with confirmation.
* **Trade**: order ticket with a live price card, quantity shortcuts (10, 25, 50 percent, max), an itemised cost, and reasons when an order cannot be placed. The fill price
  is fetched at the moment you press the button. Orders are blocked when there is no current price. Rules: whole shares, long only (no short selling), no borrowing, a 0.10% fee per trade.
* **Stock strategies**: 37 strategies, in nine groups, run over a stock's real daily history. Choose a strategy, a stock, a period, costs and the strategy's own settings. Output:
  final value against buy and hold, worst fall, closed trades and win rate, time invested, costs, an account-value curve for both, every trade, today's position with one-click
  paper trades, and a table of every strategy on the same data. Each has a plain-language page: the idea, when it buys and sells, when it works, when it struggles, what to learn.
  A signal is read at one close and acts at the next; the strategies use closing prices only (highs and lows are not in the saved history), so oscillators use the closing range.
* **Option strategies**: 41 strategies built from the real option chain (see below).

Strategy pages (the description, the legs and the comparison tables) use a smaller type size, and long strategy names and explanations wrap inside their cell instead of widening the table; figures never wrap.

### Stock and technical-analysis strategies
| Group | Strategies |
|---|---|
| Benchmark | Buy and hold |
| Trend following | Moving-average crossover, exponential-average crossover, triple moving-average alignment, golden / death cross (50 and 200 day), price above its average, MACD signal crossover, MACD above zero, linear-regression trend, TRIX |
| Momentum | Momentum (look-back), RSI above 50, RSI momentum band, stochastic oscillator, CCI, time-series momentum (skipping recent days), near the 52-week high |
| Mean reversion | RSI reversion, RSI(2) pullback in an uptrend, Bollinger reversion, Z-score, buy a dip below the average, consecutive down days |
| Breakout and volatility | Donchian channel breakout, Turtle breakout (55 / 20), Bollinger breakout, volatility squeeze breakout |
| Risk rules | Buy and hold with a trailing stop, trend entry with stop-loss and profit target |
| Investing | Monthly SIP (equal instalments, rupee-cost averaging) |
| Calendar | Turn of the month, Halloween (November to April) |
| Long and short | Moving-average crossover, MACD crossover, momentum, channel breakout, Bollinger reversion and RSI reversion, each also selling short |

Short strategies sell borrowed shares and buy them back (a short can lose without limit). The paper *account* still cannot short; shorting is simulated only inside the strategy lab.
Every setting is clamped to a safe range, so a typo cannot crash or distort a run.

### Option strategies
Pick an underlying (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY or any stock that has option data), an expiry, a strategy, a strike gap (how far apart the legs sit), lots and lot
size. The legs are placed on real strikes of the chain from `/api/options` and priced from each contract's last traded price in NSE's latest end-of-day file (a missing price is
estimated with Black-Scholes and flagged). Output: legs table, net debit or credit, maximum profit and loss (or "unlimited"), break-evens, reward to risk, a model estimate of
the chance of profit, net delta, daily time decay and vega, a profit-and-loss chart (at expiry, and "if closed today"), a what-if price box, and a table of every strategy
on the same chain. **Save to my paper option book** keeps a position (separate from the share portfolio; premiums are pretend); it is marked to the latest chain, can be closed
at current premiums, or settled at an entered price after expiry.

| Group | Strategies |
|---|---|
| Single position | Long underlying, short underlying (benchmarks), long call, long put, short call, cash-secured put |
| Vertical spreads | Bull call, bear put, bull put (credit), bear call (credit), bullish and bearish risk reversal |
| Synthetic | Synthetic long, synthetic short |
| Income and hedging | Covered call, protective put, collar, covered put, covered strangle |
| Volatility | Long straddle, long strangle, strap, strip, long guts, call and put ratio backspreads, reverse iron condor, reverse iron butterfly |
| Range and income | Short straddle, short strangle, iron condor, iron butterfly, call / put butterfly, call condor, broken-wing butterfly, call and put ratio spreads, jade lizard |
| Time spreads | Long calendar spread, diagonal spread (need the next expiry's chain) |

What is exact and what is modelled: the profit and loss at expiry is arithmetic on the chain premiums. "If closed today", the Greeks and the chance of profit use Black-Scholes
(7% interest, no dividends, each contract's implied volatility) and a lognormal price model: shapes to learn from, not forecasts. Brokerage, taxes, margin and early assignment are
not modelled, and lot sizes are editable defaults (NSE revises them). The lab never places an order anywhere. Unlimited-risk strategies carry a warning.


How the simulation stays honest: a signal is read from data up to and including a day and acts at the **next day's** close (no peeking, tested); all in or all out in whole
shares; the same fee (default 0.10%) and slippage (0.05%) on every trade; results compared with buying on day one and holding. Past results of a rule on one stock's
history are a way to understand the rule, not a forecast, and only 2.8 years of NSE history exist, which is short for any strategy.
The account is stored in this browser or app only (per signed-in user) under `ml.paper`; clearing the app's storage removes it.

## Files
`ui.js` components and toasts · `palette.js` command palette · `dashboard.js` watchlist · `chart.js` price chart · `paper-view.js` paper-trading page · `options-view.js` option strategies tab · `options-lab.js` option maths and catalogue paper trading page ·
`paper.js` account rules · `strategies.js`, `indicators.js` simulator · `pure.js` testable logic (sorting, filtering, windowing, decimation, highlighting) ·
`lib.js` helpers and API client (timeouts, retries with backoff and jitter, cancellation) · `icons.js` generated icons.
