# MarketLens on your phone

MarketLens for Android is a standalone app: it does its own work on the phone, with no computer and no server. It is
the same web interface as the desktop version, running on a JavaScript copy of the engine inside a Capacitor shell.

**Status: Android only.** iPhone is not built yet (see section 7). **The app has not been run on a real phone.** What
has been checked is listed in section 8; please report anything that breaks.

## 1. Install on Android (sideloading)
Android 7.0 or newer.

1. On your phone, open [this direct link](https://github.com/akash-8991/rea_marketwatch_app/raw/main/downloads/MarketLens-android.apk) in your browser (it downloads `MarketLens-android.apk`; the checksum
   is next to it as `MarketLens-android.apk.sha256`). Older versions are on the **Releases** page.
2. Optional but recommended, check the download on a computer: `cd downloads && shasum -a 256 -c MarketLens-android.apk.sha256`.
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
| Option chain | From a CSV you download from NSE's site in your phone browser, then **Import**; same format as the desktop app |
| Audit log (hash-chained) | Yes, and it uses the same hash formula as the desktop app |
| Saved last data when offline or when NSE blocks us | Yes (shown as **Stale**) |

## 3. What is different from the desktop app
- **Foreground only.** The app refreshes while it is open. Android does not let it run in the background, so there is no
  2.5-minute background download. The option chain is imported by hand.
- **No inbox folder** for CSV files; use the Import button.
- **Smaller history:** the phone keeps the newest 20 option snapshots per symbol and expiry (the desktop keeps 300).
- **No `/api/metrics`, rate limiter or load shedding:** there is one user and no network server, so they do not apply.
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

**Signing and updates.** The APK is signed with Android's *debug* key so that it installs. That is fine for sideloading;
Google Play will not accept it. Unless the repository has a stable key, every CI build gets a new random one, and
**Android refuses to install a build over an app signed with a different key, so you would have to uninstall first, which
deletes your accounts and saved data.** To avoid that, create one key once and give it to the workflow:

```bash
keytool -genkeypair -keystore debug.keystore -storepass android -keypass android -alias androiddebugkey \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
base64 < debug.keystore | gh secret set MARKETLENS_DEBUG_KEYSTORE --repo <owner>/<repo>
```
Keep `debug.keystore` private and backed up, and never commit it. For Google Play, create a separate upload keystore and
switch the workflow to `assembleRelease` with signing secrets.

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
- The real web interface, running on the engine in a desktop browser with no Python server: sign-up and sign-in, Home,
  Markets, Screener, Stock page, Option chain with an imported CSV.

**Not verified:**
- A real Android device or emulator: installation, the file picker, back button, rotation, keyboard behaviour and
  performance (the PBKDF2 sign-up/sign-in step uses 600,000 rounds; it should take about a second on a recent phone, slower on
  old ones).
- Capacitor's native HTTP layer against live NSE, Yahoo and Google endpoints. The engine is written to work with it,
  and falls back to saved data if it does not.
- Live NSE at all since NSE blocked this project's earlier test traffic.
- The Gradle build, until the GitHub Actions workflow has run (check the **Actions** tab).
- Any iPhone.
