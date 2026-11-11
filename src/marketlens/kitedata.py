"""Zerodha (Kite Connect) as the first source of market data; NSE is the fallback.

If you are connected to Zerodha (Settings, Zerodha), live quotes, the index levels and daily history come from Kite Connect. If you are not connected, the Kite session has expired, the
Kite call fails, or your Kite plan does not include that data, the app silently uses NSE exactly as before, and the answer says which source it came from (`source`: "zerodha" or "nse").
What stays on NSE whatever you connect: the stock universe and fundamentals snapshot, corporate actions, option chains, listings, and indices Kite does not carry.

Kite limits: the quote call allows about 1 request a second (up to 500 instruments), historical data about 3 a second. This module batches symbols into one call, reuses an answer for a second,
and backs off after a failure (a permission failure such as a missing data plan: 5 minutes; a network failure: 30 seconds) so a broken Kite never slows the screens down.
Not verified against Zerodha's live servers: the tests use a fake Kite."""
import csv
import datetime
import io
import threading
import time

from . import broker, store
from .config import settings

QUOTE_GAP = 1.0                       # Kite allows one quote request a second
BACKOFF = {"permission": 300, "network": 30}
INDEX_ALIASES = {"NIFTY FINANCIAL SERVICES": ["NIFTY FIN SERVICE"], "NIFTY OIL & GAS": ["NIFTY OIL AND GAS"], "NIFTY HEALTHCARE INDEX": ["NIFTY HEALTHCARE"]}
_lock = threading.Lock()
_down = {"quote": 0.0, "history": 0.0}
_last_error = {"quote": None, "history": None}
_snap = {}                            # "NSE:INFY" -> (normalised quote, time)
_last_call = [0.0]
_used = {"quote": None}               # where the latest quote came from, for the status line


def reset():
    """Forget everything (tests)."""
    with _lock:
        _down.update(quote=0.0, history=0.0)
        _last_error.update(quote=None, history=None)
        _snap.clear()
        _last_call[0] = 0.0
        _used["quote"] = None


def connected():
    return not settings.offline and not broker._expired(broker._read())


def active(feature="quote"):
    """True when Kite should be tried: signed in to Zerodha, not offline, and not backing off after a failure."""
    return connected() and time.time() >= _down.get(feature, 0)


def _fail(feature, e):
    kind = "network" if getattr(e, "status", 0) == 502 else "permission"
    if getattr(e, "status", 0) == 401:
        _down[feature] = 0.0               # not connected any more: connected() is False already, nothing to back off from
    else:
        _down[feature] = time.time() + BACKOFF[kind]
    _last_error[feature] = str(e)[:160]


def status():
    """What the Settings page shows about market data: which source is in use and why."""
    c = connected()
    if not c:
        return {"source": "nse", "reason": "offline mode: NSE saved snapshots only" if settings.offline else "not connected to Zerodha", "lastError": None}
    errs = {k: v for k, v in _last_error.items() if v}
    now = time.time()
    backing = [k for k, t in _down.items() if t > now]
    return {"source": "zerodha" if "quote" not in backing else "nse", "reason": "connected to Zerodha" if not backing else "Zerodha data failed; using NSE for a while: " + "; ".join(f"{k}: {v}" for k, v in errs.items()),
            "lastError": errs or None, "usedForQuotes": _used["quote"]}


def _stamp(v):
    if not v:
        return None
    return str(v).replace("T", " ")[:19]


def _norm(q):
    """A Kite quote in the shape NSE's quote has, so everything downstream is source-agnostic."""
    ohlc = q.get("ohlc") or {}
    price, prev = q.get("last_price"), ohlc.get("close")
    if price is None:
        return None
    return {"lastTradedPrice": price, "preClosePrice": prev, "openPrice": ohlc.get("open"), "highPrice": ohlc.get("high"), "lowPrice": ohlc.get("low"),
            "volume": q.get("volume") or q.get("volume_traded"), "perChange": round((price - prev) / prev * 100, 2) if prev else None,
            "latestTimestamp": _stamp(q.get("timestamp") or q.get("last_trade_time")), "fiftyTwoWeekHigh": None, "fiftyTwoWeekLow": None, "value": None}


def _fetch(instruments):
    """One /quote call for the given 'EXCH:SYMBOL' strings, spaced by the Kite limit. Returns {instrument: normalised}; raises BrokerError."""
    with _lock:
        wait = QUOTE_GAP - (time.time() - _last_call[0])
        if wait > 0:
            return {}                      # asked again inside the limit: the caller uses what it has or falls back for the rest
        _last_call[0] = time.time()
    data = broker._call("GET", "/quote", params=[("i", i) for i in instruments[:500]]) or {}
    out = {}
    for k, v in data.items():
        n = _norm(v)
        if n:
            out[k] = n
            _snap[k] = (n, time.time())
    return out


