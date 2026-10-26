"""Desktop home data: answered from the saved copy at once and refreshed in the background (so a first load after the app was closed never waits for NSE)."""
import tempfile
import threading
import time
import unittest
from pathlib import Path

from marketlens import config, market, nse, optiondb, server, store


def snapshot(day):
    return {"asOf": day, "fetchedAt": f"{day}T10:00:00", "indices": [], "valuation": [], "sectorIndices": [], "mood": {}, "breadth": {},
            "stocks": [{"sym": "TCS", "price": 100.0, "prev": 99.0, "ts": f"{day} 16:00:28"}]}


class BootstrapSWR(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); optiondb.close()
        self.saved = (config.settings.data_dir, config.settings.offline, market.build_bootstrap, nse._breaker.copy(), dict(server._boot))
        config.settings.data_dir, config.settings.offline = Path(self.tmp.name), False
        nse._breaker.update(until=0.0, reason=""); server._boot.update(thread=None, error=None, failed_at=0.0); store.clear_memory()
        store.disk_put("bootstrap", snapshot("2026-10-23"))

    def tearDown(self):
        optiondb.close(); config.settings.data_dir, config.settings.offline, market.build_bootstrap = self.saved[:3]
        nse._breaker.update(self.saved[3]); server._boot.update(self.saved[4]); store.clear_memory(); self.tmp.cleanup()

    def wait_done(self):
        for _ in range(200):
            if server._boot["thread"] is None:
                return
            time.sleep(0.01)
        self.fail("refresh never finished")

    def test_saved_copy_answers_at_once_then_fresh_data_arrives(self):
        release = threading.Event()

        def slow():
            release.wait(5)
            return snapshot("2026-10-26")
        market.build_bootstrap = slow
        t0 = time.time(); a = server.bootstrap_payload()
        self.assertLess(time.time() - t0, 0.5, "did not wait for NSE")
        self.assertEqual((a["asOf"], a["refreshing"], a["stale"]), ("2026-10-23", True, False))
        release.set(); self.wait_done()
        b = server.bootstrap_payload()
        self.assertEqual((b["asOf"], b["refreshing"], b["stale"]), ("2026-10-26", False, False))

    def test_failure_is_reported_once_and_not_retried_every_request(self):
        calls = []

        def boom():
            calls.append(1); raise RuntimeError("NSE exploded")
        market.build_bootstrap = boom
        server.bootstrap_payload(); self.wait_done()
        b = server.bootstrap_payload()
        self.assertTrue(b["stale"]); self.assertIn("exploded", b["staleReason"]); self.assertEqual(b["asOf"], "2026-10-23")
        for _ in range(5):
            server.bootstrap_payload()
        self.assertEqual(len(calls), 1, "a failing NSE is retried at most once a minute")

    def test_offline_and_first_run(self):
        config.settings.offline = True
        o = server.bootstrap_payload(); self.assertTrue(o["stale"]); self.assertFalse(o["refreshing"]); self.assertIn("offline", o["staleReason"])
        config.settings.offline = False; store.disk_put("bootstrap", None) if False else None
        import os; os.remove(store._path("bootstrap"))
        market.build_bootstrap = lambda: snapshot("2026-10-26")
        first = server.bootstrap_payload()                          # nothing saved: the first data is waited for
        self.assertEqual((first["asOf"], first["refreshing"]), ("2026-10-26", False))


if __name__ == "__main__":
    unittest.main()
