"""NSE market data assembly: universe snapshot, per-stock detail, background extras, symbol search."""
import datetime
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from . import analysis, nse, securities, store
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
            remote = store.cached("search:" + q, 600, lambda: nse.bh("search_symbols", {"query": q}))
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
