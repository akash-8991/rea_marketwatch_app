# Zerodha (Kite Connect) connection

Desktop app only (the pip package and the container). The phone app has no broker connection: Kite Connect needs a whitelisted static IP to place orders, and your API secret should stay on a machine you control.
Paper and shadow trading work everywhere.

## Setting it up

1. At developers.kite.trade create an app. Set its **Redirect URL** to exactly `http://127.0.0.1:8080/broker/callback` (use your own host and port if you changed them; the Settings page shows the exact value).
2. Open **Settings, Zerodha**, enter the app's API key and secret, and press *Save*. They are written to `broker.json` in the data folder with owner-only permissions (0600), are never sent back to the browser, and are never logged or audited. They are **not encrypted at rest** (the standard library has no encryption): protect the data folder like any credential file, and use *Remove key and secret* when you are done.
3. Press *Login with Zerodha*. You sign in on Zerodha's own page (your password and 2FA never touch MarketLens). Zerodha redirects the browser back with a one-time `request_token`; the app checks the `state` it issued (login CSRF protection), exchanges the token (SHA-256 of key + token + secret) and stores the access token. If the redirect does not come back you can paste the request_token by hand.
4. The session lasts until about 06:00 India time the next day, then you sign in again (the page says when).

Reading (profile, margins, positions, holdings, today's orders) works whenever you are connected.

## Placing orders (off by default)

Orders are refused unless the server was started with **`--enable-live-orders`** (or `MARKETLENS_LIVE_ORDERS=1`). Starting it prints that live orders are enabled. Even then every order passes two independent gates:

* **The desk's risk engine in the browser** (see [DESK.md](DESK.md)): all the checks, mode, manual approval, pre-live checklist.
* **The server's broker gate** (`broker.py`, cannot be bypassed from the page): live flag; kill switch (a flag file, also set from the Operator page); limit orders only unless market orders are allowed; a per-order value cap (default Rs 1,00,000); at most 5 orders a second (Kite allows 10); a valid algo tag on every order; the same tag is never sent twice; a refusal frees the tag, an unknown outcome (timeout) keeps it blocked so there is no blind retry, and the order is found again by tag or id.

Zerodha's own rules still apply and cannot be handled by software: API order placement needs a whitelisted static IP (up to two), API orders count as algo orders under SEBI and NSE rules (tagging, registration and hosting requirements depend on your account type), and a client account is capped at 10 orders per second. Check the current circulars yourself; the Operator page has a pre-live checklist and live mode stays locked until it is ticked.

**Not verified against Zerodha's servers.** The tests use a fake Kite (login checksum, state, token expiry, gates, status mapping, idempotency, kill switch). Treat the first live order as a test: tiny quantity, Manual approval mode, Zerodha chosen as the broker on the Operator page.

## Endpoints

`GET /api/broker/status` (never contains the secret or token), `GET /api/broker/login-url`, `GET /api/broker/account`, `GET /api/broker/order/<id>` and `GET /api/broker/order?tag=`, `POST /api/broker/credentials | session | order | cancel | logout | forget | kill` (all POSTs need the `X-Requested-With: MarketLens` header and JSON), `GET /broker/callback` (the redirect target). Rate class `broker`: 30 burst, 5 a second. Broker events (credentials saved or removed, login, logout, orders, cancels, refusals, kill switch) go to the audit log without secrets.
