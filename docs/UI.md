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
only), 1W, 1M, 3M, 6M, 1Y, 5Y, 10Y. NSE's history starts on 1 January 2024, so 5Y and 10Y show everything available and say so. Each range is fetched once, cached, and
a request that is no longer wanted (you switched range) is cancelled.

## Paper trading
Three tabs.
* **Portfolio**: value, profit and loss, cash, invested, realised and unrealised result, fees paid; allocation bar; positions (average cost includes the buying fee); trade
  history with CSV download (spreadsheet formulas neutralised); reset with confirmation.
* **Trade**: order ticket with a live price card, quantity shortcuts (10, 25, 50 percent, max), an itemised cost, and reasons when an order cannot be placed. The fill price
  is fetched at the moment you press the button. Orders are blocked when there is no current price. Rules: whole shares, long only (no short selling), no borrowing, a 0.10% fee per trade.
* **Strategy lab**: choose a strategy, a stock, a period and costs, and run it over the stock's real daily history. Output: final value against buy and hold, worst fall, closed
  trades and win rate, time invested, costs, an account-value curve for both, every trade, today's position with one-click paper trades, and a table of all seven strategies
  on the same data. Each strategy has a plain-language page: the idea, when it buys and sells, when it works, when it struggles, what to learn.

| Strategy | Buys when | Sells when |
|---|---|---|
| Buy and hold | day one | never |
| Moving-average crossover | fast average closes above slow average | it closes below |
| RSI mean reversion | RSI below 30 | RSI above 55 |
| MACD crossover | MACD line above its signal line | below |
| Breakout (Donchian) | close above the previous 20-day high | close below the previous 10-day low |
| Bollinger reversion | close below the lower band | close back at the middle average |
| Momentum | price above its level 60 days ago | not above |

How the simulation stays honest: a signal is read from data up to and including a day and acts at the **next day's** close (no peeking, tested); all in or all out in whole
shares; the same fee (default 0.10%) and slippage (0.05%) on every trade; results compared with buying on day one and holding. Past results of a rule on one stock's
history are a way to understand the rule, not a forecast, and only 2.8 years of NSE history exist, which is short for any strategy.
The account is stored in this browser or app only (per signed-in user) under `ml.paper`; clearing the app's storage removes it.

## Files
`ui.js` components and toasts · `palette.js` command palette · `dashboard.js` watchlist · `chart.js` price chart · `paper-view.js` paper trading page ·
`paper.js` account rules · `strategies.js`, `indicators.js` simulator · `pure.js` testable logic (sorting, filtering, windowing, decimation, highlighting) ·
`lib.js` helpers and API client (timeouts, retries with backoff and jitter, cancellation) · `icons.js` generated icons.
