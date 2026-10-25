"""Technical, fundamental and sentiment scoring.

These are simple, transparent rule sets for exploration, not investment advice. Every result carries the
signals that produced it and the basis it was computed on, so the UI can show its limits.
Fundamentals are limited to what NSE publishes (dividends, corporate actions, index-level valuation):
NSE does not provide per-stock P/E, earnings, debt or growth figures.
"""
import datetime
import re

# Every threshold used below lives here, and the UI's "how the ratings work" text is built from this dict
# (served by /api/config), so the explanation cannot drift from the behaviour.
RULES = {
    "techBand": 0.34,                       # average score at or beyond +/- this is Bullish / Bearish
    "smaFast": 20, "smaSlow": 50, "rsiPeriod": 14, "histMinCloses": 20,
    "rsiBullLow": 55, "rsiBullHigh": 70, "rsiBearLow": 30, "rsiBearHigh": 45,
    "snapMomentumPct": 5, "snapMomentumWeight": 1.5,        # fallback without history: 30-day change
    "snapRangeHigh": 66, "snapRangeLow": 33,                # position in the 52-week range, percent
    "snapDayPct": 0.5, "snapDayWeight": 0.5,                # today's change
    "sentBand": 0.15, "sentNet": 2, "sentMaxHeadlines": 8,  # Positive/Negative need this average AND this net headline lead
    "incYieldMult": 1.5, "incYearsFull": 3, "incHigh": 0.5, "incLow": 0.0,
}

# ---------- technical ----------


def sma(vals, n):
    return sum(vals[-n:]) / n if len(vals) >= n else None


def ema_series(vals, n):
    if not vals:
        return []
    k, e, out = 2 / (n + 1), vals[0], []
    for v in vals:
        e = v * k + e * (1 - k)
        out.append(e)
    return out


def rsi(closes, n=None):
    """Wilder's RSI. Needs at least n+1 closes."""
    n = n or RULES["rsiPeriod"]
    if len(closes) <= n:
        return None
    gains = losses = 0.0
    for i in range(1, n + 1):
        d = closes[i] - closes[i - 1]
        gains += max(d, 0)
        losses += max(-d, 0)
    avg_g, avg_l = gains / n, losses / n
    for i in range(n + 1, len(closes)):
        d = closes[i] - closes[i - 1]
        avg_g = (avg_g * (n - 1) + max(d, 0)) / n
        avg_l = (avg_l * (n - 1) + max(-d, 0)) / n
    if avg_l == 0:
        return 100.0
    return 100 - 100 / (1 + avg_g / avg_l)


def macd(closes, fast=12, slow=26, signal=9):
    if len(closes) < slow + signal:
        return None
    line = [a - b for a, b in zip(ema_series(closes, fast), ema_series(closes, slow))]
    sig = ema_series(line, signal)
    return {"macd": line[-1], "signal": sig[-1], "hist": line[-1] - sig[-1]}


def _label(score, pos="Bullish", neg="Bearish", mid="Neutral", band=None):
    band = RULES["techBand"] if band is None else band
    return pos if score >= band else neg if score <= -band else mid


def _combine(parts):
    """parts: [(name, value in [-1, 1], weight, note)] -> (score in [-1, 1], signals)."""
    total = sum(w for _, _, w, _ in parts) or 1
    score = sum(v * w for _, v, w, _ in parts) / total
    return round(score, 3), [{"name": n, "value": v, "note": note} for n, v, _, note in parts]


