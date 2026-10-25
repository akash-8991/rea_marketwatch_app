"""The stock list (names, industries), its database copy and weekly refresh, and the peer comparison. Offline."""
import tempfile
import time
import unittest
from pathlib import Path

from marketlens import config, market, nse, optiondb, securities, server, store

FULL = Path(securities.BUNDLED).read_text(encoding="utf-8")


class Isolated(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        s = config.settings
        self.saved = (s.data_dir, s.offline)
        s.data_dir, s.offline = Path(self.tmp.name), False
        securities.load_bundled()
        store.clear_memory()

    def tearDown(self):
        optiondb.close()
        config.settings.data_dir, config.settings.offline = self.saved
        securities.load_bundled()
        store.clear_memory()
        self.tmp.cleanup()

    def fetcher(self, respond):
        asked = []

        def fetch(url, timeout=20):
            asked.append(url)
            r = respond(url)
            if isinstance(r, Exception):
                raise r
            return r
        return fetch, asked


class ListFile(Isolated):
    def test_bundled_list(self):
        self.assertEqual(len(securities.ROWS), 755)
        self.assertEqual(len(set(securities.SECTOR_MAP.values())), 22)
        self.assertEqual(securities.get("infy")["company"], "Infosys Ltd.")
        self.assertIs(market.SECTOR_MAP, securities.SECTOR_MAP)

    def test_unusable_downloads_are_refused(self):
        for bad in ("a,b\n1,2", "Company Name,Industry,Symbol\nX,Y,Z\n", "<html>blocked</html>"):
            with self.assertRaises(securities.ListError):
                securities.parse(bad)

    def test_first_use_seeds_the_database_and_later_starts_read_it(self):
        self.assertEqual(securities.load(), "bundled")
        self.assertEqual(securities.status()["count"], 755)
        securities.ROWS.clear(); securities.SECTOR_MAP.clear()
        self.assertEqual(securities.load(), "database")
        self.assertEqual(len(securities.ROWS), 755)

    def test_name_search(self):
        self.assertEqual(securities.search_names("infosys")[0]["symbol"], "INFY")
        self.assertEqual(securities.search_names("tata consultancy")[0]["symbol"], "TCS")
        self.assertEqual(securities.search_names("zz"), [])


class WeeklyRefresh(Isolated):
    def test_refresh_replaces_the_list_in_place_saves_it_and_audits(self):
        securities.load()
        changed = FULL.replace("ICICILIFE", "NEWSYMBOL1")
        fetch, asked = self.fetcher(lambda u: changed)
        before = securities.SECTOR_MAP                      # the same dict object must keep working
        r = securities.refresh(force=True, fetch=fetch)
        self.assertEqual((r["added"], r["removed"]), (["NEWSYMBOL1"], ["ICICILIFE"]))
        self.assertIs(securities.SECTOR_MAP, before); self.assertIn("NEWSYMBOL1", market.SECTOR_MAP)
        self.assertEqual(asked, [securities.SOURCES[0]])
        securities.ROWS.clear(); securities.SECTOR_MAP.clear()
        securities.load()                                     # a restart reads the saved copy
        self.assertIn("NEWSYMBOL1", securities.ROWS)
        self.assertTrue(any(e["event"] == "securities_updated" for e in optiondb.audit_log(20)))
        self.assertTrue(optiondb.verify_audit()["ok"])

    def test_not_repeated_inside_the_week_and_not_when_offline(self):
        securities.load()
        fetch, asked = self.fetcher(lambda u: FULL)
        securities.refresh(force=True, fetch=fetch)
        self.assertIn("skipped", securities.refresh(fetch=fetch)); self.assertEqual(len(asked), 1)
        self.assertTrue(securities.due(time.time() + securities.REFRESH_EVERY + 5))
        config.settings.offline = True
        self.assertEqual(securities.refresh(force=True, fetch=fetch), {"skipped": "offline mode"}); self.assertEqual(len(asked), 1)

    def test_second_source_then_keep_saved_list_when_both_fail(self):
        securities.load()
        fetch, _ = self.fetcher(lambda u: OSError("403") if u == securities.SOURCES[0] else FULL)
        self.assertEqual(securities.refresh(force=True, fetch=fetch)["source"], "www.niftyindices.com")
        fetch2, asked2 = self.fetcher(lambda u: "Company Name,Industry,Symbol\nA,B,C\n")
        r = securities.refresh(force=True, fetch=fetch2)
        self.assertIn("download failed", r["skipped"]); self.assertEqual(len(securities.ROWS), 755); self.assertEqual(len(asked2), 2)
        self.assertTrue(any(e["event"] == "securities_update_failed" for e in optiondb.audit_log(20)))
        self.assertIn("skipped", securities.refresh(fetch=fetch2))   # a dead link is retried next week, not on every start


class Peers(Isolated):
    def setUp(self):
        super().setUp()
        self.calls = {"bulk": 0, "quote": []}
        self.orig = (nse.bh, nse.cm)

        def bh(tool, args=None):
            self.calls["bulk"] += 1
            return {"quotes": [{"symbol": s, "close": 100, "volume": (len(args["symbols"]) - i) * 1000} for i, s in enumerate(args["symbols"])]}

        def cm(tool, args=None):
            self.calls["quote"].append(args["symbol"])
            return {"stock": {"lastTradedPrice": 105, "preClosePrice": 100, "perChange": 5, "volume": 777, "value": 1.5, "latestTimestamp": "2026-10-26 10:42:11"}}
        nse.bh, nse.cm = bh, cm

    def tearDown(self):
        nse.bh, nse.cm = self.orig
        super().tearDown()

    def test_same_industry_ranked_with_company_names_and_live_prices(self):
        p = market.peers("INFY")
        self.assertEqual((p["company"], p["industry"], p["count"]), ("Infosys Ltd.", "Information Technology", 40))
        self.assertEqual(len(p["peers"]), 10); self.assertNotIn("INFY", [x["sym"] for x in p["peers"]])
        self.assertTrue(all(x["name"] != x["sym"] for x in p["peers"]))
        self.assertEqual((p["self"]["sym"], p["self"]["price"], p["self"]["chg"]), ("INFY", 105, 5))
        self.assertEqual(self.calls["bulk"], 1); self.assertEqual(len(self.calls["quote"]), 11)
        market.peers("INFY")
        self.assertEqual(len(self.calls["quote"]), 11, "cached for a minute")

    def test_unknown_symbol_and_nse_down(self):
        self.assertEqual(market.peers("NOPEXYZ")["peers"], [])
        nse.bh = nse.cm = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("down"))
        p = market.peers("WIPRO")
        self.assertTrue(p["stale"]); self.assertEqual(len(p["peers"]), 10); self.assertTrue(all(x["name"] for x in p["peers"]))

    def test_search_finds_by_company_name(self):
        r = market.search("infosys")
        self.assertTrue(any(x["symbol"] == "INFY" and x.get("name") == "Infosys Ltd." and x["source"] == "list" for x in r["results"]))


if __name__ == "__main__":
    unittest.main()
