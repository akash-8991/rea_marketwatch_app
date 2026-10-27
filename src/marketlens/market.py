"""NSE market data assembly: universe snapshot, per-stock detail, background extras, symbol search."""
import datetime
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

from . import analysis, marketclock, nse, securities, store, ticks
from .config import settings

SECTOR_MAP = securities.SECTOR_MAP   # symbol -> industry, from NSE's Nifty Total Market list; the same dict is updated in place when the list is refreshed
SECTOR_INDICES = [  # sector-level index performance for the heat map: (industry in the list above, NSE index that tracks it)
    ("Financial Services", "NIFTY FINANCIAL SERVICES"), ("Information Technology", "NIFTY IT"), ("Automobile and Auto Components", "NIFTY AUTO"),
    ("Healthcare", "NIFTY HEALTHCARE INDEX"), ("Fast Moving Consumer Goods", "NIFTY FMCG"), ("Metals & Mining", "NIFTY METAL"),
    ("Oil Gas & Consumable Fuels", "NIFTY OIL & GAS"), ("Power", "NIFTY POWER"), ("Realty", "NIFTY REALTY"),
    ("Media Entertainment & Publication", "NIFTY MEDIA"), ("Consumer Durables", "NIFTY CONSUMER DURABLES"), ("Capital Goods", "NIFTY CAPITAL GOODS"),
    ("Construction Materials", "NIFTY CEMENT"),
]
HEADLINE_INDICES = ["NIFTY 50", "NIFTY BANK", "NIFTY NEXT 50", "NIFTY MIDCAP 100"]
SYMBOL_RE = re.compile(r"^[A-Za-z0-9&_-]{1,24}$")
DIV_RE = re.compile(r"(?:Rs\.?|Re\.?|INR)\s*([0-9]+(?:\.[0-9]+)?)", re.I)


def ttm_dividend(actions, today=None):
    today = today or datetime.date.today()
    total, cutoff = 0.0, (today - datetime.timedelta(days=365)).isoformat()
    for a in actions:
        if a.get("actionType") == "DIVIDEND" and a.get("exDate", "") >= cutoff:
            m = DIV_RE.search(a.get("purpose", ""))
            if m:
                total += float(m.group(1))
    return round(total, 2)


def corp_actions(sym, years=2):
    today = datetime.date.today()
    frm = (today - datetime.timedelta(days=365 * years)).isoformat()
    return nse.bh("get_corporate_actions", {"symbol": sym, "fromDate": frm, "toDate": today.isoformat()}).get("actions", [])


def _opt(fut, default):
    try:
        return fut.result()
    except Exception:
        return default


