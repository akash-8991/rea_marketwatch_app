"""Market clock, lean quotes, batch quotes and chart history on the desktop server. Offline (NSE is faked)."""
import datetime
import tempfile
import time
import unittest
from pathlib import Path

from marketlens import config, market, marketclock, nse, optiondb, store

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def at(s):
    return datetime.datetime.fromisoformat(s).replace(tzinfo=IST).timestamp()


class Clock(unittest.TestCase):
    def test_session_hours_edges(self):
        for t, want in (("2026-10-26T09:14:59", False), ("2026-10-26T09:15:00", True), ("2026-10-26T15:29:59", True), ("2026-10-26T15:30:00", False),
                        ("2026-10-24T11:00:00", False), ("2026-10-25T11:00:00", False)):
            self.assertEqual(marketclock.in_session_hours(at(t)), want, t)

    def test_last_session_date(self):
        for t, want in (("2026-10-26T08:00:00", "2026-10-23"), ("2026-10-26T10:00:00", "2026-10-26"), ("2026-10-26T18:00:00", "2026-10-26"),
                        ("2026-10-25T12:00:00", "2026-10-23"), ("2026-10-24T12:00:00", "2026-10-23")):
            self.assertEqual(marketclock.last_session_date(at(t)), want, t)

    def test_state_open_closed_and_holiday(self):
        today = dict(received=20, newest="2026-10-26 10:42:11")
        self.assertEqual(marketclock.market_state(at("2026-10-26T10:45:00"), **today), {"open": True, "live": True, "label": "Market open", "session": "2026-10-26"})
        self.assertIn("closed for the day", marketclock.market_state(at("2026-10-26T16:00:00"), **today)["label"])
        self.assertIn("opens at 9:15", marketclock.market_state(at("2026-10-26T08:00:00"))["label"])
        self.assertIn("Pre-open", marketclock.market_state(at("2026-10-26T09:05:00"))["label"])
        self.assertIn("weekend", marketclock.market_state(at("2026-10-24T11:00:00"))["label"])
        old = dict(received=40, newest="2026-10-23 16:00:29")
        self.assertFalse(marketclock.market_state(at("2026-10-26T11:00:00"), **old)["live"])
        self.assertIn("No trading today", marketclock.market_state(at("2026-10-26T11:00:00"), **old)["label"])
        self.assertTrue(marketclock.market_state(at("2026-10-26T09:20:00"), **old)["live"])
        self.assertTrue(marketclock.market_state(at("2026-10-26T11:00:00"), received=1, newest="2026-10-23 16:00:29")["live"])


class Faked(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        self.saved = (config.settings.data_dir, nse.bh, nse.cm)
        config.settings.data_dir = Path(self.tmp.name)
        store.clear_memory()
        self.calls = {"quote": [], "history": []}
        nse.cm = self.cm
        nse.bh = self.bh

    def tearDown(self):
        optiondb.close()
        config.settings.data_dir, nse.bh, nse.cm = self.saved
        store.clear_memory()
        self.tmp.cleanup()

    def cm(self, tool, args=None):
        self.calls["quote"].append(args["symbol"])
        if args["symbol"] == "BAD":
            return {"stock": None}
        return {"stock": {"lastTradedPrice": 105.0, "preClosePrice": 100.0, "perChange": 5.0, "volume": 777, "value": 1.5, "latestTimestamp": "2026-10-26 10:42:11",
                          "fiftyTwoWeekHigh": 150, "fiftyTwoWeekLow": 80}}

    def bh(self, tool, args=None):
        self.calls["history"].append(args["endDate"])
        chunks = {"": ("2026-07-27", "2026-10-26", "2026-07-25"), "2026-07-25": ("2026-04-27", "2026-07-24", "2026-04-24"), "2026-04-24": ("2026-01-02", "2026-04-23", None)}
        a, b, nxt = chunks[args["endDate"]]
        d0 = datetime.date.fromisoformat(a)
        rows = [{"date": (d0 + datetime.timedelta(days=i)).isoformat(), "close": 100 + i, "volume": 10} for i in range(0, (datetime.date.fromisoformat(b) - d0).days + 1, 3)]
        return {"data": rows, "next_end_date": nxt}


class Quotes(Faked):
    OPEN = {"open": True, "live": True, "label": "Market open"}
    SHUT = {"open": False, "live": False, "label": "Market closed for the day"}

    def test_quote_shape_and_status(self):
        q = market.quote("TCS", self.OPEN)
        self.assertEqual((q["sym"], q["price"], q["abs"], q["chg"], q["exchange"], q["name"]), ("TCS", 105.0, 5.0, 5.0, "NSE", "Tata Consultancy Services Ltd."))
        self.assertIn(q["status"], ("live", "delayed"))   # depends on the real clock vs the fixed timestamp: never 'closed' while the market is open
        self.assertEqual(market.quote("INFY", self.SHUT)["status"], "closed")

    def test_unavailable_stale_and_cache(self):
        self.assertEqual(market.quote("BAD", self.OPEN)["status"], "unavailable")
        store.clear_memory()
        nse.cm = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))
        self.assertEqual(market.quote("NOSAVED", self.SHUT)["status"], "unavailable")
        store.disk_put("bootstrap", {"stocks": [{"sym": "WIPRO", "price": 250.0, "prev": 245.0, "volume": 5, "ts": "2026-10-23"}]})
        s = market.quote("WIPRO", self.SHUT)
        self.assertEqual((s["status"], s["price"], s["chg"]), ("stale", 250.0, 2.04))

    def test_batch_validates_dedupes_and_shares_requests(self):
        r = market.quotes(["tcs", "TCS", "INFY", "bad sym!", "BAD", ""], self.SHUT)
        self.assertEqual([x["sym"] for x in r["quotes"]], ["TCS", "INFY", "BAD SYM!", "BAD"])
        self.assertEqual([x["status"] for x in r["quotes"]], ["closed", "closed", "unavailable", "unavailable"])
        self.assertEqual(sorted(self.calls["quote"]), ["BAD", "INFY", "TCS"], "one request per distinct valid symbol")
        market.quotes(["TCS", "INFY"], self.SHUT)
        self.assertEqual(len(self.calls["quote"]), 3, "second call served from the cache")
        self.assertTrue(market.quotes([f"S{i}" for i in range(60)], self.SHUT)["truncated"])


