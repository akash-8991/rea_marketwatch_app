"""The list of stocks MarketLens knows by name and industry: NSE Indices' "Nifty Total Market" constituents (about 750 stocks).

Where it lives, in order of preference:
  1. the `securities` table in marketlens.db, written by the last successful refresh;
  2. the copy shipped in the package (data/ind_niftytotalmarket_list.csv), which also seeds the table on first use.
Refresh: at most once a week the app downloads the official file (Nifty Indices' site, or NSE's archive as a second source) and, if it
passes validation, replaces the table in one transaction. A failed or invalid download changes nothing. Both URLs are plain public
downloads; the request says what it is and no browser is imitated. Every refresh is written to the audit log.
"""
import csv
import io
import os
import threading
import time
import urllib.request

from . import optiondb
from .config import settings

# NSE's archive first (the file behind NSE's own page, with a Last-Modified header); Nifty Indices' site second: it sometimes answers with a web page
# instead of the file, and its copy has differed from NSE's by a stock, so it is only a fallback.
SOURCES = ["https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv",
           "https://www.niftyindices.com/IndexConstituent/ind_niftytotalmarket_list.csv"]
REFRESH_EVERY = 7 * 24 * 3600
MIN_ROWS = 500
UA = "MarketLens/0.3 (personal app)"
BUNDLED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "ind_niftytotalmarket_list.csv")
SCHEMA = """
CREATE TABLE IF NOT EXISTS securities (symbol TEXT PRIMARY KEY, company TEXT NOT NULL, industry TEXT NOT NULL, series TEXT, isin TEXT);
CREATE TABLE IF NOT EXISTS securities_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
"""

# Shared, mutated in place so `market.SECTOR_MAP` and the rest of the app always see the current list.
SECTOR_MAP = {}     # symbol -> industry
ROWS = {}           # symbol -> {"company", "industry", "series", "isin"}
_lock = threading.Lock()


class ListError(ValueError):
    """The downloaded file is not a usable constituents list."""


def parse(text):
    """Parse and validate the CSV text; returns {symbol: row}. Raises ListError."""
    rows = {}
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    need = {"Company Name", "Industry", "Symbol"}
    if not reader.fieldnames or not need <= {f.strip() for f in reader.fieldnames}:
        raise ListError("missing columns: expected Company Name, Industry, Symbol")
    for r in reader:
        sym, ind, name = (r.get("Symbol") or "").strip(), (r.get("Industry") or "").strip(), (r.get("Company Name") or "").strip()
        if sym and ind and name:
            rows[sym] = {"company": name, "industry": ind, "series": (r.get("Series") or "").strip(), "isin": (r.get("ISIN Code") or "").strip()}
    if len(rows) < MIN_ROWS:
        raise ListError(f"only {len(rows)} stocks; expected at least {MIN_ROWS}")
    return rows


def _install(rows):
    with _lock:
        ROWS.clear(); ROWS.update(rows)
        SECTOR_MAP.clear(); SECTOR_MAP.update({s: r["industry"] for s, r in rows.items()})


def load_bundled():
    with open(BUNDLED, encoding="utf-8") as f:
        _install(parse(f.read()))


load_bundled()   # a working list exists from import time, before any data folder or database is configured


def _db():
    c = optiondb._db()
    c.executescript(SCHEMA)
    return c


def load():
    """Use the saved table if there is one, otherwise seed it from the bundled file."""
    with optiondb._lock:
        c = _db()
        saved = c.execute("SELECT symbol, company, industry, series, isin FROM securities").fetchall()
        if len(saved) >= MIN_ROWS:
            _install({s: {"company": co, "industry": i, "series": se, "isin": isin} for s, co, i, se, isin in saved})
            return "database"
        load_bundled()
        _store(c, ROWS, "bundled with the package")
    return "bundled"


def _store(c, rows, source):
    c.execute("BEGIN")
    try:
        c.execute("DELETE FROM securities")
        c.executemany("INSERT INTO securities VALUES (?,?,?,?,?)", [(s, r["company"], r["industry"], r["series"], r["isin"]) for s, r in rows.items()])
        c.execute("INSERT OR REPLACE INTO securities_meta VALUES ('updated', ?)", (str(int(time.time())),))
        c.execute("INSERT OR REPLACE INTO securities_meta VALUES ('source', ?)", (source,))
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise


def status():
    with optiondb._lock:
        meta = dict(_db().execute("SELECT k, v FROM securities_meta").fetchall())
    return {"count": len(ROWS), "industries": len(set(SECTOR_MAP.values())), "source": meta.get("source"), "updated": int(meta["updated"]) if meta.get("updated") else None}


def due(now=None):
    updated = status()["updated"]
    return updated is None or (now or time.time()) - updated >= REFRESH_EVERY


def fetch_text(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/csv"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(2_000_000).decode("utf-8-sig", "replace")


def refresh(force=False, fetch=fetch_text):
    """Download the official list if it is due. Returns {'changed', 'added', 'removed', 'source'} or {'skipped': reason}. Never raises."""
    if settings.offline:
        return {"skipped": "offline mode"}
    if not force and not due():
        return {"skipped": "checked within the last 7 days"}
    last = None
    for url in SOURCES:
        try:
            new = parse(fetch(url))
        except (OSError, ValueError) as e:   # network errors and ListError
            last = f"{url.split('/')[2]}: {str(e)[:100]}"
            continue
        added, removed = sorted(set(new) - set(ROWS)), sorted(set(ROWS) - set(new))
        moved = [s for s in new if s in ROWS and new[s]["industry"] != ROWS[s]["industry"]]
        with optiondb._lock:
            _store(_db(), new, url.split("/")[2])
        _install(new)
        optiondb.safe_audit("securities_updated", "system", f"{len(new)} stocks from {url.split('/')[2]}: +{len(added)} -{len(removed)} industry changes {len(moved)}", channel="system")
        return {"changed": bool(added or removed or moved), "added": added, "removed": removed, "moved": moved, "source": url.split("/")[2]}
    with optiondb._lock:   # remember that we tried, so a dead link is retried next week, not on every start
        c = _db(); c.execute("INSERT OR REPLACE INTO securities_meta VALUES ('updated', ?)", (str(int(time.time())),))
    optiondb.safe_audit("securities_update_failed", "system", f"kept the saved list: {last}", outcome="error", channel="system")
    return {"skipped": f"download failed ({last})"}


def start_background():
    """Load the saved list and, if it is due, refresh it on a background thread (never blocks start-up)."""
    def run():
        try:
            load()
            refresh()
        except Exception as e:   # the app works with whatever list it has
            optiondb.safe_audit("securities_update_failed", "system", f"{e.__class__.__name__}: {str(e)[:100]}", outcome="error", channel="system")
    threading.Thread(target=run, daemon=True, name="securities").start()


def get(symbol):
    return ROWS.get((symbol or "").upper())


def industry_members(industry):
    return [s for s, r in ROWS.items() if r["industry"] == industry]


def search_names(q, limit=8):
    """Stocks whose company name contains every word of q (case-insensitive); symbols matching are found elsewhere."""
    words = [w for w in (q or "").lower().split() if w]
    if not words or sum(len(w) for w in words) < 3:
        return []
    hits = [(s, r) for s, r in ROWS.items() if all(w in r["company"].lower() for w in words)]
    hits.sort(key=lambda x: (not x[1]["company"].lower().startswith(words[0]), x[1]["company"]))
    return [{"symbol": s, "name": r["company"], "industry": r["industry"]} for s, r in hits[:limit]]
