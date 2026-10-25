"""Live headlines from Yahoo Finance and Google News RSS, split into India and global markets.

Only headline, source, time and link are kept (the page links out to the publisher). Google Finance has no
public feed; Google News RSS is the public feed that Google Finance's news section draws from.
"""
import datetime
import email.utils
import re
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

from . import analysis, store
from .config import settings

UA = "Mozilla/5.0 (compatible; MarketLens/1.0; local personal use)"
MAX_BYTES = 3_000_000
YAHOO = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={s}&region={region}&lang={lang}"
GOOGLE = "https://news.google.com/rss/search?q={q}&hl={hl}&gl={gl}&ceid={ceid}"

REGIONS = {
    "india": {
        "yahoo": [("^NSEI", "IN", "en-IN"), ("^BSESN", "IN", "en-IN")],
        "google": [("Sensex Nifty stocks", "en-IN", "IN", "IN:en"), ("NSE BSE India stock market", "en-IN", "IN", "IN:en")],
    },
    "global": {
        "yahoo": [("^GSPC,^DJI,^IXIC", "US", "en-US"), ("^FTSE,^N225,^HSI", "US", "en-US")],
        "google": [("Wall Street stocks", "en-US", "US", "US:en"), ("global stock markets Fed ECB", "en-US", "US", "US:en")],
    },
}


class FeedError(RuntimeError):
    pass


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(MAX_BYTES + 1)
    except OSError as e:
        raise FeedError(str(e))
    if len(raw) > MAX_BYTES:
        raise FeedError("feed too large")
    return raw.decode("utf-8", "replace")


def _safe_link(link):
    u = urllib.parse.urlparse((link or "").strip())
    return u.geturl() if u.scheme in ("http", "https") and u.netloc else ""


def _ts(pub):
    try:
        return email.utils.parsedate_to_datetime(pub).timestamp()
    except (TypeError, ValueError, IndexError):
        return 0.0


def parse_rss(text, kind):
    """Parse an RSS document. `kind` is 'yahoo' or 'google'. Refuses documents that declare entities."""
    if re.search(r"<!DOCTYPE|<!ENTITY", text, re.I):
        raise FeedError("feed rejected: contains a DOCTYPE/ENTITY declaration")
    try:
        root = ET.fromstring(text)
    except ET.ParseError as e:
        raise FeedError(f"bad XML: {e}")
    items = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = _safe_link(it.findtext("link"))
        if not title or not link:
            continue
        source = "Yahoo Finance"
        if kind == "google":
            src = it.find("source")
            source = (src.text or "").strip() if src is not None and src.text else "Google News"
            suffix = f" - {source}"
            if title.endswith(suffix):
                title = title[: -len(suffix)].strip()
            elif " - " in title:
                title, _, source = title.rpartition(" - ")
        ts = _ts(it.findtext("pubDate"))
        items.append({"title": title, "link": link, "source": source.strip() or "News", "provider": kind, "ts": ts,
                      "published": datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat(timespec="minutes") if ts else None})
    return items


def _norm(title):
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()[:90]


def merge(lists, limit=60, min_each=0):
    """Dedupe by title, newest first. `min_each` keeps at least that many of each provider's newest items
    so a source whose feed is older (Yahoo's India feed, for example) is not crowded out by the other."""
    seen, ordered = set(), []
    for it in sorted((i for lst in lists for i in lst), key=lambda i: i["ts"], reverse=True):
        k = _norm(it["title"])
        if k and k not in seen:
            seen.add(k)
            ordered.append(it)
    keep = ordered[:limit]
    if min_each:
        have = {id(i) for i in keep}
        for provider in {i["provider"] for i in ordered}:
            own = [i for i in ordered if i["provider"] == provider]
            for it in own[:min_each]:
                if id(it) not in have:
                    keep.append(it)
                    have.add(id(it))
        keep.sort(key=lambda i: i["ts"], reverse=True)
    return keep


def _gather(urls):
    lists, errors = [], []
    for url, kind in urls:
        try:
            lists.append(parse_rss(fetch(url), kind))
        except FeedError as e:
            errors.append(f"{kind}: {e}")
        time.sleep(0.2)
    return lists, errors