def build_bootstrap():
    """Quotes for the most-traded stocks plus indices, breadth and VIX. Raises if NSE gives no quotes."""
    ex = ThreadPoolExecutor(max_workers=nse.MAX_WORKERS)
    try:
        f_live = ex.submit(nse.cm, "cm_get_live_indices", {"group": "", "nameFilter": ""})
        f_snap = ex.submit(nse.bh, "get_index_snapshot", {"date": "", "filter": ""})
        f_mood = ex.submit(nse.bh, "get_market_mood", {"date": ""})
        f_breadth = ex.submit(nse.bh, "get_market_breadth", {"date": ""})
        f_top = ex.submit(nse.bh, "get_top_by_volume", {"date": "", "n": settings.universe_size + 60, "sortBy": "value"})
        top = f_top.result()  # required: defines the stock universe
        syms = [s["symbol"] for s in top.get("stocks", []) if s.get("series") == "EQ"][: settings.universe_size]
        f_q = {s: ex.submit(nse.cm, "cm_get_stock_quote", {"symbol": s}) for s in syms}
        live, snap = _opt(f_live, {}), _opt(f_snap, {})
        mood, breadth = _opt(f_mood, {}), _opt(f_breadth, {})
        quotes = {s: (_opt(f_q[s], {}) or {}).get("stock") or {} for s in syms}
    finally:
        ex.shutdown(wait=False)

    live_idx = {}
    for group in (live.get("indices") or {}).values():
        for i in group:
            live_idx[i["indexName"].upper()] = i
    snap_idx = {i["indexName"].upper(): i for i in snap.get("indices", [])}

    stocks = []
    for sym in syms:
        q = quotes[sym]
        if not q.get("lastTradedPrice"):
            continue
        stocks.append({
            "sym": sym, "sector": SECTOR_MAP.get(sym, "Other"), "price": q["lastTradedPrice"], "prev": q.get("preClosePrice"),
            "open": q.get("openPrice"), "high": q.get("highPrice"), "low": q.get("lowPrice"), "volume": q.get("volume"),
            "valueCr": q.get("value"), "hi52": q.get("fiftyTwoWeekHigh"), "lo52": q.get("fiftyTwoWeekLow"),
            "pct30": q.get("perChange30d"), "ts": q.get("latestTimestamp"),
        })
    if not stocks:
        raise RuntimeError("no quotes returned from NSE MCP")

    def idx_row(name):
        n = name.upper()
        lv, sn = live_idx.get(n, {}), snap_idx.get(n, {})
        last = lv.get("last") or sn.get("close")
        prev = lv.get("previousClose") or (last - sn.get("pointsChange", 0) if last else None)
        return {"name": sn.get("indexName") or lv.get("indexName") or name, "last": last, "prev": prev, "pe": sn.get("pe"),
                "pb": sn.get("pb"), "divYield": sn.get("divYield"), "pct": lv.get("percChange", sn.get("pctChange"))}

    sector_idx = []
    for sec, ix in SECTOR_INDICES:
        r = idx_row(ix)
        if r["last"]:
            sector_idx.append({"sector": sec, "index": r["name"], "pct": r["pct"]})
    boot = {
        "asOf": mood.get("date") or breadth.get("date"), "nseTimestamp": live.get("nseTimestamp"),
        "fetchedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "indices": [idx_row(n) for n in HEADLINE_INDICES if n in live_idx or n in snap_idx],
        "valuation": [idx_row(k) for k in snap_idx if snap_idx[k].get("pe")][:120],
        "sectorIndices": sector_idx, "mood": mood, "breadth": breadth, "stocks": stocks,
        "sectorSource": "NSE Nifty Total Market constituents list",
    }
    store.disk_put("bootstrap", boot)
    return boot


# ---------- extras: price history and corporate actions for every tracked stock (background, polite) ----------
_extras = {"state": "idle", "done": 0, "total": 0}
_elock = threading.Lock()


def extras_state():
    return dict(_extras)


def start_extras(syms):
    """Begin the background job unless one is running or the saved result is under 6 hours old."""
    if not syms or not nse.available():
        return False
    age = store.disk_age("extras")
    with _elock:
        if _extras["state"] == "running" or (age is not None and age < 6 * 3600):
            return False
        _extras.update(state="running", done=0, total=len(syms))
    threading.Thread(target=_extras_job, args=(list(syms),), daemon=True).start()
    return True


def _extras_job(syms):
    def one(sym):
        out = {"spark": [], "closes": [], "actions": None}
        try:
            h = nse.bh("get_stock_history", {"symbol": sym, "months": 3, "endDate": ""})
            closes = [r["close"] for r in h.get("data", []) if r.get("close")]
            out["closes"], out["spark"] = closes[-70:], closes[-22:]
        except Exception:
            pass
        try:
            out["actions"] = corp_actions(sym, 3)
        except Exception:
            pass
        _extras["done"] += 1
        return sym, out
    try:
        with ThreadPoolExecutor(max_workers=nse.MAX_WORKERS) as ex:
            data = dict(ex.map(one, syms))
        if any(v["closes"] or v["actions"] is not None for v in data.values()):
            store.disk_put("extras", data)
    finally:
        with _elock:
            _extras["state"] = "idle"


def derive_extras(raw, stocks, boot):
    """Attach technical/fundamental analysis to the raw background data using current prices."""
    ctx = analysis.valuation_context(boot)
    by = {s["sym"]: s for s in stocks}
    out = {}
    for sym, e in (raw or {}).items():
        s = by.get(sym, {})
        price = s.get("price")
        acts = e.get("actions")
        div = ttm_dividend(acts) if acts is not None else None
        tech = analysis.technical_from_history(e.get("closes") or [], price)
        fund = analysis.fundamental(div, price, acts, s.get("sector"), ctx) if acts is not None else None
        out[sym] = {"spark": e.get("spark") or [], "divTtm": div, "tech": tech, "fund": fund}
    return out


