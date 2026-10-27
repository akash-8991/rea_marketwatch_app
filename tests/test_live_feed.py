"""The one-second feed, the intraday recorder and OHLC history on the desktop server. Offline (NSE is faked, the clock is controlled)."""
import datetime
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from marketlens import config, market, nse, optiondb, ratelimit, store, ticks

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
at = lambda s: datetime.datetime.fromisoformat(s).replace(tzinfo=IST).timestamp()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        self.saved = (config.settings.data_dir, nse.bh, nse.cm)
        config.settings.data_dir = Path(self.tmp.name)
        store.clear_memory()
        market._active.clear()
        ticks._mem.clear()
        self.now, self.price, self.calls = at("2026-10-26T10:45:00"), 105.0, {"quote": 0, "indices": 0}
        patcher = mock.patch("time.time", lambda: self.now)
        patcher.start()
        self.addCleanup(patcher.stop)
        nse.cm, nse.bh = self.cm, self.bh

    def tearDown(self):
        optiondb.close()
        config.settings.data_dir, nse.bh, nse.cm = self.saved
        store.clear_memory()
        ticks._mem.clear()
        self.tmp.cleanup()

    def cm(self, tool, args=None):
        if tool == "cm_get_live_indices":
            self.calls["indices"] += 1
            return {"indices": {"derivatives": [{"indexName": "NIFTY 50", "last": self.price * 200, "previousClose": 20000, "percChange": 1.0},
                                                {"indexName": "NIFTY BANK", "last": 45000, "previousClose": 44000, "percChange": 2.2}]}}
        self.calls["quote"] += 1
        stamp = datetime.datetime.fromtimestamp(self.now, IST).strftime("%Y-%m-%d %H:%M:%S")
        return {"stock": {"lastTradedPrice": self.price, "preClosePrice": 100, "openPrice": 101, "highPrice": self.price, "lowPrice": 99, "volume": 1000 + self.calls["quote"] * 10, "latestTimestamp": stamp}}

    def bh(self, tool, args=None):
        rows = [{"date": f"2026-10-{d:02d}", "open": 10 + d, "high": 12 + d, "low": 9 + d, "close": 11 + d, "volume": 100 + d} for d in range(1, 10)]
        return {"data": rows, "next_end_date": None}


class LiveFeed(Base):
    def test_indices_sectors_and_stocks_are_answered_from_a_one_second_cache(self):
        r = market.live_feed(["AAA", "BBB", "bad!"])
        self.assertTrue(r["market"]["live"])
        self.assertEqual(r["intervalMs"], 1000)
        self.assertEqual([i["name"] for i in r["indices"]], ["NIFTY 50", "NIFTY BANK"])
        self.assertEqual(r["indices"][0]["last"], 105 * 200)
        self.assertEqual([q["sym"] for q in r["quotes"]], ["AAA", "BBB"])
        self.assertIn("open", r["quotes"][0])
        self.assertEqual((self.calls["quote"], self.calls["indices"]), (2, 1))
        market.live_feed(["AAA", "BBB"])
        self.assertEqual(self.calls["quote"], 2, "nothing is re-fetched inside the second")
        self.price, self.now = 107.0, self.now + 1.1
        again = market.live_feed(["AAA", "BBB"])
        self.assertEqual(again["quotes"][0]["price"], 107.0)
        self.assertEqual(self.calls["quote"], 4)
        self.assertEqual(again["indices"][0]["last"], 107 * 200)

    def test_after_the_close_the_cadence_slows_and_nothing_is_hammered(self):
        self.now = at("2026-10-26T16:30:00")
        r = market.live_feed(["AAA"])
        self.assertFalse(r["market"]["live"])
        self.assertEqual(r["intervalMs"], 30000)
        self.now += 5
        market.live_feed(["AAA"])
        self.assertEqual(self.calls["quote"], 1)

    def test_many_symbols_share_a_fixed_budget_of_upstream_calls(self):
        syms = [f"S{i}" for i in range(30)]
        market.live_feed(syms)
        self.assertEqual(self.calls["quote"], 30)
        self.now += 1.5
        market.live_feed(syms)
        self.assertEqual(self.calls["quote"], 30, "30 symbols at 10 calls a second: 3 s between refreshes")
        self.now += 2
        market.live_feed(syms)
        self.assertEqual(self.calls["quote"], 60)

    def test_a_failing_index_call_degrades_to_quotes_only(self):
        orig = self.cm
        nse.cm = lambda tool, args=None: (_ for _ in ()).throw(RuntimeError("down")) if tool == "cm_get_live_indices" else orig(tool, args)
        r = market.live_feed(["AAA"])
        self.assertEqual(r["indices"], [])
        self.assertIn("indicesError", r)
        self.assertEqual(len(r["quotes"]), 1)

    def test_the_feed_has_its_own_generous_rate_class(self):
        cap, rate = ratelimit.DEFAULT_LIMITS["live"]
        self.assertGreaterEqual(rate, 20)
        self.assertGreater(cap, ratelimit.DEFAULT_LIMITS["expensive"][0])


