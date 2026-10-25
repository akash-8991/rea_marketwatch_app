"""HTTP-level tests against a real server on an ephemeral port (offline mode, no network)."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from marketlens import config, optiondb, server, store


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        config.settings.data_dir = Path(cls.tmp.name)
        config.settings.offline = True
        config.settings.news = False
        config.settings.fo_url = ""
        config.settings.option_interval = 0
        config.settings.require_login = False
        config.settings.log_requests = False
        config.settings.host, config.settings.port = "127.0.0.1", 0
        store.clear_memory()
        store.disk_put("bootstrap", {"asOf": "2026-10-23", "fetchedAt": "2026-10-25T10:00:00", "indices": [], "valuation": [], "sectorIndices": [],
                                     "mood": {}, "breadth": {}, "stocks": [{"sym": "TCS", "sector": "IT", "price": 2530.0, "prev": 2506.9, "hi52": 3000.0, "lo52": 2200.0, "pct30": 4.0, "valueCr": 1700.0}]})
        cls.httpd = server.make_server()
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        optiondb.close()
        config.settings.offline = False
        config.settings.news = True
        cls.tmp.cleanup()

    def get(self, path):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", path)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, dict(r.getheaders()), body

    def test_index_and_static_files(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"MarketLens", body)
        self.assertEqual(self.get("/js/app.js")[0], 200)
        self.assertEqual(self.get("/css/style.css")[0], 200)

    def test_missing_file_is_a_clean_404_not_a_dropped_connection(self):
        self.assertEqual(self.get("/nope.html")[0], 404)

    def test_path_traversal_never_serves_files(self):
        for p in ("/../../etc/passwd", "/js/../../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"):
            status, _, body = self.get(p)
            self.assertIn(status, (400, 404), p)
            self.assertNotIn(b"root:", body)

    def test_static_files_revalidate_but_api_is_not_cached(self):
        self.assertEqual(self.get("/js/app.js")[1]["Cache-Control"], "no-cache")
        self.assertEqual(self.get("/api/config")[1]["Cache-Control"], "no-store")

    def test_security_headers(self):
        _, headers, _ = self.get("/")
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_bootstrap_serves_saved_snapshot_flagged_stale_with_snapshot_technicals(self):
        status, _, body = self.get("/api/bootstrap")
        d = json.loads(body)
        self.assertEqual(status, 200)
        self.assertTrue(d["stale"])
        self.assertTrue(d["offline"])
        self.assertIn(d["stocks"][0]["techSnap"]["label"], ("Bullish", "Neutral", "Bearish"))

    def test_api_validation_and_errors(self):
        self.assertEqual(self.get("/api/stock/..%2f..%2fetc")[0], 400)
        self.assertEqual(self.get("/api/options?symbol=%3Cscript%3E")[0], 400)
        self.assertEqual(self.get("/api/nothing")[0], 404)
        status, _, body = self.get("/api/stock/NOSUCH")  # offline and not cached: clean error JSON
        self.assertEqual(status, 502)
        self.assertIn("error", json.loads(body))

    def test_search_uses_saved_symbols(self):
        d = json.loads(self.get("/api/search?q=tc")[2])
        self.assertEqual([r["symbol"] for r in d["results"]], ["TCS"])

    def test_option_chain_unconfigured_is_explicit(self):
        d = json.loads(self.get("/api/options?symbol=NIFTY")[2])
        self.assertFalse(d["available"])
        self.assertIn("fo-mcp-url", d["reason"])

    def test_news_disabled_returns_empty_not_error(self):
        d = json.loads(self.get("/api/news/india")[2])
        self.assertTrue(d["disabled"])
        self.assertEqual(d["items"], [])


if __name__ == "__main__":
    unittest.main()
