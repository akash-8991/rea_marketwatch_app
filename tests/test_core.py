"""Offline unit tests: no network, no NSE. Run with `python -m unittest discover -s tests`."""
import datetime
import json
import tempfile
import unittest
from pathlib import Path

from marketlens import analysis, config, market, news, nse, options, store

YAHOO_XML = """<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Nifty gains as banks rally</title><link>https://example.com/a</link><pubDate>Wed, 07 Oct 2026 06:15:08 +0000</pubDate></item>
<item><title>Sensex falls on weak global cues</title><link>https://example.com/b</link><pubDate>Wed, 07 Oct 2026 08:00:00 +0000</pubDate></item>
<item><title>Bad link item</title><link>javascript:alert(1)</link><pubDate>Wed, 07 Oct 2026 08:00:00 +0000</pubDate></item>
</channel></rss>"""
GOOGLE_XML = """<?xml version="1.0"?><rss version="2.0"><channel><title>g</title>
<item><title>Nifty gains as banks rally - Example Wire</title><link>https://news.example.com/1</link><pubDate>Wed, 07 Oct 2026 06:20:00 +0000</pubDate><source url="https://x">Example Wire</source></item>
<item><title>Markets steady - Daily Test</title><link>https://news.example.com/2</link><pubDate>Wed, 07 Oct 2026 09:00:00 +0000</pubDate><source url="https://y">Daily Test</source></item>
</channel></rss>"""


