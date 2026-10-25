"""Option chain via an NSE derivatives MCP endpoint (configure with --fo-mcp-url or NSE_FO_MCP_URL).

The two NSE MCP servers MarketLens uses by default are cash-market only and expose no option, futures or
derivatives tools, so there is no built-in data source. When an endpoint is configured, the adapter lists its
tools, finds one named like "option chain", maps the arguments from the tool's input schema, and normalises
common response layouts (NSE's own records.data[].CE/PE layout, or flat per-contract rows). The normaliser is
tested against synthetic fixtures; it has not been run against a real NSE derivatives MCP.
"""
import re

from . import nse, optiondb, store
from .config import settings

SYMBOL_KEYS = ("symbol", "underlying", "underlyingSymbol", "index", "indexName", "instrument", "name", "ticker")
EXPIRY_KEYS = ("expiry", "expiryDate", "expiry_date", "expiryDt")
ALIASES = {
    "oi": ("openInterest", "open_interest", "oi", "OI"), "chgOi": ("changeinOpenInterest", "changeInOpenInterest", "change_in_oi", "oiChange", "chgOI", "changeOi"),
    "vol": ("totalTradedVolume", "volume", "vol", "tradedVolume"), "iv": ("impliedVolatility", "iv", "IV"),
    "ltp": ("lastPrice", "ltp", "last_price", "lastTradedPrice"), "chg": ("change", "netChange", "chg"),
    "bid": ("bidprice", "bidPrice", "bid"), "ask": ("askPrice", "askprice", "ask"),
}


def _pick(d, names):
    for n in names:
        if isinstance(d, dict) and d.get(n) is not None:
            return d[n]
    return None


def _leg(d):
    if not isinstance(d, dict):
        return None
    return {k: _pick(d, names) for k, names in ALIASES.items()}


def normalize(payload):
    """Return {'spot','expiries','rows':[{'strike','ce','pe'}],'summary'} from a tolerant set of layouts."""
    rec = payload.get("records", payload) if isinstance(payload, dict) else {}
    data = rec.get("data") if isinstance(rec, dict) else None
    if data is None and isinstance(payload, dict):
        data = payload.get("rows") or payload.get("chain") or payload.get("optionChain")
    if data is None and isinstance(payload, list):
        data = payload
    rows = {}
    for r in data or []:
        if not isinstance(r, dict):
            continue
        strike = _pick(r, ("strikePrice", "strike", "strike_price"))
        if strike is None:
            continue
        row = rows.setdefault(float(strike), {"strike": float(strike), "ce": None, "pe": None})
        if "CE" in r or "PE" in r:  # NSE layout: one row per strike with CE and PE objects
            row["ce"] = _leg(r.get("CE")) or row["ce"]
            row["pe"] = _leg(r.get("PE")) or row["pe"]
        else:  # flat layout: one row per contract with an option-type field
            kind = str(_pick(r, ("optionType", "option_type", "type", "right")) or "").upper()
            if kind.startswith("C"):
                row["ce"] = _leg(r)
            elif kind.startswith("P"):
                row["pe"] = _leg(r)
    ordered = [rows[k] for k in sorted(rows)]
    spot = _pick(rec if isinstance(rec, dict) else {}, ("underlyingValue", "spot", "underlying", "underlyingPrice"))
    if spot is None and isinstance(payload, dict):
        spot = _pick(payload, ("underlyingValue", "spot", "underlying", "underlyingPrice"))
    expiries = (rec.get("expiryDates") if isinstance(rec, dict) else None) or (payload.get("expiryDates") if isinstance(payload, dict) else None) or []
    return {"spot": spot, "expiries": expiries, "rows": ordered, "summary": summarize(ordered, spot)}


