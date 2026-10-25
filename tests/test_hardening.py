"""Rate limiting, load shedding, health/metrics, caching/compression, logging, audit schema v2 and migration, rule consistency.
Offline: servers bind to 127.0.0.1 on ephemeral ports and never contact NSE."""
import gzip
import hashlib
import http.client
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
from pathlib import Path

from marketlens import analysis, config, optiondb, ratelimit, server, store
from marketlens.metrics import metrics

STATIC = Path(server.STATIC)


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class TokenBucketTests(unittest.TestCase):
    def test_burst_then_deny_then_refill(self):
        clock = FakeClock()
        tb = ratelimit.TokenBuckets({"read": (3, 1.0)}, clock=clock)
        self.assertEqual([tb.allow("a", "read")[0] for _ in range(4)], [True, True, True, False])
        ok, retry = tb.allow("a", "read")
        self.assertFalse(ok)
        self.assertAlmostEqual(retry, 1.0, places=2)
        clock.t += 1.0
        self.assertTrue(tb.allow("a", "read")[0])
        self.assertFalse(tb.allow("a", "read")[0])

    def test_clients_and_classes_are_independent(self):
        tb = ratelimit.TokenBuckets({"read": (1, 0.001), "write": (1, 0.001)}, clock=FakeClock())
        self.assertTrue(tb.allow("a", "read")[0])
        self.assertFalse(tb.allow("a", "read")[0])
        self.assertTrue(tb.allow("b", "read")[0])
        self.assertTrue(tb.allow("a", "write")[0])

    def test_memory_is_bounded(self):
        tb = ratelimit.TokenBuckets({"read": (1, 1.0)}, max_keys=50, clock=FakeClock())
        for i in range(500):
            tb.allow(f"client-{i}", "read")
        self.assertLessEqual(tb.size(), 50)