# ---------- per-stock detail ----------
def stock_detail(sym):
    ex = ThreadPoolExecutor(max_workers=nse.MAX_WORKERS)
    try:
        fq = ex.submit(nse.cm, "cm_get_stock_quote", {"symbol": sym})
        fh = ex.submit(nse.bh, "get_stock_history", {"symbol": sym, "months": 12, "endDate": ""})
        fr = ex.submit(nse.bh, "get_52_week_high_low", {"symbol": sym})
        fc = ex.submit(corp_actions, sym, 3)
        quote = fq.result().get("stock")
        if not quote:
            raise RuntimeError("symbol not found")
        out = {"sym": sym, "quote": quote}
        try:
            h = fh.result()
            out["history"] = [[r["date"], r["open"], r["high"], r["low"], r["close"], r["volume"]] for r in h.get("data", [])]
            out["historySummary"] = h.get("summary")
        except Exception:
            out["history"] = []
        out["range52"], out["actions"] = _opt(fr, None), _opt(fc, None)
    finally:
        ex.shutdown(wait=False)
    out["divTtm"] = ttm_dividend((out["actions"] or {}) if isinstance(out["actions"], list) else (out["actions"] or {}).get("actions", []))
    store.disk_put("stock-" + sym, out)
    return out


def analyze_detail(d):
    """Technical and fundamental views for a stock-detail payload (computed at serve time)."""
    boot = store.disk_get("bootstrap") or {}
    ctx = analysis.valuation_context(boot)
    sector = SECTOR_MAP.get(d["sym"])
    price = d["quote"].get("lastTradedPrice")
    closes = [r[4] for r in d.get("history", []) if r[4]]
    acts = d.get("actions")
    acts = acts.get("actions") if isinstance(acts, dict) else acts
    tech = analysis.technical_from_history(closes, price) or analysis.technical_snapshot({
        "price": price, "prev": d["quote"].get("preClosePrice"), "hi52": d["quote"].get("fiftyTwoWeekHigh"),
        "lo52": d["quote"].get("fiftyTwoWeekLow"), "pct30": d["quote"].get("perChange30d")})
    fund = analysis.fundamental(d.get("divTtm"), price, acts, sector, ctx) if acts is not None else None
    return {"tech": tech, "fund": fund}


# ---------- search ----------
def known_symbols():
    """Symbols we can look up without NSE: the tracked universe, saved stock pages, and background data."""
    syms = {}
    boot = store.disk_get("bootstrap") or {}
    for s in boot.get("stocks", []):
        syms[s["sym"]] = {"symbol": s["sym"], "last_close": s["price"], "pct_change": round((s["price"] - s["prev"]) / s["prev"] * 100, 2) if s.get("prev") else None, "last_date": boot.get("asOf")}
    for k in store.disk_keys("stock-"):
        syms.setdefault(k[6:], {"symbol": k[6:], "last_close": None, "pct_change": None, "last_date": None})
    for k in (store.disk_get("extras") or {}):
        syms.setdefault(k, {"symbol": k, "last_close": None, "pct_change": None, "last_date": None})
    return syms


