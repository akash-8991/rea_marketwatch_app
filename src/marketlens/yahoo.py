"""Intraday candles for the chart page. NSE's servers keep daily history only, so 5-minute, 15-minute and hourly candles come from Yahoo Finance's public chart
endpoint (the same provider the news headlines already use), cached for a minute while the market trades. Stocks are `SYMBOL.NS`; a set of NSE indices has a Yahoo
ticker. Prices can lag the exchange by several minutes, and the page says where the candles came from. Nothing is sent but the ticker; offline mode makes no request."""
import json
import re
import time
import urllib.parse
import urllib.request

from . import marketclock, store
from .config import settings

UA = "Mozilla/5.0 (compatible; MarketLens/1.0; personal use)"
MAX_BYTES = 6_000_000
# timeframe -> (Yahoo interval, Yahoo range): the longest history Yahoo keeps for that interval, trimmed to what a chart can use
FRAMES = {"5m": ("5m", "30d"), "15m": ("15m", "60d"), "1h": ("60m", "730d")}
INDEX_TICKERS = {
    "IDX_NIFTY_50": "^NSEI", "IDX_NIFTY_BANK": "^NSEBANK", "IDX_NIFTY_NEXT_50": "^NSMIDCP", "IDX_NIFTY_100": "^CNX100", "IDX_NIFTY_200": "^CNX200", "IDX_NIFTY_500": "^CRSLDX",
    "IDX_NIFTY_MIDCAP_50": "^NSEMDCP50", "IDX_NIFTY_SMALLCAP_100": "^CNXSC", "IDX_NIFTY_IT": "^CNXIT", "IDX_NIFTY_AUTO": "^CNXAUTO", "IDX_NIFTY_FMCG": "^CNXFMCG",
    "IDX_NIFTY_METAL": "^CNXMETAL", "IDX_NIFTY_PHARMA": "^CNXPHARMA", "IDX_NIFTY_REALTY": "^CNXREALTY", "IDX_NIFTY_ENERGY": "^CNXENERGY", "IDX_NIFTY_PSU_BANK": "^CNXPSUBANK",
    "IDX_NIFTY_MEDIA": "^CNXMEDIA", "IDX_NIFTY_FIN_SERVICE": "^CNXFIN", "IDX_NIFTY_INFRASTRUCTURE": "^CNXINFRA", "IDX_NIFTY_PSE": "^CNXPSE", "IDX_INDIA_VIX": "^INDIAVIX",
}
SYMBOL = re.compile(r"^[A-Za-z0-9&_-]{1,24}$")


def ticker(sym):
    """The Yahoo ticker for an NSE symbol or index key, or None when there is none."""
    if sym.startswith("IDX_"):
        return INDEX_TICKERS.get(sym)
    return f"{sym}.NS" if SYMBOL.match(sym) else None


def parse(doc):
    """Candles [[epoch s, open, high, low, close, volume], ...] from a Yahoo chart answer; rows with a missing price are dropped."""
    res = ((doc.get("chart") or {}).get("result") or [None])[0]
    if not res:
        err = (doc.get("chart") or {}).get("error") or {}
        raise RuntimeError(err.get("description") or "no data for this symbol")
    q = ((res.get("indicators") or {}).get("quote") or [{}])[0]
    out = []
    for i, t in enumerate(res.get("timestamp") or []):
        o, h, l, c = (q.get(k, [None] * (i + 1))[i] for k in ("open", "high", "low", "close"))
        if None in (o, h, l, c):
            continue
        v = (q.get("volume") or [0] * (i + 1))[i] or 0
        out.append([int(t), round(o, 2), round(h, 2), round(l, 2), round(c, 2), v])
    return out


def _fetch(tk, interval, rng):
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(tk, safe='')}?interval={interval}&range={rng}&includePrePost=false"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise RuntimeError("answer too large")
    return parse(json.loads(raw.decode("utf-8", "replace")))


def candles(sym, tf):
    """{available, candles, source} for a timeframe ('5m', '15m', '1h'); never raises (the page falls back to what the app recorded)."""
    if tf not in FRAMES:
        return {"sym": sym, "tf": tf, "available": False, "candles": [], "reason": "unknown timeframe"}
    tk = ticker(sym)
    if not tk:
        return {"sym": sym, "tf": tf, "available": False, "candles": [], "reason": "no intraday source for this index"}
    if settings.offline:
        return {"sym": sym, "tf": tf, "available": False, "candles": [], "reason": "offline mode: no requests are made"}
    interval, rng = FRAMES[tf]
    ttl = 60 if marketclock.in_session_hours(time.time()) else 900
    try:
        c = store.cached(f"yc:{sym}:{tf}", ttl, lambda: _fetch(tk, interval, rng))
    except Exception as e:
        return {"sym": sym, "tf": tf, "available": False, "candles": [], "reason": f"Yahoo Finance did not answer: {str(e)[:100]}"}
    return {"sym": sym, "tf": tf, "available": bool(c), "candles": c, "source": f"Yahoo Finance ({tk}); can lag the exchange by a few minutes", **({} if c else {"reason": "no candles returned"})}
