# MarketLens on your phone

MarketLens for Android is a standalone app: it does its own work on the phone, with no computer and no server. It is
the same web interface as the desktop version, running on a JavaScript copy of the engine inside a Capacitor shell.

**Status: Android only.** iPhone is not built yet (see section 7). **The app has not been run on a real phone.** What
has been checked is listed in section 8; please report anything that breaks.

## 1. Install on Android (sideloading)
Android 7.0 or newer.

1. On your phone, open [this direct link](https://github.com/akash-8991/rea_marketwatch_app/raw/main/downloads/MarketLens-android.apk) in your browser (it downloads the single file `MarketLens-android.apk`; its checksum
   is kept separately in `downloads/checksums/`). Older versions are on the **Releases** page.
2. Optional but recommended, check the download on a computer: `cd downloads && shasum -a 256 -c checksums/MarketLens-android.apk.sha256`.
3. Open the `.apk`. Android asks to allow installs from this source (your browser or file manager). Allow it for this
   one install, then turn it off again in Settings.
4. Google Play Protect may warn that the app is from an unknown developer. That is expected: the app is not on the Play
   Store and is signed with a debug key (section 6). Choose **Install anyway** only if you trust this repository.
5. Open **MarketLens**, create an account (name, email, date of birth, user ID, password) and sign in.

## 2. What works
| Feature | On the phone |
|---|---|
| Home, Markets, Stock pages, Screener (technical, fundamental, sentiment), Watchlist | Yes, live from NSE's MCP servers |
| Search by symbol | Yes |
| India and global news (Yahoo Finance, Google News headlines) | Yes |
| Accounts: sign up, sign in, forgot user ID, change user ID or password | Yes, stored only on the phone |
| Option chain | **Loads by itself** when you open the screen, from NSE's published end-of-day derivatives file (all index and stock options: open interest, change in OI, volume, closing price). End-of-day, not live; no implied volatility or bid/ask. Importing your own CSV is still possible but optional |
| Audit log (hash-chained) | Yes, and it uses the same hash formula as the desktop app |
| Saved last data when offline or when NSE blocks us | Yes (shown as **Stale**) |

## 2b. Speed
Loading is built around three rules, measured against live NSE:
- **Saved data first.** Every screen answers at once from what the phone already holds and refreshes behind the scenes (the
  banner says **Updating…**). Only the very first launch has to wait.
- **One bulk call, not fifty.** The home page used to make a quote request per stock. NSE has a bulk-quote call, so the whole home
  page is about 6 requests. Measured: a cold load of 50 stocks takes about 2 s with 19 requests (the extra ones are retries, see next).
  Reopening it is instant.
- **Warm sessions.** NSE's servers answer "not found" to about 60% of requests that reach the wrong backend. The app now keeps two
  connections open and simply retries on the same session (1 request) instead of starting over (3 requests). The 52-week range and
  30-day change fill in a few seconds later, from a background job that runs two requests at a time (never more, to stay polite to NSE).

## 2c. Live during market hours, last update otherwise
| When | Stock prices, indices, movers | Option chain |
|---|---|---|
| **Market open** (Mon-Fri 09:15-15:30 India time) | live quotes from NSE, refreshed about every minute while the app is open; the banner reads "Market open" | contracts (open interest, closing prices) from NSE's last published end-of-day file; **spot price and the at-the-money row are live** |
| **Closed** (evenings, nights, weekends, before the open) | the last update of the day, i.e. that session's close; the banner reads "Market closed for the day / weekend / opens at 9:15 am". After the close the app makes one catch-up fetch so the close is real, then stays quiet (data is re-checked at most every 30 minutes) | the last published end-of-day file; spot as in that file |
| **A weekday holiday** | recognised because NSE's quotes still carry the previous trading day's date; the banner says "No trading today (exchange holiday?)" | as above |

NSE publishes no free live option feed, and its live option-chain page cannot be used by an app without imitating a browser, so the
option contracts themselves cannot be live. This is stated on the screen. Live prices cost one request per stock (NSE has no multi-stock
live call), made two at a time, so they arrive over a few seconds with the most-traded stocks first.

## 2d. Reading the screens
- **Green and red:** every increase is green and every decrease red (prices, changes, 30-day moves, change in open interest,
  score signs, and the figures in generated market updates). Signed values also carry a "+" or "−", so colour is never the only cue.