def search(q):
    """Local matches first; NSE's symbol search is merged in when reachable. Never discards local matches."""
    raw = (q or "").strip()
    q = raw.upper()
    if not q or not SYMBOL_RE.match(q.replace(" ", "")):
        return {"results": [], "source": "none", "note": ""}
    local = [v for k, v in known_symbols().items() if q in k]
    local.sort(key=lambda v: (not v["symbol"].startswith(q), v["symbol"]))
    results = [dict(v, source="local") for v in local[:10]]
    seen_names = {r["symbol"] for r in results}
    results += [dict(symbol=h["symbol"], name=h["name"], last_close=None, pct_change=None, last_date=None, source="list") for h in securities.search_names(raw) if h["symbol"] not in seen_names][:6]
    note = ""
    if nse.available():
        try:
            fut = _quote_pool.submit(store.cached, "search:" + q, 600, lambda: nse.bh("search_symbols", {"query": q}))
            try:
                remote = fut.result(timeout=SEARCH_DEADLINE)     # after the deadline the NSE call still finishes and is cached for the next keystroke
            except FutureTimeout:
                raise RuntimeError("NSE search is slow")
            seen = {r["symbol"] for r in results}
            results += [dict(r, source="nse") for r in remote.get("results", []) if r["symbol"] not in seen][:12]
        except Exception as e:
            note = "NSE search is unavailable right now; showing matches from saved data."
    else:
        note = "NSE search is paused" + (" (offline mode)" if settings.offline else f" (retry in about {max(1, nse.retry_in_seconds() // 60)} min)") + "; showing matches from saved data."
    return {"results": results, "source": "nse+local" if note == "" else "local", "note": note}


# ---------- peers: other stocks of the same industry (from the Nifty Total Market list) ----------
def _rank_industry(members):
    """Members of one industry ordered by last session's traded value (close x volume) from NSE's bulk quote: three calls at most."""
    quotes = []
    for i in range(0, len(members), 50):
        quotes += nse.bh("get_bulk_quote", {"symbols": members[i:i + 50]}).get("quotes", [])
    quotes = [q for q in quotes if q.get("close") and q.get("volume")]
    quotes.sort(key=lambda q: q["close"] * q["volume"], reverse=True)
    return [q["symbol"] for q in quotes]


def _live_row(sym):
    q = (store.cached("lq:" + sym, 60, lambda: nse.cm("cm_get_stock_quote", {"symbol": sym})) or {}).get("stock") or {}
    price, prev = q.get("lastTradedPrice"), q.get("preClosePrice")
    chg = q.get("perChange") if q.get("perChange") is not None else (round((price - prev) / prev * 100, 2) if price and prev else None)
    return {"price": price, "prev": prev, "chg": chg, "volume": q.get("volume"), "valueCr": q.get("value"), "ts": q.get("latestTimestamp")}


def peers(sym, limit=10):
    """Peer comparison for one stock: the same industry's most-traded stocks with price, change, volume and turnover. Prices are NSE's
    live quotes (the last close when the market is shut). If NSE cannot be reached the names still show, with saved prices where we have them."""
    row = securities.get(sym)
    if not row:
        return {"sym": sym, "company": None, "industry": None, "count": 0, "peers": [], "self": None}
    members = securities.industry_members(row["industry"])
    out = {"sym": sym, "company": row["company"], "industry": row["industry"], "count": len(members), "peers": [], "self": None, "stale": False}
    try:
        ranked = store.cached("peers-rank:" + row["industry"], 1800, lambda: _rank_industry(members))
    except Exception:
        ranked = [m for m in sorted(members)]
        out["stale"] = True
    top = [m for m in ranked if m != sym][:limit]
    saved = {x["sym"]: x for x in (store.disk_get("bootstrap") or {}).get("stocks", [])}

    def one(s):
        try:
            r = _live_row(s)
        except Exception:
            x = saved.get(s) or {}
            out["stale"] = True
            r = {"price": x.get("price"), "prev": x.get("prev"), "chg": round((x["price"] - x["prev"]) / x["prev"] * 100, 2) if x.get("price") and x.get("prev") else None,
                 "volume": x.get("volume"), "valueCr": x.get("valueCr"), "ts": x.get("ts")}
        meta = securities.get(s) or {}
        return dict(r, sym=s, name=meta.get("company", s))
    with ThreadPoolExecutor(max_workers=nse.MAX_WORKERS) as ex:
        rows = list(ex.map(one, top + [sym]))
    out["peers"], out["self"] = rows[:-1], rows[-1]
    out["rank"] = (ranked.index(sym) + 1) if sym in ranked else None
    return out