def _region_urls(name):
    cfg = REGIONS[name]
    urls = [(YAHOO.format(s=urllib.parse.quote(s), region=r, lang=l), "yahoo") for s, r, l in cfg["yahoo"]]
    urls += [(GOOGLE.format(q=urllib.parse.quote_plus(q), hl=hl, gl=gl, ceid=ceid), "google") for q, hl, gl, ceid in cfg["google"]]
    return urls


def region_news(name):
    """Headlines for 'india' or 'global'. Cached 5 minutes, falls back to the last saved copy."""
    if name not in REGIONS:
        raise KeyError(name)
    if not settings.news:
        return {"region": name, "items": [], "disabled": True}

    def build():
        lists, errors = _gather(_region_urls(name))
        if not any(lists):
            raise FeedError("; ".join(errors) or "no headlines returned")
        items = merge(lists, 60, min_each=15)
        for it in items:
            it["sentiment"] = analysis.headline_score(it["title"])[0]
        out = {"region": name, "items": items, "fetchedAt": datetime.datetime.now().isoformat(timespec="seconds"), "errors": errors}
        store.disk_put("news-" + name, out)
        return out

    try:
        return dict(store.cached("news:" + name, 300, build), stale=False)
    except Exception as e:
        snap = store.disk_get("news-" + name)
        if snap:
            return dict(snap, stale=True, staleReason=str(e)[:160])
        raise


def stock_news(sym, limit=12):
    """Headlines about one NSE symbol from Yahoo (SYM.NS) and Google News."""
    if not settings.news:
        return {"sym": sym, "items": [], "disabled": True}
    urls = [(YAHOO.format(s=urllib.parse.quote(sym + ".NS"), region="IN", lang="en-IN"), "yahoo"),
            (GOOGLE.format(q=urllib.parse.quote_plus(f'"{sym}" NSE share'), hl="en-IN", gl="IN", ceid="IN:en"), "google")]

    def build():
        lists, errors = _gather(urls)
        if not any(lists):
            raise FeedError("; ".join(errors) or "no headlines returned")
        items = merge(lists, limit)
        return {"sym": sym, "items": items, "sentiment": analysis.sentiment([i["title"] for i in items]),
                "fetchedAt": datetime.datetime.now().isoformat(timespec="seconds")}

    return store.cached("snews:" + sym, 1800, build)


# ---------- background sentiment for the screener (polite: one stock at a time) ----------
_job = {"state": "idle", "done": 0, "total": 0, "data": {}}
_job_lock = threading.Lock()


def sentiment_status(symbols):
    """Return saved sentiment and start a background refresh when it is missing or older than 3 hours."""
    if not settings.news:
        return {"ready": False, "disabled": True, "data": {}}
    saved = store.disk_get("sentiment")
    age = store.disk_age("sentiment")
    with _job_lock:
        fresh = saved is not None and age is not None and age < 3 * 3600
        if not fresh and _job["state"] != "running" and symbols:
            _job.update(state="running", done=0, total=len(symbols))
            threading.Thread(target=_run_job, args=(list(symbols),), daemon=True).start()
        if saved:
            return {"ready": True, "refreshing": _job["state"] == "running", "done": _job["done"], "total": _job["total"], "data": saved}
        return {"ready": False, "refreshing": _job["state"] == "running", "done": _job["done"], "total": _job["total"], "data": {}}


def _run_job(symbols):
    data = {}
    for sym in symbols:
        try:
            r = stock_news(sym, analysis.RULES["sentMaxHeadlines"])
            data[sym] = dict(r["sentiment"], top=[{"title": i["title"], "link": i["link"], "source": i["source"]} for i in r["items"][:3]])
        except Exception:
            data[sym] = {"score": None, "label": "No news", "n": 0, "pos": 0, "neg": 0, "top": []}
        _job["done"] += 1
        time.sleep(0.6)
    if any(v["n"] for v in data.values()):
        store.disk_put("sentiment", data)
    with _job_lock:
        _job["state"] = "idle"