def technical_from_history(closes, price=None):
    """Trend and momentum from daily closes (oldest -> newest)."""
    R = RULES
    if len(closes) < R["histMinCloses"]:
        return None
    price = price if price is not None else closes[-1]
    fast, slow = R["smaFast"], R["smaSlow"]
    s20, s50, r, m = sma(closes, fast), sma(closes, slow), rsi(closes), macd(closes)
    parts = [(f"Price vs SMA {fast}", 1 if price > s20 else -1, 1, f"price {'above' if price > s20 else 'below'} the {fast}-day average {s20:.2f}")]
    if s50 is not None:
        parts.append((f"SMA {fast} vs SMA {slow}", 1 if s20 > s50 else -1, 1, f"{fast}-day {'above' if s20 > s50 else 'below'} {slow}-day average {s50:.2f}"))
    if r is not None:
        v = 1 if R["rsiBullLow"] <= r < R["rsiBullHigh"] else -1 if R["rsiBearLow"] <= r < R["rsiBearHigh"] else 0
        note = "overbought, momentum may fade" if r >= R["rsiBullHigh"] else "oversold, momentum weak" if r < R["rsiBearLow"] else f"RSI {r:.1f}"
        parts.append((f"RSI ({R['rsiPeriod']})", v, 1, note))
    if m is not None:
        parts.append(("MACD histogram", 1 if m["hist"] > 0 else -1, 1, f"MACD {'above' if m['hist'] > 0 else 'below'} its signal line"))
    score, signals = _combine(parts)
    return {"basis": f"{len(closes)} daily closes", "score": score, "label": _label(score), "rsi": r and round(r, 1),
            "sma20": round(s20, 2), "sma50": s50 and round(s50, 2), "macdHist": m and round(m["hist"], 3), "signals": signals}


def technical_snapshot(s):
    """Fallback when no history is available: momentum and range position from a single quote."""
    R = RULES
    price, prev, hi, lo, p30 = s.get("price"), s.get("prev") or s.get("prevClose"), s.get("hi52"), s.get("lo52"), s.get("pct30")
    parts = []
    if p30 is not None:
        m = R["snapMomentumPct"]
        parts.append(("30-day change", 1 if p30 > m else -1 if p30 < -m else 0, R["snapMomentumWeight"], f"{p30:+.1f}% over 30 days"))
    if price and hi and lo and hi > lo:
        pos = (price - lo) / (hi - lo) * 100
        parts.append(("52-week position", 1 if pos >= R["snapRangeHigh"] else -1 if pos <= R["snapRangeLow"] else 0, 1, f"{pos:.0f}% of the 52-week range"))
    if price and prev:
        d = (price - prev) / prev * 100
        parts.append(("Day change", 1 if d > R["snapDayPct"] else -1 if d < -R["snapDayPct"] else 0, R["snapDayWeight"], f"{d:+.2f}% today"))
    if not parts:
        return None
    score, signals = _combine(parts)
    return {"basis": "single quote (no history loaded yet)", "score": score, "label": _label(score), "signals": signals}


# ---------- fundamental (limited to what NSE publishes) ----------

SECTOR_INDEX = {"Banking": "nifty bank", "IT": "nifty it", "Auto": "nifty auto", "Pharma": "nifty pharma", "FMCG": "nifty fmcg",
                "Metals": "nifty metal", "Energy": "nifty energy", "Realty": "nifty realty", "Media": "nifty media",
                "Financial services": "nifty financial services"}


def valuation_context(boot):
    """Benchmark yield and per-sector index valuation from a bootstrap payload."""
    val = {v["name"].lower(): v for v in boot.get("valuation", []) if v.get("name")}
    base = val.get("nifty 50", {})
    sectors = {sec: val[name] for sec, name in SECTOR_INDEX.items() if name in val}
    return {"benchYield": base.get("divYield"), "benchPE": base.get("pe"), "sectors": sectors}


