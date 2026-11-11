"""Zerodha first, NSE as the fallback, for quotes, indices and history. Offline: Kite and NSE are both faked."""
import datetime
import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

from marketlens import broker, config, kitedata, market, nse, optiondb, store, ticks

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
NOW = datetime.datetime.fromisoformat("2026-10-26T10:45:00").replace(tzinfo=IST).timestamp()
CSV = ("instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange\n"
       "111,1,AAA,AAA LTD,0,,0,0.05,1,EQ,NSE,NSE\n999,9,NIFTY 50,NIFTY 50,0,,0,0,1,EQ,INDICES,NSE\n")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        self.saved = (config.settings.data_dir, config.settings.offline, nse.bh, nse.cm, broker._http)
        config.settings.data_dir, config.settings.offline = Path(self.tmp.name), False
        store.clear_memory(); kitedata.reset(); market._active.clear(); ticks._mem.clear()
        self.now, self.kite_calls, self.nse_calls, self.kite_fail = NOW, [], {"quote": 0, "hist": 0}, None
        p = mock.patch("time.time", lambda: self.now); p.start(); self.addCleanup(p.stop)
        nse.cm, nse.bh, broker._http = self.cm, self.bh, self.http
        self.connect()

    def tearDown(self):
        optiondb.close()
        config.settings.data_dir, config.settings.offline, nse.bh, nse.cm, broker._http = self.saved
        store.clear_memory(); kitedata.reset(); ticks._mem.clear()
        self.tmp.cleanup()

    def connect(self, on=True):
        d = {"api_key": "abcdef123", "api_secret": "s", "access_token": "tok", "token_expires": NOW + 3600} if on else {}
        (Path(self.tmp.name) / "broker.json").write_text(json.dumps(d))

    def cm(self, tool, args=None):
        self.nse_calls["quote"] += 1
        if tool == "cm_get_live_indices":
            return {"indices": {"d": [{"indexName": "NIFTY 50", "last": 20000, "previousClose": 19900, "percChange": 0.5}]}}
        return {"stock": {"lastTradedPrice": 50.0, "preClosePrice": 49.0, "openPrice": 49.5, "highPrice": 51, "lowPrice": 48, "volume": 10,
                          "latestTimestamp": "2026-10-26 10:44:59", "fiftyTwoWeekHigh": 60, "fiftyTwoWeekLow": 30}}

    def bh(self, tool, args=None):
        self.nse_calls["hist"] = self.nse_calls.get("hist", 0) + 1
        return {"data": [{"date": "2026-10-01", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 5}], "next_end_date": None}

    def http(self, method, url, headers=None, data=None, timeout=12):
        self.kite_calls.append(url)
        if self.kite_fail:
            return self.kite_fail
        path = urllib.parse.urlparse(url).path
        if path == "/quote":
            ins = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["i"]
            out = {}
            for i in ins:
                if i in ("NSE:AAA", "NSE:BBB"):
                    out[i] = {"last_price": 100.0, "volume": 777, "timestamp": "2026-10-26 10:44:58", "ohlc": {"open": 98, "high": 101, "low": 97, "close": 95}}
                if i == "NSE:NIFTY 50":
                    out[i] = {"last_price": 25000.0, "timestamp": "2026-10-26 10:44:58", "ohlc": {"open": 24900, "high": 25010, "low": 24800, "close": 24950}}
            return 200, json.dumps({"status": "success", "data": out}).encode()
        if path == "/instruments/NSE":
            return 200, CSV.encode()
        if path.startswith("/instruments/historical/"):
            return 200, json.dumps({"status": "success", "data": {"candles": [["2026-10-01T00:00:00+0530", 10, 12, 9, 11, 1000], ["2026-10-02T00:00:00+0530", 11, 13, 10, 12, 1100]]}}).encode()
        return 404, b"{}"


class Quotes(Base):
    def test_connected_quotes_come_from_zerodha_and_not_nse(self):
        q = market.quote("AAA")
        self.assertEqual((q["source"], q["price"], q["prev"], q["volume"]), ("zerodha", 100.0, 95, 777))
        self.assertEqual(self.nse_calls["quote"], 0)
        self.assertEqual(q["chg"], round(5 / 95 * 100, 2))

    def test_many_symbols_cost_one_kite_call(self):
        r = market.quotes(["AAA", "BBB"])
        self.assertEqual([x["source"] for x in r["quotes"]], ["zerodha", "zerodha"])
        self.assertEqual(len([u for u in self.kite_calls if "/quote" in u]), 1)
        self.assertEqual(self.nse_calls["quote"], 0)

    def test_not_connected_uses_nse(self):
        self.connect(False)
        q = market.quote("AAA")
        self.assertEqual((q["source"], q["price"]), ("nse", 50.0))
        self.assertEqual(self.kite_calls, [])

    def test_expired_session_uses_nse(self):
        self.now += 7200
        self.assertEqual(market.quote("AAA")["source"], "nse")

    def test_offline_mode_never_uses_kite(self):
        config.settings.offline = True
        self.assertFalse(kitedata.active())

    def test_symbol_kite_does_not_know_falls_back_to_nse(self):
        q = market.quote("ZZZ")
        self.assertEqual((q["source"], q["price"]), ("nse", 50.0))

    def test_kite_failure_falls_back_then_backs_off(self):
        self.kite_fail = (403, json.dumps({"status": "error", "error_type": "PermissionException", "message": "Insufficient permission"}).encode())
        self.assertEqual(market.quote("AAA")["source"], "nse")
        n = len(self.kite_calls)
        store.clear_memory()
        self.assertEqual(market.quote("AAA")["source"], "nse")
        self.assertEqual(len(self.kite_calls), n, "backing off: Kite is not asked again straight away")
        self.assertIn("Insufficient permission", kitedata.status()["reason"])
        self.now += 301
        self.kite_fail = None
        store.clear_memory()
        self.assertEqual(market.quote("AAA")["source"], "zerodha")

    def test_live_feed_marks_its_source_and_takes_indices_from_zerodha(self):
        r = market.live_feed(["AAA"])
        self.assertEqual(r["source"], "zerodha")
        self.assertEqual(r["quotes"][0]["source"], "zerodha")
        self.assertEqual(r["indices"][0]["last"], 25000.0)

    def test_status_never_leaks_credentials(self):
        s = json.dumps(broker.status())
        self.assertNotIn("tok", s.replace("token", ""))
        self.assertEqual(broker.status()["marketData"]["source"], "zerodha")
        self.connect(False)
        self.assertEqual(broker.status()["marketData"]["source"], "nse")


class History(Base):
    def test_history_from_zerodha_when_connected(self):
        h = market.history("AAA", "1Y")
        self.assertEqual(h["source"], "zerodha")
        self.assertEqual(h["points"][0], ["2026-10-01", 11, 1000, 10, 12, 9])
        self.assertEqual(self.nse_calls.get("hist", 0), 0)

    def test_history_falls_back_to_nse(self):
        self.connect(False)
        h = market.history("AAA", "1Y")
        self.assertEqual(h["source"], "nse")
        self.assertGreaterEqual(self.nse_calls["hist"], 1)

    def test_unknown_symbol_history_falls_back(self):
        self.assertEqual(market.history("ZZZ", "1Y")["source"], "nse")


if __name__ == "__main__":
    unittest.main()