class History(Faked):
    def test_one_chunk_for_short_ranges_and_longer_ranges_extend_the_saved_series(self):
        h = market.history("TCS", "1M")
        self.assertTrue(h["available"]); self.assertEqual(len(self.calls["history"]), 1)
        self.assertEqual(market.history("TCS", "1W")["range"], "1W"); self.assertEqual(len(self.calls["history"]), 1, "saved series reused")
        y = market.history("TCS", "1Y")
        self.assertEqual(len(self.calls["history"]), 3, "older chunks fetched one after another")
        self.assertTrue(y["truncated"]); self.assertEqual(y["earliest"], "2026-01-02"); self.assertIn("starts on 2026-01-02", y["note"])
        dates = [p[0] for p in y["points"]]
        self.assertEqual(dates, sorted(set(dates)), "sorted and without duplicates")
        self.assertEqual(len(self.calls["history"]), 3)
        market.history("TCS", "10Y"); self.assertEqual(len(self.calls["history"]), 3, "history already complete: no more requests")

    def test_one_day_is_unavailable_with_a_reason_and_bad_range_rejected(self):
        d = market.history("TCS", "1D")
        self.assertFalse(d["available"]); self.assertIn("daily data only", d["reason"])
        self.assertEqual(market.history("TCS", "7Y")["reason"], "unknown range"); self.assertEqual(self.calls["history"], [])


if __name__ == "__main__":
    unittest.main()


class Deadline(Faked):
    def test_a_quote_is_answered_from_the_saved_copy_when_nse_hangs(self):
        import threading
        release = threading.Event()
        market.QUOTE_DEADLINE = 0.2
        try:
            store.disk_put("bootstrap", {"stocks": [{"sym": "WIPRO", "price": 250.0, "prev": 245.0, "volume": 5, "ts": "2026-10-23"}]})
            nse.cm = lambda *a, **k: (release.wait(5), {"stock": None})[1]
            t0 = time.time()
            q = market.quote("WIPRO", {"live": False})
            self.assertLess(time.time() - t0, 1.5)
            self.assertEqual((q["status"], q["price"]), ("stale", 250.0)); self.assertIn("did not answer", q["reason"])
        finally:
            release.set(); market.QUOTE_DEADLINE = 6.0


class SearchDeadline(Faked):
    def test_search_answers_from_the_stock_list_when_nse_search_is_slow(self):
        import threading
        release = threading.Event()
        market.SEARCH_DEADLINE = 0.15
        try:
            nse.bh = lambda *a, **k: (release.wait(5), {"results": []})[1]
            t0 = time.time()
            r = market.search("infosys")
            self.assertLess(time.time() - t0, 1.5)
            self.assertTrue(any(x["symbol"] == "INFY" for x in r["results"]))
        finally:
            release.set(); market.SEARCH_DEADLINE = 0.45