- **Tables never wrap.** Text stays on one line and a wide table scrolls sideways inside its own box; the page itself never scrolls sideways.
- **News and updates** use a medium text size (headlines 14 px, meta lines 13 px, update headlines 18 px).

## 3. What is different from the desktop app
- **Foreground only.** The app refreshes while it is open. Android does not let it run in the background, so there is no
  2.5-minute background download. The option chain checks for a newer file when you open the screen, at most every 20 minutes.
- **Smaller history:** the phone keeps the newest 20 option snapshots per symbol and expiry (the desktop keeps 300).
- **No `/api/metrics`, rate limiter or load shedding:** there is one user and no network server, so they do not apply.
- **Sign-in lasts 15 days.** You stay signed in after closing the app until you tap Sign out; the session ends by itself 15 days
  after sign-in. Sign out returns to the sign-in page.
- Data lives in the app's private storage. **Uninstalling the app deletes your accounts and saved data.** Backups to
  Google are switched off so that account details never leave the phone.

## 4. Why a native app and not just a web page
A web page (including an iPhone "Add to Home Screen" app) is not allowed by browsers to read NSE, Google News or Yahoo
RSS directly: those servers do not send the CORS headers a browser requires. The Android app uses Capacitor's native HTTP
layer, which is not subject to that rule. This is the reason the iPhone version needs a native build too (section 7).

## 5. Be aware
- **NSE may block or rate-limit.** If NSE answers 401, 403 or 429, the app stops all NSE requests for 15 minutes
  (remembered across restarts) and shows saved data as **Stale**. Many phones fetching from the same service can look like
  scraping to NSE, and a public rollout is a decision to make with NSE's terms in front of you. No NSE data is bundled
  in the app, and every user fetches their own.
- **Option chain source.** NSE's live option-chain API is protected against automated clients, so the app does not use it and does
  not imitate a browser. It downloads the end-of-day derivatives file that NSE publishes for download, identified as an app, at most
  every 20 minutes and only for days it does not have yet. The tests contain an 11-row excerpt of that public file as a fixture.
- **Licensing:** NSE market data has redistribution rules. This app displays data on the device that fetched it and
  does not rebroadcast it. Check NSE's terms before publishing the app widely.
- **Recovery by name, email and date of birth is weak by nature** (anyone who knows all three can take over the account;
  nothing verifies the email). On a phone that only you use, that is a smaller risk than on a shared computer. Details:
  `docs/OPERATIONS.md`, Accounts.
- Nothing here is investment advice.

## 6. Build it yourself
The Android project is generated, not committed. You need Node 22+, Python 3 with Pillow, JDK 21 and the Android SDK
(or just Android Studio).

```bash
cd mobile
npm ci
npm test                                   # engine tests (no network)
node scripts/build-www.mjs                 # UI + engine -> mobile/www
npx cap add android
python3 scripts/prepare-android.py         # icons, backups off, version
npx cap sync android
cd android && ./gradlew assembleDebug      # -> app/build/outputs/apk/debug/app-debug.apk
```
`.github/workflows/android.yml` does exactly this. Pushing a tag such as `mobile-v0.3.0` builds the APK and publishes it
as a GitHub Release.

**Signing and updates.** Android only installs an update over an existing app if both builds are signed with the **same key**.
The CI build uses a *debug* key (fine for sideloading; Google Play will not accept it). Until the repository has one stable
key, every build gets a new random one, so a newer APK cannot be installed over an older one: you would have to uninstall
first, which **deletes your accounts and saved data**. Set the key up once, before you tell people to use the app:

1. Create the key file (once, on your own computer, in a folder that is *not* the repository; `*.keystore` is git-ignored as a safety net):
   ```bash
   keytool -genkeypair -keystore debug.keystore -storepass android -keypass android -alias androiddebugkey \
     -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
   ```
2. Store it as a repository secret (this uploads it encrypted; GitHub never shows it again):
   ```bash
   base64 < debug.keystore | gh secret set MARKETLENS_DEBUG_KEYSTORE --repo akash-8991/rea_marketwatch_app
   ```
   Or in the browser: repository **Settings > Secrets and variables > Actions > New repository secret**, name
   `MARKETLENS_DEBUG_KEYSTORE`, value = the output of `base64 < debug.keystore`.
