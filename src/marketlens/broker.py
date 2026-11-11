"""Zerodha Kite Connect adapter and the server-side gate in front of it.

What lives here, and what does not:
  * Login: you enter your own Kite Connect API key and secret on the Settings page, sign in at Zerodha (their page, never this app), and Zerodha sends a one-time
    `request_token` back to http://<this app>/broker/callback. The app exchanges it for an access token (SHA-256 of key + token + secret, as Kite Connect requires).
    The token lasts until about 06:00 India time the next day; then you sign in again.
  * Secrets: the API secret and access token are written to `broker.json` in the data folder with owner-only permissions (0600) and are never sent to the browser, logged or
    audited. They are not encrypted at rest (the standard library has no encryption): protect the data folder like any other credential file.
  * Reading (profile, margins, positions, holdings, orders) works whenever you are connected.
  * Placing orders is OFF unless the server was started with --enable-live-orders (or MARKETLENS_LIVE_ORDERS=1). Even then, every order passes this gate: kill switch, a
    valid algo tag, limit orders only unless market orders are allowed, a per-order value cap, an orders-per-second cap, and idempotency (the same tag is never sent twice).
    The browser's risk engine decides first; this gate is the independent second check that cannot be bypassed from the page.
  * Zerodha requires the API caller to have a whitelisted static IP for order placement. This app cannot arrange that; see docs/BROKER.md.
Not tested against Zerodha's live servers here: the tests use a fake Kite. Treat the first live order as a test, with a tiny quantity."""
import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from . import optiondb
from .config import settings

KITE = "https://api.kite.trade"
LOGIN = "https://kite.zerodha.com/connect/login"
FILE = "broker.json"
KILL_FILE = "broker-kill.flag"
KEY_RE = re.compile(r"^[A-Za-z0-9]{6,40}$")
TAG_RE = re.compile(r"^[A-Za-z0-9]{1,20}$")
SYM_RE = re.compile(r"^[A-Z0-9&_-]{1,24}$")
MAX_ORDER_VALUE = 100_000     # rupees per order unless raised in the settings file
MAX_OPS = 5                   # orders per second sent to Kite (Kite allows 10 a second per account)
_lock = threading.Lock()
_states = {}                  # login CSRF nonces -> expiry
_tags = {}                    # tag -> broker order id (idempotency, this run)
_sent = []                    # recent order send times


class BrokerError(RuntimeError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _path():
    return os.path.join(str(settings.data_dir), FILE)


def _read():
    try:
        with open(_path()) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write(d):
    os.makedirs(str(settings.data_dir), exist_ok=True)
    tmp = _path() + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)   # owner-only from the first byte
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
    os.replace(tmp, _path())
    try:
        os.chmod(_path(), 0o600)
    except OSError:
        pass


def _audit(event, detail, outcome="ok"):
    optiondb.safe_audit(event, "broker", detail, outcome=outcome, channel="broker")


def _expired(d):
    return not d.get("access_token") or time.time() >= d.get("token_expires", 0)


def _next_expiry(now=None):
    """Kite access tokens stop working at about 06:00 India time the next day."""
    now = now or time.time()
    ist = now + 5.5 * 3600
    day = ist - ist % 86400
    exp = day + 6 * 3600
    if ist >= exp:
        exp += 86400
    return exp - 5.5 * 3600


def kill_active():
    return os.path.exists(os.path.join(str(settings.data_dir), KILL_FILE))


def set_kill(on, reason=""):
    p = os.path.join(str(settings.data_dir), KILL_FILE)
    if on:
        os.makedirs(str(settings.data_dir), exist_ok=True)
        with open(p, "w") as f:
            f.write(str(int(time.time())) + " " + reason[:200])
    elif os.path.exists(p):
        os.remove(p)
    _audit("broker_kill", f"kill switch {'ON' if on else 'off'}: {reason[:120]}")
    return kill_active()