# ---------- lean quotes (one NSE call each, coalesced and cached) ----------
RANGE_DAYS = {"1W": 7, "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "5Y": 1830, "10Y": 3660}


LIVE_TTL = 1.0        # seconds a live quote may be reused while the market trades: the feed asks again every second
LIVE_BUDGET = 10.0    # at most this many NSE stock-quote calls per second in total; with more symbols on screen each one is refreshed proportionally less often
_active = {}          # symbol -> last time a client asked for it (the symbols that count against the budget)


def quote_ttl(sym=None):
    if not marketclock.in_session_hours(time.time()):
        return 900                                            # the market is shut: nothing changes
    now = time.time()
    if sym:
        _active[sym] = now
    for k in [k for k, t in _active.items() if now - t > 5]:
        _active.pop(k, None)
    return max(LIVE_TTL, len(_active) / LIVE_BUDGET)          # one symbol per second at most per budget slot: a fair rotation


_fresh_at = {}
QUOTE_DEADLINE = 6.0
SEARCH_DEADLINE = 0.45
_quote_pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="quote")
FRESH_GUARD = 5.0   # "refresh now" may bypass the cache at most once per symbol per 5 s: a button mashed or a script cannot hammer NSE


def quote(sym, state=None, fresh=False):
    """One quote in the shape the UI needs, with an honest status: live, delayed, closed (market shut, last close), stale (saved copy because
    NSE could not be reached) or unavailable. Concurrent callers for the same symbol share one NSE request."""
    t0 = time.time()
    key, stale, error, q = "lq:" + sym, False, None, None
    if fresh and time.time() - _fresh_at.get(sym, 0) >= FRESH_GUARD:
        _fresh_at[sym] = time.time()
        store.forget(key)
    try:
        fut = _quote_pool.submit(store.cached, key, quote_ttl(sym), lambda: nse.cm("cm_get_stock_quote", {"symbol": sym}))
        try:
            q = (fut.result(timeout=QUOTE_DEADLINE) or {}).get("stock")     # if NSE has not replied by then the saved copy is used; the request still finishes and fills the cache
        except FutureTimeout:
            raise RuntimeError(f"NSE did not answer within {QUOTE_DEADLINE:g} s")
    except Exception as e:
        error = str(e)[:120]
        saved = {x["sym"]: x for x in (store.disk_get("bootstrap") or {}).get("stocks", [])}.get(sym)
        if saved:
            stale = True
            q = {"lastTradedPrice": saved.get("price"), "preClosePrice": saved.get("prev"), "volume": saved.get("volume"), "latestTimestamp": saved.get("ts")}
    row = securities.get(sym) or {}
    if not q or not q.get("lastTradedPrice"):
        return {"sym": sym, "name": row.get("company"), "status": "unavailable", "reason": error or "NSE has no quote for this symbol", "exchange": "NSE", "fetchedAt": int(time.time() * 1000)}
    price, prev = q["lastTradedPrice"], q.get("preClosePrice")
    if not stale and marketclock.in_session_hours(time.time()):
        ticks.record(sym, price, q.get("volume"), q.get("latestTimestamp"))   # builds the intraday candles
    abs_ = round(price - prev, 2) if prev is not None else None
    chg = q["perChange"] if q.get("perChange") is not None else (round((price - prev) / prev * 100, 2) if prev else None)
    ts = q.get("latestTimestamp")
    age_ms = None
    if ts:
        try:
            age_ms = max(0, int((time.time() - datetime.datetime.fromisoformat(ts.replace(" ", "T")).replace(tzinfo=marketclock._IST).timestamp()) * 1000))
        except ValueError:
            pass
    state = state or marketclock.market_state(time.time())
    status = "stale" if stale else ("delayed" if state["live"] and age_ms is not None and age_ms > 300000 else "live") if state["live"] else "closed"
    out = {"sym": sym, "name": row.get("company"), "industry": row.get("industry"), "exchange": "NSE", "price": price, "prev": prev, "abs": abs_, "chg": chg,
           "open": q.get("openPrice"), "high": q.get("highPrice"), "low": q.get("lowPrice"), "volume": q.get("volume"), "valueCr": q.get("value"), "hi52": q.get("fiftyTwoWeekHigh"), "lo52": q.get("fiftyTwoWeekLow"), "ts": ts, "ageMs": age_ms,
           "status": status, "fetchedAt": int(time.time() * 1000), "ms": round((time.time() - t0) * 1000)}
    if stale:
        out["reason"] = error
    return out