3. **Back the file up** somewhere private (password manager, encrypted drive). If you lose it you can make a new one, but
   then everyone must uninstall once. **Never commit it or share it.** Anyone holding it can sign an app that Android treats
   as an update to yours.
4. Tag a new version (`mobile-v0.3.2`, see RELEASING.md). The build log should no longer print the "No MARKETLENS_DEBUG_KEYSTORE
   secret" warning. From then on, every build installs over the previous one and keeps its data.

The password `android` is the standard debug-key password; the secret is the file itself. For Google Play, create a separate
upload keystore with a real password, store both as secrets and switch the workflow to `assembleRelease`.

## 7. iPhone (later)
Not built, and not possible from this repository's current environment. What it needs:

1. **A Mac with Xcode** (Capacitor builds an iOS app with Xcode; there is no way around this).
2. **An Apple ID.** Running your own build on your own iPhone is free but the app expires after 7 days and must be
   re-installed. **TestFlight or the App Store needs the Apple Developer Program (about US$99 per year).**
3. The same `mobile/www` code: `npm i @capacitor/ios@8.5.3 && npx cap add ios && npx cap sync ios`, then open
   `mobile/ios/App` in Xcode, choose your team and run. The engine, UI and tests are shared, so the work left is signing,
   an iOS icon set and testing on a device.

Until then, an iPhone can use the desktop version in Safari if a computer on the same network runs it, but that is
not a standalone app and the desktop server is deliberately bound to `127.0.0.1` only.

## 8. What has and has not been verified
**Verified (automated, in this repository):**
- The JavaScript engine reproduces the Python engine's output on the same inputs: technical, fundamental and sentiment
  analysis, option-CSV parsing and summaries, RSS parsing, dividend maths (`mobile/tests/golden.json` is generated by the
  Python code). Rounding follows Python's rules, which caught one real mismatch (51.675 rounds to 51.67 in Python).
- An audit chain written by Python verifies in JavaScript and the other way round; a password hash made in Python verifies
  in JavaScript and JavaScript produces the identical hash for the same salt.
- End to end through the router with a fake NSE server that fails half of its requests: retries, the two-request cap, the
  circuit breaker (also after a restart), stale fallback, sign-up, lockout, recovery, CSV import, duplicates and rejections.
- The real web interface, running on the engine in a desktop browser at phone size, with no Python server: sign-up and sign-in,
  Home, Markets, Screener, Stock page, and the Option chain loading by itself from a real excerpt of NSE's 23-Oct-2026 file.
- Speed, with tests: one bulk quote instead of per-stock calls, session reuse under a 60% misroute rate, answering at once while
  NSE hangs. A live cold load of the home page took about 2.3 s (one measurement, one network; yours will differ).
- Market hours: the clock rules (session edges, weekends, holiday recognition) and a simulated trading day: live prices move on the next
  refresh, nothing is re-fetched inside the minute, the close is fetched once and kept, a holiday is not shown as "Live", and the option
  chain's spot and at-the-money row follow the live price. One bug found and fixed by these tests: a refresh could overwrite the saved
  close with the older end-of-day file.
- Layout at phone width on eight screens: every table inside a scrolling box, no wrapped table text, no sideways page scroll.
- Phone layout: the header starts at least 1 cm below the top edge and moves further down under a larger cut-out or status bar
  (checked by simulating insets; see the next list for what is not checked).

**Not verified:**
- A real Android device or emulator: installation, how the camera cut-out actually looks on your phone model, the file picker, back button, rotation, keyboard behaviour and
  performance (the PBKDF2 sign-up/sign-in step uses 600,000 rounds; it should take about a second on a recent phone, slower on
  old ones).
- Capacitor's native HTTP layer against live NSE, Yahoo and Google endpoints, and its download of NSE's derivatives zip (the app asks the native layer for the
  file as base64; this path is untested on a device). The engine is written to work with it,
  and falls back to saved data if it does not.
- Live NSE at all since NSE blocked this project's earlier test traffic.
- The Gradle build, until the GitHub Actions workflow has run (check the **Actions** tab).
- Any iPhone.