def status():
    """Everything the Settings page may show. Never contains the secret or the token."""
    d = _read()
    key = d.get("api_key") or ""
    return {"configured": bool(key and d.get("api_secret")), "apiKey": (key[:3] + "…" + key[-2:]) if len(key) > 6 else ("set" if key else None), "connected": not _expired(d),
            "user": {"id": d.get("user_id"), "name": d.get("user_name"), "email": d.get("email")} if d.get("user_id") else None, "tokenExpiresAt": d.get("token_expires"),
            "liveOrdersEnabled": bool(settings.live_orders), "killSwitch": kill_active(), "maxOrderValue": d.get("max_order_value", MAX_ORDER_VALUE), "maxOps": MAX_OPS,
            "redirectUrl": f"http://{settings.host}:{settings.port}/broker/callback", "marketData": _market_data()}


def _market_data():
    from . import kitedata   # imported here: kitedata uses this module
    return kitedata.status()


def save_credentials(api_key, api_secret):
    if not KEY_RE.match(api_key or "") or not KEY_RE.match(api_secret or ""):
        raise BrokerError("The API key and secret are letters and digits only (6 to 40 characters). Copy them from your Kite Connect app page.")
    _write({"api_key": api_key, "api_secret": api_secret})   # a new key ends any old session
    _audit("broker_credentials_saved", "API key saved (secret not logged)")
    return status()


def forget():
    try:
        os.remove(_path())
    except OSError:
        pass
    _audit("broker_credentials_removed", "API key, secret and token removed")
    return status()


def login_url():
    d = _read()
    if not d.get("api_key"):
        raise BrokerError("Save your API key and secret first.")
    state = secrets.token_urlsafe(16)
    with _lock:
        for k in [k for k, t in _states.items() if t < time.time()]:
            _states.pop(k, None)
        _states[state] = time.time() + 600
    return {"url": f"{LOGIN}?v=3&api_key={urllib.parse.quote(d['api_key'])}&redirect_params={urllib.parse.quote('state=' + state)}", "redirectUrl": status()["redirectUrl"]}


def check_state(state):
    with _lock:
        t = _states.pop(state or "", 0)
    return t > time.time()


def _http(method, url, headers=None, data=None, timeout=12):
    """The one place that touches the network: tests replace it."""
    req = urllib.request.Request(url, data=data, method=method, headers=dict({"X-Kite-Version": "3", "User-Agent": "MarketLens/1.0"}, **(headers or {})))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(12_000_000)   # the instrument list alone is several MB
    except urllib.error.HTTPError as e:
        return e.code, e.read(200_000)
    except OSError as e:
        raise BrokerError(f"Could not reach Zerodha: {str(e)[:100]}", 502)


def _call(method, path, params=None, form=None, auth=True):
    d = _read()
    headers = {}
    if auth:
        if _expired(d):
            raise BrokerError("Not connected to Zerodha (the token expires about 06:00 IST every day): sign in again on the Settings page.", 401)
        headers["Authorization"] = f"token {d['api_key']}:{d['access_token']}"
    url = KITE + path + (("?" + urllib.parse.urlencode(params)) if params else "")
    body = urllib.parse.urlencode(form).encode() if form is not None else None
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    status_code, raw = _http(method, url, headers, body)
    try:
        doc = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise BrokerError(f"Zerodha answered with HTTP {status_code} and no JSON", 502)
    if status_code >= 400 or doc.get("status") == "error":
        msg = str(doc.get("message") or f"HTTP {status_code}")[:200]
        if doc.get("error_type") == "TokenException":
            d.pop("access_token", None)
            _write(d)
            raise BrokerError(f"Zerodha rejected the session ({msg}). Sign in again.", 401)
        raise BrokerError(msg, 400 if status_code < 500 else 502)
    return doc.get("data")


