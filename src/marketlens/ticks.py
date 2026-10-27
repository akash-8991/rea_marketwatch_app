"""Intraday price record. NSE's servers keep daily history only, so intraday candles are built from the live prices this app sees while it is open: every fresh
quote adds a tick, ticks are folded into one-minute bars (open, high, low, close, traded volume), and the bars are saved per symbol per day (the last few days
are kept). The chart page resamples the minute bars into 5-minute, 15-minute and hourly candles. Nothing is invented: a minute with no new price has no bar."""
import datetime
import threading
import time

from . import marketclock, store

KEEP_DAYS = 5
FLUSH_EVERY = 15.0
_lock = threading.Lock()
_mem = {}      # (sym, day) -> {"bars": {minute: [o, h, l, c, v]}, "cumvol": last cumulative volume, "ts": last tick timestamp, "dirty": bool, "saved": time}


def _key(sym, day):
    return f"ticks-{sym}-{day.replace('-', '')}"


def _load(sym, day):
    k = (sym, day)
    if k not in _mem:
        saved = store.disk_get(_key(sym, day)) or {}
        _mem[k] = {"bars": {int(m): b for m, b in (saved.get("bars") or {}).items()}, "cumvol": saved.get("cumvol"), "ts": saved.get("ts"), "dirty": False, "saved": time.time()}
    return _mem[k]


def _minute(ts_text, now):
    """The India-time minute (epoch minutes) a quote belongs to: its own timestamp when readable, else the clock."""
    try:
        return int(datetime.datetime.fromisoformat(ts_text.replace(" ", "T")).replace(tzinfo=marketclock._IST).timestamp() // 60)
    except (AttributeError, ValueError):
        return int(now // 60)


def record(sym, price, cumvol, ts_text, now=None):
    """Add one tick. Ignored unless the price is positive and the quote is newer than the last one stored (NSE repeats the same quote for a while)."""
    now = time.time() if now is None else now
    if not price or price <= 0:
        return False
    minute = _minute(ts_text, now)
    day = datetime.datetime.fromtimestamp(minute * 60, marketclock._IST).date().isoformat()
    with _lock:
        d = _load(sym, day)
        if ts_text and d["ts"] and ts_text <= d["ts"] and d["bars"].get(minute, [None] * 4)[3] == price:
            return False
        delta = 0
        if cumvol is not None and d["cumvol"] is not None and cumvol >= d["cumvol"]:
            delta = cumvol - d["cumvol"]
        if cumvol is not None:
            d["cumvol"] = cumvol
        d["ts"] = ts_text or d["ts"]
        b = d["bars"].get(minute)
        if b is None:
            d["bars"][minute] = [price, price, price, price, delta]
        else:
            b[1], b[2], b[3], b[4] = max(b[1], price), min(b[2], price), price, b[4] + delta
        d["dirty"] = True
        if time.time() - d["saved"] >= FLUSH_EVERY:
            _flush(sym, day, d)
    return True


def _flush(sym, day, d):
    store.disk_put(_key(sym, day), {"bars": {str(m): b for m, b in sorted(d["bars"].items())}, "cumvol": d["cumvol"], "ts": d["ts"]})
    d["dirty"], d["saved"] = False, time.time()


def flush_all():
    with _lock:
        for (sym, day), d in _mem.items():
            if d["dirty"]:
                _flush(sym, day, d)


def bars(sym, days=KEEP_DAYS):
    """One-minute bars [[epoch seconds, open, high, low, close, volume], ...] for the last `days` calendar days with data, oldest first."""
    today = datetime.datetime.now(marketclock._IST).date()
    out = []
    with _lock:
        for back in range(days - 1, -1, -1):
            day = (today - datetime.timedelta(days=back)).isoformat()
            if (sym, day) not in _mem and store.disk_age(_key(sym, day)) is None:
                continue
            d = _load(sym, day)
            out.extend([m * 60, *b] for m, b in sorted(d["bars"].items()))
    return out


def prune(sym):
    """Delete saved days older than KEEP_DAYS (called now and then; cheap)."""
    cutoff = (datetime.datetime.now(marketclock._IST).date() - datetime.timedelta(days=KEEP_DAYS + 2)).strftime("%Y%m%d")
    for k in store.disk_keys(f"ticks-{sym}-"):
        if k.rsplit("-", 1)[-1] < cutoff:
            try:
                import os
                os.remove(store._path(k))
            except OSError:
                pass