def prefetch(symbols, index_names):
    """One Kite call for the stocks and the indices a screen needs together (the quote limit is one call a second, so they must share it). Fills the one-second snapshot that
    quotes() and indices() read. Never raises."""
    if not active("quote"):
        return
    wanted = ["NSE:" + s for s in symbols] + ["NSE:" + c for n in index_names for c in [n] + INDEX_ALIASES.get(n, [])]
    now = time.time()
    missing = [i for i in wanted if not (i in _snap and now - _snap[i][1] < QUOTE_GAP)]
    if not missing:
        return
    try:
        if _fetch(missing):
            _used["quote"] = "zerodha"
            _last_error["quote"] = None
    except broker.BrokerError as e:
        _fail("quote", e)


def quotes(symbols):
    """Quotes for NSE stock symbols from Kite: {symbol: nse-shaped quote} for the symbols Kite answered; {} when Kite is not usable. Never raises."""
    if not active("quote") or not symbols:
        return {}
    now = time.time()
    have = {s: _snap["NSE:" + s][0] for s in symbols if "NSE:" + s in _snap and now - _snap["NSE:" + s][1] < QUOTE_GAP}
    missing = [s for s in symbols if s not in have]
    if missing:
        try:
            got = _fetch(["NSE:" + s for s in missing])
            have.update({s: got["NSE:" + s] for s in missing if "NSE:" + s in got})
            if got:
                _used["quote"] = "zerodha"
                _last_error["quote"] = None
        except broker.BrokerError as e:
            _fail("quote", e)
    return have


def indices(names):
    """Index levels from Kite in the shape of NSE's live-index rows, keyed by upper-case NSE index name. {} when Kite is not usable. Never raises."""
    if not active("quote") or not names:
        return {}
    wanted = {}
    for n in names:
        for cand in [n] + INDEX_ALIASES.get(n, []):
            wanted["NSE:" + cand] = n
    now = time.time()
    rows = {k: _snap[k][0] for k in wanted if k in _snap and now - _snap[k][1] < QUOTE_GAP}
    if not rows:
        try:
            rows = {k: v for k, v in _fetch(list(wanted)).items() if k in wanted}
            if rows:
                _last_error["quote"] = None
        except broker.BrokerError as e:
            _fail("quote", e)
            return {}
    out = {}
    for k, n in rows.items():
        name = wanted[k]
        last, prev = n["lastTradedPrice"], n["preClosePrice"]
        out[name.upper()] = {"indexName": name, "last": last, "previousClose": prev, "percChange": n["perChange"], "change": round(last - prev, 2) if prev is not None else None,
                             "open": n["openPrice"], "high": n["highPrice"], "low": n["lowPrice"], "timeVal": n["latestTimestamp"]}
    return out


# ---------- daily history ----------
def _instruments():
    """{'EQ': {symbol: token}, 'IDX': {index name: token}} from Kite's instrument list (a large CSV), saved for a day."""
    rec = store.disk_get("kite-instruments")
    age = store.disk_age("kite-instruments")
    if rec and age is not None and age < 24 * 3600:
        return rec
    text = broker.raw_get("/instruments/NSE")
    eq, idx = {}, {}
    for row in csv.DictReader(io.StringIO(text)):
        tok, sym = row.get("instrument_token"), row.get("tradingsymbol")
        if not tok or not sym:
            continue
        if row.get("segment") == "INDICES":
            idx[sym.upper()] = int(tok)
        elif row.get("segment") == "NSE" and row.get("instrument_type") == "EQ":
            eq[sym] = int(tok)
    rec = {"EQ": eq, "IDX": idx}
    if eq or idx:
        store.disk_put("kite-instruments", rec)
    return rec


def history(symbol, index_name=None, years=10):
    """Daily candles from Kite as [date, close, volume, open, high, low] rows (the shape market.history keeps), or None when Kite cannot answer (not connected, backing off,
    unknown symbol, no historical-data plan). Never raises. Day candles are limited to 2000 days a request, so ten years is two or three calls."""
    if not active("history"):
        return None
    try:
        ins = _instruments()
        token = ins["IDX"].get(index_name.upper()) if index_name else ins["EQ"].get(symbol)
        if not token:
            return None
        end = datetime.date.fromtimestamp(time.time())
        start = end - datetime.timedelta(days=int(365.25 * years))
        rows, lo = {}, start
        while lo <= end:
            hi = min(lo + datetime.timedelta(days=1900), end)
            data = broker._call("GET", f"/instruments/historical/{token}/day", params={"from": lo.isoformat(), "to": hi.isoformat()}) or {}
            for c in data.get("candles") or []:
                d = str(c[0])[:10]
                rows[d] = [d, c[4], c[5] if len(c) > 5 else None, c[1], c[2], c[3]]
            lo = hi + datetime.timedelta(days=1)
        return [rows[d] for d in sorted(rows)] or None
    except broker.BrokerError as e:
        _fail("history", e)
        return None
