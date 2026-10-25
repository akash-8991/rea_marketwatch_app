"""Write mobile/tests/golden.json: inputs plus the outputs the PYTHON engine produces for them.
The JavaScript tests must reproduce these exactly, which is how the port is checked against the original.
Run from the repository root:  PYTHONPATH=src python3 mobile/scripts/gen-golden.py"""
import datetime
import json
import math
import os
import random
import tempfile

from marketlens import accounts, analysis, config, market, news, optiondb

random.seed(7)


def walk(n, start=100.0, drift=0.0):
    out, p = [], start
    for _ in range(n):
        p = max(1.0, p * (1 + drift + random.uniform(-0.02, 0.02)))
        out.append(round(p, 2))
    return out


series = {"up": walk(80, 100, 0.006), "down": walk(80, 100, -0.006), "flat": walk(80, 100, 0.0), "short": walk(25, 50, 0.002), "tiny": walk(10)}
tech = {k: analysis.technical_from_history(v) for k, v in series.items()}
tech_price = analysis.technical_from_history(series["up"], series["up"][-1] * 0.9)

snapshots = [
    {"price": 110, "prev": 100, "hi52": 120, "lo52": 80, "pct30": 8.2}, {"price": 90, "prev": 100, "hi52": 120, "lo52": 85, "pct30": -9.5},
    {"price": 100, "prevClose": 99.9, "hi52": None, "lo52": None, "pct30": None}, {"price": None}, {"price": 50, "prev": 50, "hi52": 100, "lo52": 40, "pct30": 0.0},
]
snap_out = [analysis.technical_snapshot(s) for s in snapshots]

boot = {"valuation": [{"name": "NIFTY 50", "divYield": 1.3, "pe": 22.1}, {"name": "NIFTY BANK", "pe": 14.2, "pb": 2.1, "divYield": 0.9}]}
ctx = analysis.valuation_context(boot)
today = datetime.date(2026, 10, 25)
acts = [{"actionType": "DIVIDEND", "exDate": f"{y}-0{m}-15", "purpose": "Dividend - Rs 5 Per Share"} for y, m in ((2026, 2), (2025, 5), (2024, 8))] + [{"actionType": "BONUS", "exDate": "2025-01-10", "purpose": "Bonus 1:1"}]
fund_cases = [("rich", 30, 1000, acts, "Banking"), ("zero", 0, 500, [], "IT"), ("unknown", None, 500, None, None), ("one", 4, 800, acts[:1], "Banking"), ("none-actions", None, 100, [], "Auto")]
fund_out = {k: analysis.fundamental(d, p, a, s, ctx, today) for k, d, p, a, s in fund_cases}

headlines = ["Sensex surges to record high as banks rally", "Stock falls sharply after fraud probe", "Company does not beat estimates", "Record date announced for dividend",
             "Nifty ends flat amid uncertainty", "TCS wins large deal, shares jump", "Profit warning hits shares, analysts downgrade", "", "Markets rebound but concern over inflation remains"]
sent = {"scores": [list(analysis.headline_score(h)) for h in headlines], "labels": [analysis.sentiment_label(*analysis.headline_score(h)) for h in headlines],
        "agg_all": analysis.sentiment(headlines), "agg_pos": analysis.sentiment(headlines[:1] + headlines[5:6] + headlines[8:9]), "agg_none": analysis.sentiment([])}

ttm_actions = [{"actionType": "DIVIDEND", "exDate": "2026-06-01", "purpose": "Dividend - Rs. 12.50 Per Share"}, {"actionType": "DIVIDEND", "exDate": "2024-06-01", "purpose": "Dividend Rs 9"},
               {"actionType": "DIVIDEND", "exDate": "2026-09-01", "purpose": "Special Dividend INR 3"}]
ttm = market.ttm_dividend(ttm_actions, today)

csv_text = "\n".join(["Underlying Value,24500", ",CALLS,,,,,,PUTS,,,,,,", "OI,CHNG IN OI,VOLUME,IV,LTP,CHNG,BID,ASK,STRIKE,BID,ASK,CHNG,LTP,IV,VOLUME,CHNG IN OI,OI"][:1] +
                     [",".join(["OI", "CHNG IN OI", "VOLUME", "IV", "LTP", "CHNG", "BID", "ASK", "STRIKE", "BID", "ASK", "CHNG", "LTP", "IV", "VOLUME", "CHNG IN OI", "OI"])] +
                     [",".join(map(str, r)) for r in [
                         ['"1,200"', 100, 50, 12.5, 220.5, 5, 220, 221, "24,400", 60, 61, -2, 60.5, 13.1, 70, -10, '3,400'],
                         [900, "-", 40, 11.9, 150.0, 3, 149, 151, 24500, 100, 101, -1, 100.2, 12.2, 90, 20, 2500],
                         [700, 30, 30, 11.2, 95.0, 2, 94, 96, 24600, 150, 151, 1, 151.0, 11.9, 85, 40, 1800],
                         [300, 10, 20, 10.9, 60.0, 1, 59, 61, 24700, 210, 211, 2, 210.0, 12.8, 60, 5, 900]]])