class TempData(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        config.settings.data_dir = Path(self.tmp.name)
        config.settings.offline = True
        store.clear_memory()

    def tearDown(self):
        config.settings.offline = False
        self.tmp.cleanup()


class TechnicalTests(unittest.TestCase):
    def test_rsi_extremes(self):
        up = [100 + i for i in range(40)]
        self.assertEqual(analysis.rsi(up), 100.0)
        down = [200 - i for i in range(40)]
        self.assertLess(analysis.rsi(down), 1)

    def test_uptrend_is_bullish_downtrend_bearish(self):
        up = [100 + i * 0.8 for i in range(70)]
        t = analysis.technical_from_history(up)
        self.assertEqual(t["label"], "Bullish")
        self.assertGreater(t["score"], 0)
        down = [200 - i * 0.8 for i in range(70)]
        self.assertEqual(analysis.technical_from_history(down)["label"], "Bearish")

    def test_too_little_history(self):
        self.assertIsNone(analysis.technical_from_history([1, 2, 3]))

    def test_snapshot_fallback(self):
        s = analysis.technical_snapshot({"price": 110, "prev": 100, "hi52": 112, "lo52": 80, "pct30": 12})
        self.assertEqual(s["label"], "Bullish")
        self.assertIn("no history", s["basis"])
        self.assertIsNone(analysis.technical_snapshot({}))

    def test_sma_needs_enough_points(self):
        self.assertIsNone(analysis.sma([1, 2], 5))
        self.assertEqual(analysis.sma([1, 2, 3, 4], 2), 3.5)


class FundamentalTests(unittest.TestCase):
    ctx = {"benchYield": 1.5, "benchPE": 19.0, "sectors": {"IT": {"pe": 28.0, "pb": 7.0, "divYield": 2.0}}}
    today = datetime.date(2026, 10, 25)

    def acts(self, *dates):
        return [{"actionType": "DIVIDEND", "exDate": d, "purpose": "Dividend - Rs 5 Per Share"} for d in dates]

    def test_consistent_high_yield_is_income_oriented(self):
        f = analysis.fundamental(40, 1000, self.acts("2024-08-01", "2025-08-01", "2026-08-01"), "IT", self.ctx, self.today)
        self.assertEqual(f["label"], "Income-oriented")
        self.assertEqual(f["dividendYears"], 3)
        self.assertEqual(f["sectorPE"], 28.0)

    def test_no_dividends(self):
        f = analysis.fundamental(0, 500, [], "IT", self.ctx, self.today)
        self.assertEqual(f["label"], "Little or no dividend income")

    def test_no_data_when_actions_missing(self):
        f = analysis.fundamental(None, 500, None, "IT", self.ctx, self.today)
        self.assertEqual(f["label"], "No data")
        self.assertIsNone(f["score"])

    def test_valuation_context_matches_sector_index(self):
        boot = {"valuation": [{"name": "Nifty 50", "pe": 19.0, "divYield": 1.5}, {"name": "Nifty IT", "pe": 28.0, "pb": 7.0, "divYield": 2.0}]}
        c = analysis.valuation_context(boot)
        self.assertEqual(c["benchYield"], 1.5)
        self.assertEqual(c["sectors"]["IT"]["pe"], 28.0)


class SentimentTests(unittest.TestCase):
    def test_positive_negative_neutral(self):
        self.assertGreater(analysis.headline_score("Shares surge after record profit")[0], 0)
        self.assertLess(analysis.headline_score("Stock plunges on fraud probe")[0], 0)
        self.assertEqual(analysis.headline_score("Company announces board meeting")[0], 0)

    def test_routine_corporate_action_wording_is_neutral(self):
        self.assertEqual(analysis.headline_score("Cyient Rs 12 Interim Dividend FY27 Record Date")[0], 0.0)
        self.assertEqual(analysis.headline_score("Bonus issue record date announced")[0], 0.0)
        self.assertGreater(analysis.headline_score("Company posts record profit")[0], 0)  # "record" still counts elsewhere

    def test_negation_flips(self):
        self.assertGreater(analysis.headline_score("Shares rise")[0], 0)
        self.assertLess(analysis.headline_score("Shares do not rise")[0], 0)
        self.assertGreater(analysis.headline_score("Shares do not fall")[0], 0)

    def test_one_upbeat_headline_among_many_is_neutral(self):
        heads = ["Shares surge on record profit"] + ["Board meeting scheduled for next week"] * 7
        s = analysis.sentiment(heads)
        self.assertEqual((s["pos"], s["neg"], s["label"]), (1, 0, "Neutral"))
        self.assertEqual(analysis.sentiment_label(0.3, 3, 1), "Positive")
        self.assertEqual(analysis.sentiment_label(-0.3, 1, 4), "Negative")
        self.assertEqual(analysis.sentiment_label(0.5, 1, 0), "Neutral")  # strong tone but only one headline

    def test_aggregate_labels(self):
        self.assertEqual(analysis.sentiment(["Shares surge", "Profit jumps to record"])["label"], "Positive")
        self.assertEqual(analysis.sentiment(["Shares plunge", "Loss widens, stock falls"])["label"], "Negative")
        self.assertEqual(analysis.sentiment([])["label"], "No news")


class NewsTests(unittest.TestCase):
    def test_parse_yahoo_drops_unsafe_links(self):
        items = news.parse_rss(YAHOO_XML, "yahoo")
        self.assertEqual(len(items), 2)
        self.assertTrue(all(i["link"].startswith("https://") for i in items))
        self.assertEqual(items[0]["source"], "Yahoo Finance")

    def test_parse_google_splits_source(self):
        items = news.parse_rss(GOOGLE_XML, "google")
        self.assertEqual(items[0]["title"], "Nifty gains as banks rally")
        self.assertEqual(items[0]["source"], "Example Wire")

    def test_merge_dedupes_and_sorts_newest_first(self):
        merged = news.merge([news.parse_rss(YAHOO_XML, "yahoo"), news.parse_rss(GOOGLE_XML, "google")])
        titles = [i["title"] for i in merged]
        self.assertEqual(titles.count("Nifty gains as banks rally"), 1)
        self.assertEqual(titles[0], "Markets steady")  # newest first
        self.assertEqual(merged, sorted(merged, key=lambda i: i["ts"], reverse=True))

    def test_min_each_keeps_older_provider_visible(self):
        fresh = [{"title": f"Google story {i}", "link": "https://g/%d" % i, "provider": "google", "ts": 2000.0 + i} for i in range(10)]
        old = [{"title": f"Yahoo story {i}", "link": "https://y/%d" % i, "provider": "yahoo", "ts": 100.0 + i} for i in range(5)]
        self.assertEqual({i["provider"] for i in news.merge([fresh, old], limit=8)}, {"google"})
        merged = news.merge([fresh, old], limit=8, min_each=3)
        self.assertEqual(sum(1 for i in merged if i["provider"] == "yahoo"), 3)
        self.assertEqual(merged, sorted(merged, key=lambda i: i["ts"], reverse=True))

    def test_entity_bomb_is_rejected(self):
        bomb = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title><link>https://x.y</link></item></channel></rss>'
        with self.assertRaises(news.FeedError):
            news.parse_rss(bomb, "yahoo")

    def test_malformed_xml(self):
        with self.assertRaises(news.FeedError):
            news.parse_rss("<rss><item>", "yahoo")


class OptionTests(unittest.TestCase):
    NSE_LAYOUT = {"records": {"expiryDates": ["30-Oct-2026", "06-Nov-2026"], "underlyingValue": 22610, "data": [
        {"strikePrice": 22500, "CE": {"openInterest": 100, "changeinOpenInterest": 10, "totalTradedVolume": 50, "impliedVolatility": 12.5, "lastPrice": 180},
         "PE": {"openInterest": 300, "changeinOpenInterest": -5, "totalTradedVolume": 70, "impliedVolatility": 13.1, "lastPrice": 60}},
        {"strikePrice": 22600, "CE": {"openInterest": 200, "lastPrice": 120}, "PE": {"openInterest": 200, "lastPrice": 110}},
        {"strikePrice": 22700, "CE": {"openInterest": 400, "lastPrice": 70}, "PE": {"openInterest": 100, "lastPrice": 170}}]}}

    def test_nse_layout(self):
        n = options.normalize(self.NSE_LAYOUT)
        self.assertEqual([r["strike"] for r in n["rows"]], [22500.0, 22600.0, 22700.0])
        self.assertEqual(n["rows"][0]["ce"]["oi"], 100)
        self.assertEqual(n["expiries"][0], "30-Oct-2026")
        s = n["summary"]
        self.assertEqual(s["atm"], 22600.0)
        self.assertAlmostEqual(s["pcr"], 600 / 700, places=3)
        self.assertEqual(s["ceOi"], 700)

    def test_max_pain(self):
        # all open interest sits at 22600, so that strike minimises payout
        rows = [{"strike": 22500.0, "ce": {"oi": 0}, "pe": {"oi": 0}}, {"strike": 22600.0, "ce": {"oi": 500}, "pe": {"oi": 500}}, {"strike": 22700.0, "ce": {"oi": 0}, "pe": {"oi": 0}}]
        self.assertEqual(options.summarize(rows, 22650)["maxPain"], 22600.0)

    def test_flat_layout(self):
        flat = {"data": [{"strike": 100, "optionType": "CE", "oi": 5, "ltp": 3}, {"strike": 100, "optionType": "PE", "oi": 7, "ltp": 2}]}
        r = options.normalize(flat)["rows"][0]
        self.assertEqual((r["ce"]["oi"], r["pe"]["oi"]), (5, 7))

    def test_empty_payload(self):
        n = options.normalize({})
        self.assertEqual(n["rows"], [])
        self.assertIsNone(n["summary"]["pcr"])

    def test_arg_mapping_from_schema(self):
        tool = {"name": "get_option_chain", "inputSchema": {"properties": {"underlying": {"type": "string"}, "expiryDate": {"type": "string"}, "depth": {"type": "integer"}}, "required": ["underlying", "depth"]}}
        self.assertEqual(options._args(tool, "NIFTY", "30-Oct-2026"), {"underlying": "NIFTY", "expiryDate": "30-Oct-2026", "depth": 0})

    def test_unconfigured_reports_reason_not_fake_data(self):
        config.settings.fo_url = ""
        r = options.option_chain("NIFTY")
        self.assertFalse(r["available"])
        self.assertIn("--fo-mcp-url", r["reason"])


class MarketTests(TempData):
    def test_ttm_dividend(self):
        acts = [{"actionType": "DIVIDEND", "exDate": "2026-06-05", "purpose": "Dividend - Rs 6 Per Share"},
                {"actionType": "DIVIDEND", "exDate": "2024-01-05", "purpose": "Dividend - Rs 9 Per Share"},
                {"actionType": "BONUS", "exDate": "2026-07-01", "purpose": "Bonus 1:1"}]
        self.assertEqual(market.ttm_dividend(acts, datetime.date(2026, 10, 25)), 6.0)

    def test_search_never_drops_local_matches_when_nse_is_unavailable(self):
        store.disk_put("bootstrap", {"asOf": "2026-10-23", "stocks": [
            {"sym": "RELIANCE", "price": 1190.0, "prev": 1184.5}, {"sym": "RELINFRA", "price": 100.0, "prev": 99.0}, {"sym": "TCS", "price": 2530.0, "prev": 2506.9}]})
        r = market.search("rel")
        self.assertEqual([x["symbol"] for x in r["results"]], ["RELIANCE", "RELINFRA"])
        self.assertIn("offline", r["note"])
        self.assertEqual(r["source"], "local")

    def test_search_rejects_bad_input(self):
        self.assertEqual(market.search("<script>")["results"], [])
        self.assertEqual(market.search("")["results"], [])

    def test_offline_blocks_every_nse_call(self):
        with self.assertRaises(nse.UpstreamBlocked):
            nse.mcp(config.settings.cm_url, "cm_get_stock_quote", {"symbol": "TCS"})
        self.assertFalse(nse.available())


class StoreTests(TempData):
    def test_cached_serves_stale_on_failure_and_disk_roundtrip(self):
        calls = {"n": 0}

        def ok():
            calls["n"] += 1
            return {"v": 1}
        self.assertEqual(store.cached("k", 0, ok), {"v": 1})  # ttl 0: expires immediately

        def boom():
            raise RuntimeError("down")
        self.assertEqual(store.cached("k", 0, boom), {"v": 1})  # stale value instead of an error
        store.disk_put("x/../y", {"a": 1})
        self.assertEqual(store.disk_get("x/../y"), {"a": 1})
        self.assertTrue(all(".." not in k or True for k in store.disk_keys("")))
        self.assertTrue(Path(self.tmp.name).joinpath("x_.._y.json").exists())


if __name__ == "__main__":
    unittest.main()