def quotes(symbols, state=None, fresh=False):
    """Many quotes at once (at most 50 distinct valid symbols), fetched in parallel; order kept."""
    seen, listed = set(), []
    for raw in symbols:
        sym = (raw or "").strip().upper()
        if sym and sym not in seen:
            seen.add(sym)
            listed.append(sym)
    state = state or marketclock.market_state(time.time())
    for sym in listed[:50]:
        if SYMBOL_RE.match(sym):
            _active[sym] = time.time()   # count them all before any is fetched, so the rotation is even

    def one(sym):
        if not SYMBOL_RE.match(sym):
            return {"sym": sym, "status": "unavailable", "reason": "not a valid NSE symbol", "exchange": "NSE", "fetchedAt": int(time.time() * 1000)}
        return quote(sym, state, fresh)
    with ThreadPoolExecutor(max_workers=max(2, nse.MAX_WORKERS * 2)) as ex:
        out = list(ex.map(one, listed[:50]))
    return {"quotes": out, "requested": len(listed), "truncated": len(listed) > 50, "fetchedAt": int(time.time() * 1000)}


# ---------- history for the chart (daily closes; NSE keeps them from 1 Jan 2024) ----------
INDEX_PREFIX = "IDX_"


def index_key(name):
    """The symbol-shaped key the chart page uses for an index: 'NIFTY 50' -> 'IDX_NIFTY_50'."""
    return INDEX_PREFIX + re.sub(r"[^A-Z0-9]+", "_", str(name).upper()).strip("_")


def index_name(key):
    """Back from the key to NSE's index name, using the live list when it is available (names can hold characters a key cannot)."""
    try:
        for n in _live_indices():
            if index_key(n) == key:
                return n
    except Exception:
        pass
    return key[len(INDEX_PREFIX):].replace("_", " ")


def history(sym, rng):
    """Daily closes for a range. NSE returns at most three months per call and the next call needs the previous one's next_end_date, so chunks are
    fetched one after another and saved: later ranges, and the next visit, cost nothing."""
    days = RANGE_DAYS.get(rng)
    if not days:
        return {"sym": sym, "range": rng, "available": False,
                "reason": "NSE’s servers provide daily data only, so there is no intraday chart." if rng == "1D" else "unknown range"}
    key = "hist-" + sym
    is_index = sym.startswith(INDEX_PREFIX)
    cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    rec = store.disk_get(key)
    age = store.disk_age(key)
    if rec and (age is None or age > 12 * 3600):
        rec = None
    if rec and rec["points"] and len(rec["points"][0]) < 6:
        rec = None                                            # saved by an older release without open, high and low: fetch again
    covers = lambda r: r and (r["complete"] or (r["points"] and r["points"][0][0] <= cutoff))
    if not covers(rec):
        points = list(rec["points"]) if rec else []
        end = (rec or {}).get("next") or ""
        nxt, complete, guard = (rec or {}).get("next"), False, 0
        while not complete and guard < 16 and (not points or points[0][0] > cutoff):
            guard += 1
            if is_index:   # indices: up to 12 months a call, same chaining; the volume is the index's traded volume when NSE publishes one
                h = nse.bh("get_index_history", {"indexName": index_name(sym), "months": 12, "endDate": end})
                data = h.get("data") or h.get("history") or h.get("rows") or []
            else:
                h = nse.bh("get_stock_history", {"symbol": sym, "months": 3, "endDate": end})
                data = h.get("data", [])
            rows = [[r["date"], r["close"], r.get("volume"), r.get("open"), r.get("high"), r.get("low")] for r in data if r.get("close") and r.get("date")]
            if not rows:
                complete = True
                break
            points = rows + points
            nxt = h.get("next_end_date")
            if not nxt:
                complete = True
                break
            end = nxt
        seen, uniq = set(), []
        for p in sorted(points, key=lambda x: x[0]):
            if p[0] not in seen:
                seen.add(p[0])
                uniq.append(p)
        rec = {"points": uniq, "complete": complete, "next": nxt}
        store.disk_put(key, rec)
    pts = [p for p in rec["points"] if p[0] >= cutoff]
    earliest = rec["points"][0][0] if rec["points"] else None
    truncated = bool(earliest and earliest > cutoff and rec["complete"])
    out = {"sym": sym, "range": rng, "available": bool(pts), "points": pts, "from": pts[0][0] if pts else None, "to": pts[-1][0] if pts else None,
           "earliest": earliest, "truncated": truncated}
    if truncated:
        out["note"] = f"NSE’s history starts on {earliest}; showing all of it."
    if not pts:
        out["reason"] = "no price history returned for this symbol"
    return out