def raw_get(path, params=None):
    """An authenticated GET whose answer is not JSON (the instrument list is a CSV). Returns the text."""
    d = _read()
    if _expired(d):
        raise BrokerError("Not connected to Zerodha (the token expires about 06:00 IST every day): sign in again on the Settings page.", 401)
    url = KITE + path + (("?" + urllib.parse.urlencode(params)) if params else "")
    code, raw = _http("GET", url, {"Authorization": f"token {d['api_key']}:{d['access_token']}"}, None, 60)
    if code >= 400:
        raise BrokerError(f"Zerodha answered HTTP {code}", 400 if code < 500 else 502)
    return raw.decode("utf-8", "replace")


def exchange(request_token):
    """Trade the one-time request_token for an access token."""
    d = _read()
    if not d.get("api_key") or not d.get("api_secret"):
        raise BrokerError("Save your API key and secret first.")
    if not re.match(r"^[A-Za-z0-9]{8,64}$", request_token or ""):
        raise BrokerError("That does not look like a request_token.")
    checksum = hashlib.sha256((d["api_key"] + request_token + d["api_secret"]).encode()).hexdigest()
    data = _call("POST", "/session/token", form={"api_key": d["api_key"], "request_token": request_token, "checksum": checksum}, auth=False)
    d.update(access_token=data["access_token"], user_id=data.get("user_id"), user_name=data.get("user_name") or data.get("user_shortname"), email=data.get("email"),
             login_time=data.get("login_time"), token_expires=_next_expiry())
    _write(d)
    _audit("broker_login", f"connected as {d.get('user_id')}")
    return status()


def logout():
    d = _read()
    if d.get("access_token"):
        try:
            _call("DELETE", "/session/token", params={"api_key": d["api_key"], "access_token": d["access_token"]}, auth=False)
        except BrokerError:
            pass
        d.pop("access_token", None)
        d.pop("token_expires", None)
        _write(d)
        _audit("broker_logout", "session ended")
    return status()


def account():
    """Profile and margins, with positions and today's orders: the read-only picture the Settings page shows."""
    out = {"profile": _call("GET", "/user/profile"), "margins": _call("GET", "/user/margins/equity")}
    for k, p in (("positions", "/portfolio/positions"), ("holdings", "/portfolio/holdings"), ("orders", "/orders")):
        try:
            out[k] = _call("GET", p)
        except BrokerError as e:
            out[k] = {"error": str(e)}
    return out


MAP = {"COMPLETE": "FILLED", "REJECTED": "REJECTED", "CANCELLED": "CANCELLED", "OPEN": "ACKNOWLEDGED", "TRIGGER PENDING": "ACKNOWLEDGED", "PUT ORDER REQ RECEIVED": "SUBMITTED",
       "VALIDATION PENDING": "SUBMITTED", "OPEN PENDING": "SUBMITTED", "MODIFY PENDING": "ACKNOWLEDGED", "CANCEL PENDING": "CANCEL_REQUESTED", "AMO REQ RECEIVED": "ACKNOWLEDGED"}


def map_order(o):
    """A Kite order row in the desk's vocabulary (see desk-core.js STATES)."""
    st = MAP.get(str(o.get("status", "")).upper(), "UNKNOWN")
    filled = int(o.get("filled_quantity") or 0)
    if st == "ACKNOWLEDGED" and filled > 0:
        st = "PARTIALLY_FILLED"
    return {"status": st, "broker_order_id": o.get("order_id"), "filled": filled, "price": o.get("average_price") or None, "reason": o.get("status_message") or None, "tag": o.get("tag")}


def order_status(order_id=None, tag=None):
    """Where an order stands, looked up by id, or by tag when the id is unknown (a timeout after sending)."""
    rows = _call("GET", "/orders")
    for o in rows or []:
        if (order_id and o.get("order_id") == order_id) or (tag and o.get("tag") == tag):
            return map_order(o)
    return None