class Served(unittest.TestCase):
    """A real server per test (offline, ephemeral port, temp data folder)."""
    slots = connections = None

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        s = config.settings
        self.saved = (s.offline, s.news, s.option_interval, s.rate_limit, s.max_inflight, s.max_connections, s.log_requests, s.host, s.port, s.data_dir)
        s.data_dir, s.offline, s.news, s.option_interval, s.rate_limit = Path(self.tmp.name), True, False, 0, True
        s.require_login = False
        s.max_inflight, s.max_connections, s.log_requests, s.host, s.port = self.slots or 64, self.connections or 256, False, "127.0.0.1", 0
        store.clear_memory()
        self.httpd = server.make_server()
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close()
        optiondb.close()
        s = config.settings
        (s.offline, s.news, s.option_interval, s.rate_limit, s.max_inflight, s.max_connections, s.log_requests, s.host, s.port, s.data_dir) = self.saved
        self.tmp.cleanup()

    def request(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, hdrs, data

    def json(self, path, **kw):
        s, h, d = self.request("GET", path, **kw)
        return s, h, json.loads(d)


class RateLimitAndShedding(Served):
    def test_429_with_retry_after_and_one_audit_row_per_flood(self):
        server._limiter = ratelimit.TokenBuckets({"static": (1000, 1e6), "read": (3, 0.001), "expensive": (40, 4.0), "write": (10, 0.5)})
        statuses = [self.request("GET", "/api/config")[0] for _ in range(60)]
        self.assertEqual(statuses[:3], [200, 200, 200])
        self.assertTrue(all(s == 429 for s in statuses[3:]))
        s, h, d = self.json("/api/config")
        self.assertEqual(s, 429)
        self.assertGreaterEqual(int(h["retry-after"]), 1)
        self.assertEqual((d["error"], d["trafficClass"]), ("rate limit exceeded; slow down", "read"))
        self.assertIn("requestId", d)
        audit = [e for e in optiondb.audit_log(50) if e["event"] == "rate_limited"]
        self.assertEqual(len(audit), 1)                       # 58 rejected requests, one audit row
        self.assertEqual(audit[0]["outcome"], "denied")
        self.assertGreaterEqual(metrics.snapshot()["counters"]["rate_limited"], 58)

    def test_a_flood_of_rejections_does_not_flood_the_log(self):
        import io, contextlib
        config.settings.log_requests = True
        server._limiter = ratelimit.TokenBuckets({"static": (1000, 1e6), "read": (2, 0.001), "expensive": (40, 4.0), "write": (10, 0.5)})
        server._audit_gate.clear()
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            for _ in range(200):
                self.request("GET", "/api/config")
        lines = [json.loads(x) for x in buf.getvalue().splitlines() if x.startswith("{")]
        self.assertLess(len(lines), 10)                                  # 2 allowed + a few summaries, not 200 lines
        self.assertTrue(any(x.get("suppressedSinceLast", 0) >= 0 and x["status"] == 429 for x in lines))

    def test_health_probes_are_exempt_and_limits_can_be_disabled(self):
        server._limiter = ratelimit.TokenBuckets({"static": (1, 0.001), "read": (1, 0.001), "expensive": (1, 0.001), "write": (1, 0.001)})
        self.assertTrue(all(self.request("GET", "/healthz")[0] == 200 for _ in range(20)))
        config.settings.rate_limit = False
        self.assertTrue(all(self.request("GET", "/api/config")[0] == 200 for _ in range(20)))

    def test_a_broken_limiter_fails_open(self):
        class Broken:
            limits = {}
            def allow(self, *a): raise RuntimeError("bug")
            def size(self): return 0
        server._limiter = Broken()
        self.assertEqual(self.request("GET", "/api/config")[0], 200)

    def test_post_is_rate_limited_separately(self):
        server._limiter = ratelimit.TokenBuckets({"static": (1000, 1e6), "read": (1000, 1e6), "expensive": (40, 4.0), "write": (2, 0.001)})
        h = {"Content-Type": "text/csv", "X-Requested-With": "MarketLens"}
        codes = [self.request("POST", "/api/options/import", b"bad", h)[0] for _ in range(4)]
        self.assertEqual(codes, [400, 400, 429, 429])


class LoadShedding(Served):
    slots = 1

    def test_503_when_too_many_requests_are_in_flight(self):
        self.assertTrue(self.httpd.slots.acquire(blocking=False))   # occupy the only slot, as a slow request would
        try:
            s, h, d = self.json("/api/config")
            self.assertEqual((s, h["retry-after"], d["error"]), (503, "1", "server busy; retry shortly"))
        finally:
            self.httpd.slots.release()
        self.assertEqual(self.request("GET", "/api/config")[0], 200)
        self.assertEqual(len([e for e in optiondb.audit_log(20) if e["event"] == "load_shed"]), 1)


class ConnectionCap(Served):
    connections = 1

    def test_extra_connections_are_refused_not_queued_forever(self):
        a = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        a.request("GET", "/healthz"); self.assertEqual(a.getresponse().read()[:1], b"{")   # holds the only connection slot (keep-alive)
        b = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        with self.assertRaises((http.client.RemoteDisconnected, ConnectionError, OSError)):
            b.request("GET", "/healthz"); b.getresponse()
        b.close(); a.close()
        for _ in range(50):   # the slot frees once the first client disconnects
            if self.request("GET", "/healthz")[0] == 200:
                break
            time.sleep(0.05)
        else:
            self.fail("connection slot never freed")


class Protocol(Served):
    def test_keep_alive_serves_many_requests_on_one_connection(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        for _ in range(5):
            c.request("GET", "/api/config")
            r = c.getresponse(); r.read()
            self.assertEqual((r.status, r.version), (200, 11))
            self.assertNotEqual((r.getheader("Connection") or "").lower(), "close")
        c.close()

    def test_request_id_is_echoed_or_generated_and_untrusted_values_are_ignored(self):
        self.assertEqual(self.request("GET", "/healthz", headers={"X-Request-ID": "trace-abc12345"})[1]["x-request-id"], "trace-abc12345")
        generated = self.request("GET", "/healthz", headers={"X-Request-ID": "bad id\twith spaces"})[1]["x-request-id"]
        self.assertRegex(generated, r"^[0-9a-f]{16}$")

    def test_gzip_etag_and_conditional_requests(self):
        raw = (STATIC / "js" / "app.js").read_bytes()
        s, h, body = self.request("GET", "/js/app.js", headers={"Accept-Encoding": "gzip"})
        self.assertEqual((s, h["content-encoding"], h["vary"]), (200, "gzip", "Accept-Encoding"))
        self.assertEqual(gzip.decompress(body), raw)
        self.assertLess(len(body), len(raw) / 2)
        s, h, body = self.request("GET", "/js/app.js")
        self.assertNotIn("content-encoding", h)
        self.assertEqual(body, raw)
        self.assertEqual(h["content-type"], "text/javascript; charset=utf-8")
        s, h304, body = self.request("GET", "/js/app.js", headers={"If-None-Match": h["etag"]})
        self.assertEqual((s, body), (304, b""))
        self.assertEqual((h304["cache-control"], h304["etag"]), ("no-cache", h["etag"]))

    def test_large_json_is_compressed_small_is_not(self):
        store.disk_put("bootstrap", {"asOf": "x", "stocks": [{"sym": f"S{i}", "sector": "IT", "price": 100.0, "prev": 99.0} for i in range(300)], "indices": [], "valuation": []})
        s, h, body = self.request("GET", "/api/bootstrap", headers={"Accept-Encoding": "gzip"})
        self.assertEqual((s, h.get("content-encoding")), (200, "gzip"))
        self.assertEqual(len(json.loads(gzip.decompress(body))["stocks"]), 300)
        self.assertNotIn("content-encoding", self.request("GET", "/healthz", headers={"Accept-Encoding": "gzip"})[1])

    def test_no_directory_listings_and_methods(self):
        for p in ("/js/", "/js", "/css/", "/static/", "/"):
            s, _, body = self.request("GET", p)
            if p == "/":
                self.assertEqual(s, 200)
            else:
                self.assertEqual(s, 404, p)
                self.assertNotIn(b"Directory listing", body)
        s, h, body = self.request("HEAD", "/")
        self.assertEqual((s, body), (200, b""))
        self.assertGreater(int(h["content-length"]), 0)
        s, h, _ = self.request("PUT", "/api/config", b"x")
        self.assertEqual((s, h["allow"]), (405, "GET, HEAD, POST"))

    def test_rejected_post_closes_the_connection_so_the_unread_body_cannot_poison_the_next_request(self):
        s, h, _ = self.request("POST", "/api/options/import", b"x" * 100, {"Content-Type": "text/csv"})
        self.assertEqual((s, h.get("connection")), (403, "close"))

    def test_unexpected_errors_return_500_without_internals(self):
        original = server.Handler._static
        server.Handler._static = lambda self, path: (_ for _ in ()).throw(ValueError("secret internal detail"))
        try:
            s, h, d = self.json("/")
        finally:
            server.Handler._static = original
        self.assertEqual(s, 500)
        self.assertEqual(d["error"], "internal error")
        self.assertNotIn("secret", json.dumps(d))
        self.assertEqual(d["requestId"], h["x-request-id"])
        self.assertGreaterEqual(metrics.snapshot()["counters"]["internal_errors"], 1)

    def test_security_headers_on_every_kind_of_response(self):
        for path in ("/", "/api/config", "/nope", "/healthz"):
            h = self.request("GET", path)[1]
            for name in ("content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy", "cross-origin-resource-policy", "permissions-policy", "x-request-id"):
                self.assertIn(name, h, (path, name))


class HealthAndMetrics(Served):
    def test_liveness_and_readiness(self):
        s, _, d = self.json("/healthz")
        self.assertEqual((s, d["status"]), (200, "ok"))
        s, _, d = self.json("/readyz")                       # offline and no saved snapshot: cannot show data
        self.assertEqual((s, d["ready"], d["checks"]["dataAvailable"]), (503, False, False))
        store.disk_put("bootstrap", {"stocks": []})
        s, _, d = self.json("/readyz")
        self.assertEqual((s, d["ready"]), (200, True))
        self.assertTrue(d["checks"]["database"] and d["checks"]["dataDirWritable"])

    def test_metrics_have_bounded_route_labels_and_percentiles(self):
        for i in range(30):
            self.request("GET", f"/api/stock/SYM{i}")        # 30 different symbols
            self.request("GET", f"/missing-{i}.js")          # 30 different missing files
        s, _, d = self.json("/api/metrics")
        self.assertEqual(s, 200)
        routes = d["routes"]
        self.assertIn("/api/stock/:sym", routes)
        self.assertIn("/static", routes)
        self.assertFalse([r for r in routes if "SYM" in r or "missing" in r])
        r = routes["/api/stock/:sym"]
        self.assertTrue(r["p50_ms"] <= r["p95_ms"] <= r["p99_ms"] <= r["max_ms"])
        self.assertGreaterEqual(r["statuses"]["5xx"], 30)
        self.assertIn("dataAgeSeconds", d)
        self.assertEqual(d["upstream"]["nseOffline"], True)

    def test_structured_log_line_has_request_id_and_no_query_or_body(self):
        import io, contextlib
        config.settings.log_requests = True
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            self.request("GET", "/api/search?q=SECRETQUERY", headers={"X-Request-ID": "log-test-0001"})
        line = [json.loads(x) for x in buf.getvalue().splitlines() if x.startswith("{")][-1]
        self.assertEqual((line["requestId"], line["route"], line["method"]), ("log-test-0001", "/api/search", "GET"))
        self.assertIn("ms", line)
        self.assertNotIn("SECRETQUERY", buf.getvalue())


class WebVitals(Served):
    H = {"Content-Type": "text/plain", "X-Requested-With": "MarketLens"}

    def test_valid_samples_are_stored_and_summarised(self):
        for lcp in (800, 1200, 2400):
            s, _, d = self.request("POST", "/api/vitals", json.dumps({"ttfb": 5.5, "lcp": lcp, "cls": 0.01}).encode(), self.H)
            self.assertEqual(s, 202)
            self.assertEqual(json.loads(d)["accepted"], 3)
        v = self.json("/api/metrics")[2]["webVitals"]
        self.assertEqual(v["lcp"]["samples"], 3)
        self.assertEqual(v["lcp"]["p50"], 1200.0)

    def test_hostile_or_malformed_samples_are_ignored_not_stored(self):
        before = metrics.snapshot()["webVitals"].get("lcp", {}).get("samples", 0)
        body = json.dumps({"lcp": -5, "cls": 1e9, "inp": "fast", "ttfb": True, "evil": "<script>", "fcp": float("nan")}).encode()
        s, _, d = self.request("POST", "/api/vitals", body, self.H)
        self.assertEqual((s, json.loads(d)["accepted"]), (202, 0))
        self.assertEqual(self.request("POST", "/api/vitals", b"not json", self.H)[0], 400)
        self.assertEqual(self.request("POST", "/api/vitals", b"[1,2]", self.H)[0], 400)
        self.assertEqual(self.request("POST", "/api/vitals", b"x" * 5000, self.H)[0], 413)
        self.assertEqual(self.request("POST", "/api/vitals", b"{}", {"Content-Type": "text/plain"})[0], 403)
        self.assertEqual(metrics.snapshot()["webVitals"].get("lcp", {}).get("samples", 0), before)

    def test_memory_is_bounded(self):
        for i in range(700):
            metrics.observe_vitals({"inp": float(i)})
        self.assertEqual(metrics.snapshot()["webVitals"]["inp"]["samples"], 500)


class AuditSchemaV2(Served):
    CSV = "CALLS,,PUTS\n,OI,STRIKE,OI\n" + "".join(f",{o},{k},{o}\n" for o, k in ((10, 100), (20, 110), (30, 120)))

    def test_import_audit_row_carries_request_id_uid_outcome_channel(self):
        s, h, _ = self.request("POST", "/api/options/import?symbol=NIFTY&expiry=27-Oct-2026&filename=a.csv", self.CSV.encode(), {"Content-Type": "text/csv", "X-Requested-With": "MarketLens"})
        self.assertEqual(s, 200)
        e = [x for x in optiondb.audit_log(20) if x["event"] == "import_ok"][0]
        self.assertEqual((e["requestId"], e["channel"], e["outcome"], e["schemaVer"]), (h["x-request-id"], "web", "ok", 2))
        self.assertEqual(len(e["uid"]), 32)
        self.assertEqual(len({x["uid"] for x in optiondb.audit_log(50)}), len(optiondb.audit_log(50)))   # uids are unique
        self.assertEqual([x for x in optiondb.audit_log(50) if x["event"] == "startup"][0]["channel"], "system")
        self.assertTrue(optiondb.verify_audit()["ok"])

    def test_audit_endpoint_replaces_the_old_option_route(self):
        s, _, d = self.json("/api/audit?limit=5")
        self.assertTrue(d["verify"]["ok"])
        self.assertEqual(self.request("GET", "/api/options/audit")[0], 404)


class AuditMigrationAndCoupling(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        config.settings.data_dir = Path(self.tmp.name)

    def tearDown(self):
        optiondb.close()
        self.tmp.cleanup()

    def make_v1_database(self):
        """A database exactly as the previous release wrote it (no v2 columns, original hash formula)."""
        c = sqlite3.connect(optiondb.db_path(), isolation_level=None)
        c.executescript("""CREATE TABLE audit_log (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, event TEXT NOT NULL, actor TEXT NOT NULL, symbol TEXT,
            snapshot_id INTEGER, detail TEXT NOT NULL, sha256 TEXT, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL);
            CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;""")
        prev = "0" * 64
        for i, (event, detail) in enumerate((("import_ok", "NIFTY 27-Oct-2026 from csv:a.csv: 15 strikes"), ("scan", "inbox {}")), 1):
            ts = f"2026-10-25T10:0{i}:00+00:00"
            h = hashlib.sha256("|".join([prev, ts, event, "inbox", "NIFTY", str(i), detail, ""]).encode()).hexdigest()   # the v1 formula
            c.execute("INSERT INTO audit_log (ts,event,actor,symbol,snapshot_id,detail,sha256,prev_hash,entry_hash) VALUES (?,?,?,?,?,?,?,?,?)", (ts, event, "inbox", "NIFTY", i, detail, None, prev, h))
            prev = h
        c.close()

    def test_old_database_is_migrated_and_the_chain_still_verifies_across_versions(self):
        self.make_v1_database()
        optiondb.audit("note", "test", "first v2 entry")           # opens the database: migration runs here
        cols = {r[1] for r in optiondb._db().execute("PRAGMA table_info(audit_log)")}
        self.assertTrue({"schema_ver", "uid", "outcome", "request_id", "channel"} <= cols)
        self.assertEqual([e["schemaVer"] for e in reversed(optiondb.audit_log(10))], [1, 1, 2])
        self.assertEqual(optiondb.verify_audit(), {"ok": True, "entries": 3, "firstBadId": None})
        optiondb.close(); optiondb.audit("note", "test", "after reopening")      # migration is idempotent
        self.assertTrue(optiondb.verify_audit()["ok"])

    def test_tampering_with_a_pre_migration_row_is_still_detected(self):
        self.make_v1_database()
        optiondb.audit("note", "test", "x")
        c = optiondb._db()
        c.execute("DROP TRIGGER audit_no_update")
        c.execute("UPDATE audit_log SET detail='edited' WHERE id=1")
        self.assertEqual(optiondb.verify_audit()["firstBadId"], 1)

    def test_an_import_cannot_succeed_without_its_audit_record(self):
        original = optiondb._audit_row
        def failing(c, event, *a, **k):
            if event == "import_ok":
                raise sqlite3.OperationalError("disk full")
            return original(c, event, *a, **k)
        optiondb._audit_row = failing
        try:
            with self.assertRaises(sqlite3.OperationalError):
                optiondb.import_csv(AuditSchemaV2.CSV, "test", "option-chain-NIFTY-27-Oct-2026.csv")
        finally:
            optiondb._audit_row = original
        self.assertEqual(optiondb.snapshots(), [])                 # rolled back: no snapshot without its audit row
        self.assertEqual(optiondb._db().execute("SELECT COUNT(*) FROM option_rows").fetchone()[0], 0)
        self.assertEqual(optiondb.import_csv(AuditSchemaV2.CSV, "test", "option-chain-NIFTY-27-Oct-2026.csv")["status"], "stored")   # and a retry works

    def test_safe_audit_reports_failures_on_stderr_instead_of_raising(self):
        import io, contextlib
        original = optiondb._audit_row
        optiondb._audit_row = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        buf = io.StringIO()
        try:
            with contextlib.redirect_stderr(buf):
                self.assertFalse(optiondb.safe_audit("rate_limited", "server", "x"))
        finally:
            optiondb._audit_row = original
        self.assertEqual(json.loads(buf.getvalue())["msg"], "audit_write_failed")


class RulesAreTheSingleSourceOfTruth(unittest.TestCase):
    def test_changing_a_rule_changes_the_behaviour(self):
        up = [100 + i for i in range(70)]
        saved = dict(analysis.RULES)
        try:
            self.assertEqual(analysis.technical_from_history(up)["label"], "Bullish")
            analysis.RULES["techBand"] = 5.0                       # nothing can reach +/-5
            self.assertEqual(analysis.technical_from_history(up)["label"], "Neutral")
            analysis.RULES["techBand"] = saved["techBand"]
            self.assertEqual(analysis.sentiment_label(0.5, 3, 0), "Positive")
            analysis.RULES["sentNet"] = 4
            self.assertEqual(analysis.sentiment_label(0.5, 3, 0), "Neutral")
            analysis.RULES["sentNet"] = saved["sentNet"]
            self.assertEqual(analysis.technical_snapshot({"price": 100, "prev": 100, "pct30": 6})["signals"][0]["value"], 1)
            analysis.RULES["snapMomentumPct"] = 10
            self.assertEqual(analysis.technical_snapshot({"price": 100, "prev": 100, "pct30": 6})["signals"][0]["value"], 0)
        finally:
            analysis.RULES.clear(); analysis.RULES.update(saved)

    def test_config_endpoint_publishes_the_rules(self):
        self.assertEqual(server.config_payload()["rules"], analysis.RULES)
        for key in ("techBand", "rsiBullLow", "rsiBullHigh", "sentBand", "sentNet", "incYieldMult"):
            self.assertIn(key, analysis.RULES)


if __name__ == "__main__":
    unittest.main()