# ---------- the fast live feed: indices, sector indices and the symbols on screen, answered from a one-second cache ----------
def _live_indices():
    ttl = LIVE_TTL if marketclock.in_session_hours(time.time()) else 600
    live = store.cached("live:indices", ttl, lambda: nse.cm("cm_get_live_indices", {"group": "", "nameFilter": ""}))
    by = {}
    for group in (live.get("indices") or {}).values():
        for i in group:
            by[i["indexName"].upper()] = i
    return by


def live_feed(symbols):
    """Everything the screens repaint every second: headline indices, sector tiles and the requested stocks (at most 40). Failures degrade to what is cached."""
    t = time.time()
    state = marketclock.market_state(t)
    out = {"t": int(t * 1000), "market": state, "intervalMs": 1000 if state["live"] else 30000, "indices": [], "sectorIndices": [], "quotes": []}
    try:
        by = _live_indices()
        row = lambda lv, name: {"name": lv.get("indexName") or name, "last": lv.get("last"), "prev": lv.get("previousClose"), "pct": lv.get("percChange")}
        out["indices"] = [row(by[n], n) for n in HEADLINE_INDICES if n in by]
        for sec, ix in SECTOR_INDICES:
            lv = by.get(ix.upper())
            if lv and lv.get("last"):
                out["sectorIndices"].append({"sector": sec, "index": lv.get("indexName") or ix, "pct": lv.get("percChange")})
    except Exception as e:
        out["indicesError"] = str(e)[:120]
    listed, wanted = [], []
    for raw in symbols[:40]:
        sym = (raw or "").strip().upper()
        if SYMBOL_RE.match(sym) and sym not in listed and sym not in wanted:
            (wanted if sym.startswith(INDEX_PREFIX) else listed).append(sym)
    try:   # indices on screen (the chart page) come back as quotes under their IDX_ key; the headline and sector indices are recorded for intraday charts
        by = _live_indices()
        keyed = {index_key(n): lv for n, lv in by.items()}
        in_session = marketclock.in_session_hours(t)
        for key in wanted:
            lv = keyed.get(key)
            if lv and lv.get("last"):
                out["quotes"].append({"sym": key, "price": lv["last"], "prev": lv.get("previousClose"), "abs": lv.get("change"), "chg": lv.get("percChange"), "open": lv.get("open"),
                                      "high": lv.get("high"), "low": lv.get("low"), "volume": None, "valueCr": None, "ts": lv.get("timeVal"), "ageMs": None, "status": "live" if state["live"] else "closed", "hi52": None, "lo52": None})
        if in_session:
            for n in HEADLINE_INDICES + [ix for _, ix in SECTOR_INDICES]:
                lv = by.get(n.upper())
                if lv and lv.get("last"):
                    ticks.record(index_key(n), lv["last"], None, None)
            for key in wanted:
                lv = keyed.get(key)
                if lv and lv.get("last"):
                    ticks.record(key, lv["last"], None, None)
    except Exception:
        pass
    if listed:
        for q in quotes(listed, state)["quotes"]:
            out["quotes"].append({k: q.get(k) for k in ("sym", "price", "prev", "abs", "chg", "open", "high", "low", "volume", "valueCr", "ts", "ageMs", "status", "hi52", "lo52")})
    return out


def intraday(sym):
    """One-minute bars recorded from live quotes (see ticks.py). The chart page resamples them to 5m, 15m and 1h."""
    ticks.flush_all()
    b = ticks.bars(sym)
    return {"sym": sym, "bars": b, "from": b[0][0] if b else None, "to": b[-1][0] if b else None,
            "source": "recorded from live NSE quotes while MarketLens was open; NSE's servers keep daily history only"}