parsed = optiondb.parse_csv(csv_text, "option-chain-ED-NIFTY-27-oct-2026.csv", spot=24510.0)
from marketlens import options  # noqa: E402
summary = options.summarize(parsed["rows"], 24510.0)
est = optiondb.estimate_spot(parsed["rows"])
fn_guess = [optiondb.guess_from_filename(n) for n in ("option-chain-ED-NIFTY-27-Oct-2026.csv", "option_chain_EQ_RELIANCE_3_nov_2026.csv", "random.csv")]
bad_csv = {}
for k, t in (("no_header", "a,b\n1,2"), ("few", "CALLS,,STRIKE,PUTS\nOI,x,STRIKE,OI\n5,1,100,5")):
    try:
        optiondb.parse_csv(t, "option-chain-NIFTY-1-Jan-2026.csv")
    except optiondb.CsvError as e:
        bad_csv[k] = str(e)

# RSS
YAHOO = """<?xml version="1.0"?><rss version="2.0"><channel><item><title>Sensex jumps &amp; Nifty rallies</title><link>https://example.com/a</link><pubDate>Fri, 23 Oct 2026 10:00:00 +0000</pubDate></item>
<item><title>Bad link</title><link>javascript:alert(1)</link></item><item><title>No link here</title></item></channel></rss>"""
GOOGLE = """<?xml version="1.0"?><rss version="2.0"><channel><item><title>Stocks slip on weak data - Reuters</title><link>https://news.google.com/x</link><pubDate>Fri, 23 Oct 2026 11:30:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title><![CDATA[Fed - what next? - Bloomberg]]></title><link>https://news.google.com/y</link><pubDate>Fri, 23 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>"""
rss = {"yahoo": news.parse_rss(YAHOO, "yahoo"), "google": news.parse_rss(GOOGLE, "google")}
try:
    news.parse_rss('<!DOCTYPE x [<!ENTITY a "b">]><rss></rss>', "yahoo")
    rss["doctype"] = "accepted"
except news.FeedError as e:
    rss["doctype"] = str(e)
merged = news.merge([rss["yahoo"], rss["google"]], 60)

# accounts + audit chain written by the Python engine (the JS side must verify them and hash identically)
tmp = tempfile.mkdtemp()
config.configure(data_dir=tmp, pbkdf2_iterations=1000)
optiondb.audit("startup", "system", "golden", channel="system")
optiondb.audit("import_ok", "tester", "NIFTY 27-Oct-2026 from csv:x: 3 strikes", "NIFTY", 1, "ab" * 32)
optiondb.audit("login_failed", "anonymous", "incorrect user ID or password", outcome="denied", channel="web", request_id="req-1")
conn = optiondb._db()
rows = conn.execute("SELECT id, ts, event, actor, symbol, snapshot_id, detail, sha256, prev_hash, entry_hash, schema_ver, uid, outcome, request_id, channel FROM audit_log ORDER BY id").fetchall()
audit_rows = [dict(zip(("id", "ts", "event", "actor", "symbol", "snapshotId", "detail", "sha256", "prevHash", "entryHash", "schemaVer", "uid", "outcome", "requestId", "channel"), r)) for r in rows]
pw_hash = accounts.hash_password("correct horse battery", bytes(range(16)), 1000)

golden = {"series": series, "tech": tech, "techPrice": tech_price, "snapshots": snapshots, "snapOut": snap_out, "ctx": ctx,
          "fund": fund_out, "fundCases": [[k, d, p, a, s] for k, d, p, a, s in fund_cases], "today": today.isoformat(), "headlines": headlines, "sent": sent,
          "ttmActions": ttm_actions, "ttm": ttm, "csv": csv_text, "parsed": parsed, "summary": summary, "estSpot": est, "fnGuess": fn_guess, "badCsv": bad_csv,
          "rssYahoo": YAHOO, "rssGoogle": GOOGLE, "rss": rss, "merged": merged, "auditRows": audit_rows, "pwHash": pw_hash,
          "rules": analysis.RULES}
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "golden.json")
with open(out, "w") as f:
    json.dump(golden, f, indent=1, sort_keys=True, default=lambda o: None if isinstance(o, float) and math.isnan(o) else str(o))
print("wrote", os.path.normpath(out), "bytes:", os.path.getsize(out))
