"""Background refresh every `option_interval` seconds (default 150 = 2.5 minutes).

Each tick (1) ingests CSV files a person has downloaded from NSE's option-chain page into the inbox folder, and
(2) when an HTTP MCP endpoint is configured, fetches the chain for `option_symbols` from it. It never contacts
nseindia.com or drives a browser.
"""
import hashlib
import os
import threading
import time

from . import optiondb, options
from .config import inbox_dir, settings

SETTLE_SECONDS = 2  # ignore files still being written
_state = {"last": None, "next": None, "result": "not run yet", "thread": None}
_stop = threading.Event()
_run_lock = threading.Lock()


def _move(path, sub):
    dest_dir = os.path.join(os.path.dirname(path), sub)
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, os.path.basename(path))
    if os.path.exists(dest):
        dest = f"{dest}.{int(time.time())}"
    os.replace(path, dest)


def ingest_inbox():
    """Import new *.csv files from the inbox. Returns counts. Handled files move to processed/ or rejected/."""
    inbox = str(inbox_dir())
    os.makedirs(inbox, exist_ok=True)
    counts = {"stored": 0, "duplicate": 0, "rejected": 0}
    for name in sorted(os.listdir(inbox)):
        path = os.path.join(inbox, name)
        if not name.lower().endswith(".csv") or not os.path.isfile(path) or os.path.islink(path):
            continue
        if time.time() - os.path.getmtime(path) < SETTLE_SECONDS:
            continue
        try:
            if os.path.getsize(path) > optiondb.MAX_CSV_BYTES:
                raise optiondb.CsvError("file is larger than 2 MB")
            with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
                text = f.read()
            res = optiondb.import_csv(text, "inbox", filename=name)
            counts["duplicate" if res["status"] == "duplicate" else "stored"] += 1
            _move(path, "processed")
        except optiondb.CsvError:
            counts["rejected"] += 1  # import_csv already audit-logged the reason
            _move(path, "rejected")
        except OSError as e:
            optiondb.audit("import_rejected", "inbox", f"{name[:80]}: could not read file ({e.__class__.__name__})")
            counts["rejected"] += 1
    return counts


def fetch_configured():
    """Pull the configured symbols from the HTTP MCP endpoint into the database. Returns counts."""
    counts = {"stored": 0, "duplicate": 0, "failed": 0}
    if not settings.fo_url:
        return counts
    for sym in settings.option_symbols:
        try:
            chain = options.fetch_live(sym, "")
            expiry = chain.get("expiry") or (chain["expiries"][0] if chain.get("expiries") else "")
            if not chain["rows"] or not expiry:
                raise RuntimeError("endpoint returned no strikes or no expiry")
            res = optiondb.store({"symbol": sym, "expiry": expiry, "spot": chain.get("spot"), "rows": chain["rows"]}, "mcp:" + settings.fo_url[:60], "scheduler")
            counts["duplicate" if res["status"] == "duplicate" else "stored"] += 1
        except Exception as e:
            counts["failed"] += 1
            optiondb.audit("fetch_failed", "scheduler", f"{sym}: {str(e)[:200]}", sym)
    return counts


def tick():
    if not _run_lock.acquire(blocking=False):
        return _state["result"]
    try:
        a, b = ingest_inbox(), fetch_configured()
        _state["result"] = f"inbox {a}; endpoint {b}" if settings.fo_url else f"inbox {a}"
        if a["stored"] or a["duplicate"] or a["rejected"] or b["stored"] or b["failed"]:
            optiondb.audit("scan", "scheduler", _state["result"])  # idle scans are not logged: they would only add noise
        _state["last"] = time.time()
        return _state["result"]
    except Exception as e:  # never let the loop die
        _state["result"] = f"error: {str(e)[:160]}"
        return _state["result"]
    finally:
        _run_lock.release()


def _loop():
    while not _stop.is_set():
        tick()
        _state["next"] = time.time() + settings.option_interval
        if _stop.wait(settings.option_interval):
            break


def start():
    if settings.option_interval <= 0 or (_state["thread"] and _state["thread"].is_alive()):
        return False
    _stop.clear()
    t = threading.Thread(target=_loop, name="option-scheduler", daemon=True)
    _state["thread"] = t
    t.start()
    return True


def stop():
    _stop.set()
    t = _state["thread"]
    if t:
        t.join(timeout=5)
    _state["thread"] = None


def status():
    return {"intervalSeconds": settings.option_interval, "inbox": str(inbox_dir()), "lastRun": _state["last"], "nextRun": _state["next"],
            "lastResult": _state["result"], "endpointConfigured": bool(settings.fo_url), "running": bool(_state["thread"] and _state["thread"].is_alive())}