class Intraday(Base):
    def test_live_quotes_become_one_minute_bars_with_volume_differences(self):
        market.quote("AAA")
        self.price, self.now = 103.0, self.now + 20
        store.forget("lq:AAA")
        market.quote("AAA")
        self.now += 60
        self.price = 99.0
        store.forget("lq:AAA")
        market.quote("AAA")
        out = market.intraday("AAA")
        self.assertGreaterEqual(len(out["bars"]), 2)
        first = out["bars"][0]
        self.assertEqual(first[1], 105.0)
        self.assertEqual(out["bars"][-1][4], 99.0)
        self.assertIn("daily history only", out["source"])

    def test_bars_survive_a_restart_and_repeats_are_ignored(self):
        self.assertTrue(ticks.record("AAA", 100, 1000, "2026-10-26 10:00:05", now=self.now))
        self.assertFalse(ticks.record("AAA", 100, 1000, "2026-10-26 10:00:05", now=self.now))
        self.assertFalse(ticks.record("AAA", 0, 1000, "2026-10-26 10:00:07", now=self.now))
        ticks.record("AAA", 103, 1500, "2026-10-26 10:00:40", now=self.now)
        ticks.flush_all()
        ticks._mem.clear()
        bars = ticks.bars("AAA")
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0][1:], [100, 103, 100, 103, 500])

    def test_the_market_being_shut_records_nothing(self):
        self.now = at("2026-10-26T18:00:00")
        market.quote("AAA")
        self.assertEqual(market.intraday("AAA")["bars"], [])


class Indices(Base):
    def test_an_index_key_resolves_charts_and_records(self):
        self.assertEqual(market.index_key("NIFTY 50"), "IDX_NIFTY_50")
        self.assertEqual(market.index_name("IDX_NIFTY_BANK"), "NIFTY BANK")
        got = {}
        orig = self.bh
        def bh(tool, args=None):
            if tool == "get_index_history":
                got.update(args)
                return {"data": [{"date": "2026-10-22", "open": 1, "high": 3, "low": 0.5, "close": 2, "volume": 7}], "next_end_date": None}
            return orig(tool, args)
        nse.bh = bh
        h = market.history("IDX_NIFTY_50", "1Y")
        self.assertEqual(got["indexName"], "NIFTY 50")
        self.assertEqual(h["points"][0], ["2026-10-22", 2, 7, 1, 3, 0.5])
        r = market.live_feed(["IDX_NIFTY_50", "AAA"])
        q = [x for x in r["quotes"] if x["sym"] == "IDX_NIFTY_50"][0]
        self.assertEqual((q["price"], q["prev"], q["status"]), (105 * 200, 20000, "live"))
        self.assertTrue(any(x["sym"] == "AAA" for x in r["quotes"]))
        self.assertEqual(market.intraday("IDX_NIFTY_50")["bars"][-1][4], 105 * 200)


class HistoryOhlc(Base):
    def test_history_keeps_open_high_low_and_refetches_old_closes_only_copies(self):
        h = market.history("AAA", "1Y")
        self.assertEqual(h["points"][0][:6], ["2026-10-01", 12, 101, 11, 13, 10])
        store.disk_put("hist-BBB", {"points": [["2026-10-01", 5, 1]], "complete": True, "next": None})   # saved by an older release: no open, high, low
        h2 = market.history("BBB", "1Y")
        self.assertEqual(len(h2["points"][0]), 6)


if __name__ == "__main__":
    unittest.main()