def summarize(rows, spot):
    if not rows:
        return {"pcr": None, "maxPain": None, "atm": None, "ceOi": 0, "peOi": 0}
    ce = sum((r["ce"] or {}).get("oi") or 0 for r in rows)
    pe = sum((r["pe"] or {}).get("oi") or 0 for r in rows)
    strikes = [r["strike"] for r in rows]

    def pain(k):  # total payout to option buyers if the underlying settled at k
        return sum(((r["ce"] or {}).get("oi") or 0) * max(0.0, k - r["strike"]) + ((r["pe"] or {}).get("oi") or 0) * max(0.0, r["strike"] - k) for r in rows)
    max_pain = min(strikes, key=pain) if (ce or pe) else None
    atm = min(strikes, key=lambda s: abs(s - spot)) if spot else None
    return {"pcr": round(pe / ce, 3) if ce else None, "maxPain": max_pain, "atm": atm, "ceOi": ce, "peOi": pe}


def status():
    if not settings.fo_url:
        return {"configured": False, "reason": ("No derivatives MCP endpoint is configured. The NSE servers used by default (cash market and bhavcopy) "
                                                  "have no option-chain tool. Start MarketLens with --fo-mcp-url <endpoint> or set NSE_FO_MCP_URL.")}
    return {"configured": True, "url": settings.fo_url}


def _find_tool():
    res = nse.rpc(settings.fo_url, "tools/list")
    for t in res.get("tools", []):
        if re.search(r"option[_ -]?chain", t["name"], re.I):
            return t
    raise RuntimeError("the configured endpoint has no tool named like 'option chain': " + ", ".join(t["name"] for t in res.get("tools", []))[:200])


def _args(tool, symbol, expiry):
    props = (tool.get("inputSchema") or {}).get("properties", {})
    args = {}
    for name in props:
        if name in SYMBOL_KEYS and not any(k in args for k in SYMBOL_KEYS):
            args[name] = symbol
        elif name in EXPIRY_KEYS and expiry:
            args[name] = expiry
    for name in (tool.get("inputSchema") or {}).get("required", []):
        if name not in args:
            typ = (props.get(name) or {}).get("type")
            args[name] = 0 if typ in ("integer", "number") else False if typ == "boolean" else ""
    return args


def fetch_live(symbol, expiry=""):
    """One chain from the configured HTTP MCP endpoint, normalised. Raises on any failure."""
    tool = store.cached("fo-tool", 3600, _find_tool)
    out = normalize(nse.mcp(settings.fo_url, tool["name"], _args(tool, symbol.upper(), expiry)))
    out["tool"] = tool["name"]
    out["expiry"] = expiry or (out["expiries"][0] if out["expiries"] else "")
    return out


def _no_data_reason(live_error=None):
    why = ("No option-chain data yet. Options: (1) download the CSV from NSE's option-chain page yourself and drop it into the inbox folder or use "
           "Import CSV below; (2) start MarketLens with --fo-mcp-url <endpoint> (or set NSE_FO_MCP_URL) pointing at an official NSE derivatives MCP. "
           "The default NSE servers (cash market and bhavcopy) have no option-chain tool.")
    return f"{why} Live endpoint error: {live_error}" if live_error else why


def option_chain(symbol, expiry=""):
    """Live data from the configured endpoint when it answers, otherwise the newest saved snapshot, otherwise a clear reason."""
    sym = (symbol or "NIFTY").upper()
    live_error = None
    if settings.fo_url:
        def build():
            out = fetch_live(sym, expiry)
            return dict(out, available=True, symbol=sym, meta={"source": "mcp", "capturedAt": None})
        try:
            return store.cached(f"options:{sym}:{expiry}", 60, build)
        except nse.UpstreamBlocked as e:
            live_error = str(e)
        except Exception as e:
            live_error = f"option chain request failed: {str(e)[:200]}"
    snap = optiondb.latest(sym, expiry)
    if snap:
        return dict(snap, available=True, tool="saved snapshot", warning=live_error)
    return {"available": False, "reason": _no_data_reason(live_error)}