def fundamental(div_ttm, price, actions, sector=None, ctx=None, today=None):
    """Income and corporate-action profile. `actions` are NSE corporate-action rows."""
    ctx = ctx or {}
    today = today or datetime.date.today()
    divs = [a for a in actions or [] if a.get("actionType") == "DIVIDEND" and a.get("exDate")]
    years = {a["exDate"][:4] for a in divs if a["exDate"] >= (today - datetime.timedelta(days=3 * 365 + 5)).isoformat()}
    yld = round(div_ttm / price * 100, 2) if div_ttm and price else (0.0 if div_ttm == 0 else None)
    bonus = sum(1 for a in actions or [] if a.get("actionType") in ("BONUS", "SPLIT", "STOCK SPLIT"))
    sec = (ctx.get("sectors") or {}).get(sector or "", {})
    if yld is None and not divs:
        return {"label": "No data", "score": None, "yield": None, "signals": [], "basis": "no corporate-action data loaded yet",
                "sectorPE": sec.get("pe"), "sectorPB": sec.get("pb"), "sectorYield": sec.get("divYield")}
    bench = ctx.get("benchYield")
    parts = []
    if yld is not None and bench:
        parts.append(("Dividend yield vs Nifty 50", 1 if yld >= RULES["incYieldMult"] * bench else 0 if yld > 0 else -1, 1,
                      f"{yld:.2f}% vs index {bench:.2f}%" if yld else "no dividend in the last 12 months"))
    consistency = len(years)
    parts.append(("Dividend consistency", 1 if consistency >= RULES["incYearsFull"] else 0.5 if consistency == RULES["incYearsFull"] - 1 else 0 if consistency == 1 else -1, 1,
                  f"dividends in {consistency} of the last 3 calendar years"))
    score, signals = _combine(parts)
    label = "Income-oriented" if score >= RULES["incHigh"] else "Moderate income" if score >= RULES["incLow"] else "Little or no dividend income"
    return {"label": label, "score": score, "yield": yld, "dividendsTtm": div_ttm, "dividendYears": consistency, "bonusOrSplit": bonus,
            "signals": signals, "basis": "dividends and corporate actions published by NSE; no earnings, debt or growth data",
            "sectorPE": sec.get("pe"), "sectorPB": sec.get("pb"), "sectorYield": sec.get("divYield")}


# ---------- sentiment (headline lexicon) ----------

POSITIVE = set("""surge surges surged rally rallies rallied gain gains gained jump jumps jumped soar soars soared rise rises rose higher
record beat beats upgrade upgrades upgraded bullish strong strength growth profit profits outperform outperforms boost boosts boosted win wins
won expands expansion recovery recover recovers rebound rebounds rebounded positive optimism optimistic approval approves approved
breakthrough upbeat robust improves improved improving buyback surpass surpasses""".split())
NEGATIVE = set("""fall falls fell drop drops dropped slump slumps slumped plunge plunges plunged tumble tumbles tumbled sink sinks sank slip slips
slipped lower loss losses miss misses missed downgrade downgrades downgraded bearish weak weakness fear fears crash crashes probe fraud penalty
fine fined lawsuit default cuts cut warns warning warn concern concerns risk risks decline declines declined layoffs resigns ban banned delay
delays selloff sell-off pressure pressured volatile uncertainty hike slowdown""".split())
NEGATORS = {"not", "no", "never", "without", "fails", "fail", "failed", "unlikely"}
_TOKEN = re.compile(r"[a-z][a-z\-']*")


def headline_score(text):
    toks = _TOKEN.findall((text or "").lower())
    pos = neg = 0
    for i, t in enumerate(toks):
        if t == "record" and i + 1 < len(toks) and toks[i + 1] in ("date", "dates"):
            continue  # "record date" is a corporate-action term, not good news
        flipped = i > 0 and toks[i - 1] in NEGATORS
        if t in POSITIVE:
            neg, pos = (neg + 1, pos) if flipped else (neg, pos + 1)
        elif t in NEGATIVE:
            pos, neg = (pos + 1, neg) if flipped else (pos, neg + 1)
    n = pos + neg
    return (pos - neg) / n if n else 0.0, pos, neg


def sentiment_label(score, pos, neg):
    """Positive/Negative only with a clear lead: average tone beyond +/-RULES["sentBand"] AND at least RULES["sentNet"]
    more positive than negative headlines (or the reverse). One upbeat headline among eight is Neutral."""
    if score is None:
        return "No news"
    net = pos - neg
    band, need = RULES["sentBand"], RULES["sentNet"]
    return "Positive" if score >= band and net >= need else "Negative" if score <= -band and net <= -need else "Neutral"


def sentiment(headlines):
    """Aggregate lexicon sentiment over headline strings."""
    scores = [headline_score(h) for h in headlines if h]
    if not scores:
        return {"score": None, "label": "No news", "n": 0, "pos": 0, "neg": 0}
    avg = sum(s for s, _, _ in scores) / len(scores)
    pos, neg = sum(1 for s, _, _ in scores if s > 0), sum(1 for s, _, _ in scores if s < 0)
    return {"score": round(avg, 3), "label": sentiment_label(avg, pos, neg), "n": len(scores), "pos": pos, "neg": neg}