def validate(p, allow_market=False):
    """The gate's own checks on an order payload (independent of the browser's risk engine). Returns the cleaned form fields or raises BrokerError."""
    d = _read()
    cap = d.get("max_order_value", MAX_ORDER_VALUE)
    if not settings.live_orders:
        raise BrokerError("Live orders are switched off. Start the server with --enable-live-orders to allow them.", 403)
    if kill_active():
        raise BrokerError("The kill switch is on: no new orders.", 423)
    if not isinstance(p, dict):
        raise BrokerError("bad order")
    sym, ex = str(p.get("tradingsymbol", "")).upper(), str(p.get("exchange", "NSE")).upper()
    side, otype, product, validity = str(p.get("transaction_type", "")).upper(), str(p.get("order_type", "LIMIT")).upper(), str(p.get("product", "CNC")).upper(), str(p.get("validity", "DAY")).upper()
    try:
        qty, price = int(p.get("quantity")), float(p.get("price") or 0)
    except (TypeError, ValueError):
        raise BrokerError("quantity and price must be numbers")
    tag = str(p.get("tag", ""))
    if not SYM_RE.match(sym) or ex not in ("NSE", "BSE"):
        raise BrokerError("bad symbol or exchange")
    if side not in ("BUY", "SELL") or product not in ("CNC", "MIS", "NRML") or validity not in ("DAY", "IOC"):
        raise BrokerError("bad side, product or validity")
    if otype not in ("LIMIT", "MARKET") or (otype == "MARKET" and not allow_market):
        raise BrokerError("Only limit orders are allowed (market orders are off by default).")
    if qty < 1 or qty > 100000 or (otype == "LIMIT" and price <= 0):
        raise BrokerError("bad quantity or price")
    if otype == "LIMIT" and qty * price > cap:
        raise BrokerError(f"Order value {qty * price:,.0f} is above the limit {cap:,.0f}.", 403)
    if not TAG_RE.match(tag):
        raise BrokerError("Every order needs an algo tag (letters and digits, up to 20 characters).")
    f = {"tradingsymbol": sym, "exchange": ex, "transaction_type": side, "order_type": otype, "quantity": str(qty), "product": product, "validity": validity, "tag": tag}
    if otype == "LIMIT":
        f["price"] = f"{price:.2f}"
    return f


def place_order(payload, allow_market=False):
    """Send one order to Kite after every gate check. The same tag is never sent twice."""
    f = validate(payload, allow_market)
    with _lock:
        if f["tag"] in _tags:
            return {"order_id": _tags[f["tag"]], "duplicate": True}
        now = time.time()
        _sent[:] = [t for t in _sent if now - t < 1]
        if len(_sent) >= MAX_OPS:
            raise BrokerError("Too many orders in one second.", 429)
        _sent.append(now)
        _tags[f["tag"]] = None
    try:
        data = _call("POST", "/orders/regular", form=f)
    except BrokerError as e:
        with _lock:
            _tags.pop(f["tag"], None) if e.status < 500 else None   # a definite refusal frees the tag; an unknown outcome keeps it blocked (no blind retry)
        _audit("broker_order_failed", f"{f['transaction_type']} {f['quantity']} {f['tradingsymbol']} tag {f['tag']}: {str(e)[:120]}", "error")
        raise
    oid = (data or {}).get("order_id")
    with _lock:
        _tags[f["tag"]] = oid
    _audit("broker_order", f"{f['transaction_type']} {f['quantity']} {f['tradingsymbol']} {f['order_type']} @ {f.get('price', 'MKT')} tag {f['tag']} -> {oid}")
    return {"order_id": oid}


def cancel_order(order_id):
    if not settings.live_orders:
        raise BrokerError("Live orders are switched off.", 403)
    if not re.match(r"^[0-9A-Za-z]{4,30}$", order_id or ""):
        raise BrokerError("bad order id")
    data = _call("DELETE", f"/orders/regular/{order_id}")
    _audit("broker_order_cancel", f"cancel {order_id}")
    return data
