"""Option-chain database, CSV import, audit log, inbox scheduler, fake MCP endpoint, and MCP stdio server.
All offline: the only network is a fake MCP server on 127.0.0.1 started by the tests."""
import http.client
import http.server
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from marketlens import config, nse, optiondb, options, options_mcp, scheduler, server, store

# NSE's download layout: CALLS | STRIKE | PUTS, numbers quoted with thousands separators, "-" for blanks.
CSV = """CALLS,,,,,,,,,,,,PUTS,,,,,,,,,
,OI,CHNG IN OI,VOLUME,IV,LTP,CHNG,BID QTY,BID,ASK,ASK QTY,STRIKE,BID QTY,BID,ASK,ASK QTY,CHNG,LTP,IV,VOLUME,CHNG IN OI,OI,
,"1,200",100,"5,000",12.5,180.5,5.0,50,180,181,60,"22,500",70,60,61,80,-3.0,60.5,13.1,"4,000",-50,"3,000",
,"2,000",-,"9,000",11.0,120.0,-2.5,50,119,121,60,"22,600",70,110,111,80,1.0,110.0,12.0,"8,000",200,"2,000",
,"4,000",300,"2,500",-,70.0,1.0,50,69,71,60,"22,700",70,170,171,80,2.0,168.0,12.9,"1,000",10,"1,000",
"""
NAME = "option-chain-ED-NIFTY-27-Oct-2026.csv"


class Fresh(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        config.settings.data_dir = Path(self.tmp.name)
        config.settings.option_inbox = ""
        config.settings.offline = False
        config.settings.fo_url = ""
        nse._breaker.update(until=0.0, reason="")
        store.clear_memory()

    def tearDown(self):
        optiondb.close()
        config.settings.fo_url = ""
        self.tmp.cleanup()


class CsvTests(Fresh):
    def test_parses_nse_layout(self):
        p = optiondb.parse_csv(CSV, NAME)
        self.assertEqual((p["symbol"], p["expiry"]), ("NIFTY", "27-Oct-2026"))
        self.assertEqual([r["strike"] for r in p["rows"]], [22500.0, 22600.0, 22700.0])
        r = p["rows"][0]
        self.assertEqual((r["ce"]["oi"], r["ce"]["vol"], r["ce"]["ltp"], r["ce"]["iv"]), (1200.0, 5000.0, 180.5, 12.5))
        self.assertEqual((r["pe"]["oi"], r["pe"]["chgOi"], r["pe"]["ltp"]), (3000.0, -50.0, 60.5))
        self.assertIsNone(p["rows"][1]["ce"]["chgOi"])  # "-" means no value
        self.assertIsNone(p["rows"][2]["ce"]["iv"])

    def test_explicit_symbol_and_expiry_override_and_normalise(self):
        p = optiondb.parse_csv(CSV, "download.csv", symbol="banknifty", expiry="05-nov-2026")
        self.assertEqual((p["symbol"], p["expiry"]), ("BANKNIFTY", "5-Nov-2026"))

    def test_rejects_bad_files_with_a_reason(self):
        for text, fragment in (("a,b\n1,2\n", "STRIKE"), ("CALLS,,PUTS\n,OI,STRIKE,OI\n,1,100,2\n", "fewer than 3"), ("x" * (optiondb.MAX_CSV_BYTES + 1), "2 MB")):
            with self.assertRaises(optiondb.CsvError) as cm:
                optiondb.parse_csv(text, NAME)
            self.assertIn(fragment, str(cm.exception))
        with self.assertRaises(optiondb.CsvError) as cm:
            optiondb.parse_csv(CSV, "download.csv")  # nothing says which symbol/expiry
        self.assertIn("symbol and expiry", str(cm.exception))

    def test_formula_injection_and_markup_are_just_text(self):
        evil = CSV.replace("CALLS,,,", "=CMD|' /C calc'!A0,,,", 1).replace("22,600", "22600")
        p = optiondb.parse_csv(evil, NAME)  # header text outside the table is ignored, never evaluated
        self.assertEqual(len(p["rows"]), 3)
        with self.assertRaises(optiondb.CsvError):
            optiondb.parse_csv(CSV, "x.csv", symbol="<script>", expiry="27-Oct-2026")


class StoreAndAuditTests(Fresh):
    def test_store_dedupes_and_reads_back_with_summary(self):
        self.assertEqual(optiondb.import_csv(CSV, "test", NAME)["status"], "stored")
        self.assertEqual(optiondb.import_csv(CSV, "test", NAME)["status"], "duplicate")
        self.assertEqual(len(optiondb.snapshots()), 1)
        snap = optiondb.latest("nifty")
        self.assertEqual(snap["expiries"], ["27-Oct-2026"])
        self.assertAlmostEqual(snap["summary"]["pcr"], 6000 / 7200, places=3)
        self.assertEqual(snap["summary"]["ceOi"], 7200)
        self.assertTrue(snap["spotEstimated"])
        self.assertEqual(snap["spot"], 22610.0)  # closest call/put pair is strike 22600 (120 vs 110): 22600 + 120 - 110
        self.assertIsNone(optiondb.latest("BANKNIFTY"))

    def test_estimate_spot_from_put_call_parity(self):
        rows = [{"strike": 100.0, "ce": {"ltp": 9.0}, "pe": {"ltp": 1.0}}, {"strike": 105.0, "ce": {"ltp": 5.2}, "pe": {"ltp": 5.0}}, {"strike": 110.0, "ce": {"ltp": 1.0}, "pe": {"ltp": 9.5}}]
        self.assertEqual(optiondb.estimate_spot(rows), 105.2)
        self.assertIsNone(optiondb.estimate_spot([{"strike": 1.0, "ce": None, "pe": None}]))

    def test_every_outcome_is_audited_and_chain_verifies(self):
        optiondb.import_csv(CSV, "web", NAME)
        optiondb.import_csv(CSV, "web", NAME)
        with self.assertRaises(optiondb.CsvError):
            optiondb.import_csv("nope", "web", "bad.csv")
        events = [e["event"] for e in optiondb.audit_log(10)]
        self.assertEqual(events, ["import_rejected", "import_duplicate", "import_ok"])
        v = optiondb.verify_audit()
        self.assertEqual((v["ok"], v["entries"]), (True, 3))

    def test_audit_log_is_append_only_and_tampering_is_detected(self):
        optiondb.import_csv(CSV, "web", NAME)
        optiondb.audit("note", "test", "second entry")
        c = optiondb._db()
        with self.assertRaises(sqlite3.IntegrityError):
            c.execute("UPDATE audit_log SET detail='x' WHERE id=1")
        with self.assertRaises(sqlite3.IntegrityError):
            c.execute("DELETE FROM audit_log WHERE id=1")
        # someone with raw database access removes the guard and edits history: the chain no longer verifies
        c.execute("DROP TRIGGER audit_no_update")
        c.execute("UPDATE audit_log SET detail='edited' WHERE id=1")
        v = optiondb.verify_audit()
        self.assertFalse(v["ok"])
        self.assertEqual(v["firstBadId"], 1)

    def test_old_snapshots_are_pruned_but_audit_is_kept(self):
        old = optiondb.KEEP_SNAPSHOTS
        optiondb.KEEP_SNAPSHOTS = 3
        try:
            for i in range(6):
                p = optiondb.parse_csv(CSV.replace("180.5", f"{181 + i}"), NAME)
                optiondb.store(p, "csv:t", "test")
        finally:
            optiondb.KEEP_SNAPSHOTS = old
        self.assertEqual(len(optiondb.snapshots()), 3)
        self.assertEqual(len([e for e in optiondb.audit_log(50) if e["event"] == "import_ok"]), 6)


class InboxTests(Fresh):
    def put(self, name, text, age=10):
        inbox = config.inbox_dir()
        inbox.mkdir(parents=True, exist_ok=True)
        p = inbox / name
        p.write_text(text)
        os.utime(p, (time.time() - age, time.time() - age))
        return p

    def test_ingest_moves_files_and_audits(self):
        self.put(NAME, CSV)
        self.put("option-chain-ED-NIFTY-27-Oct-2026 (1).csv", CSV)           # same content: duplicate
        self.put("garbage.csv", "hello")                                       # rejected
        self.put("notes.txt", "ignore me")                                     # not a CSV
        self.put("fresh.csv", CSV, age=0)                                      # still being written: skipped this round
        counts = scheduler.ingest_inbox()
        self.assertEqual(counts, {"stored": 1, "duplicate": 1, "rejected": 1})
        inbox = config.inbox_dir()
        self.assertEqual(sorted(p.name for p in (inbox / "processed").iterdir()), sorted([NAME, "option-chain-ED-NIFTY-27-Oct-2026 (1).csv"]))
        self.assertEqual([p.name for p in (inbox / "rejected").iterdir()], ["garbage.csv"])
        self.assertTrue((inbox / "notes.txt").exists() and (inbox / "fresh.csv").exists())
        self.assertEqual(scheduler.ingest_inbox(), {"stored": 0, "duplicate": 0, "rejected": 0})  # nothing left to do
        self.assertTrue(optiondb.verify_audit()["ok"])

    def test_idle_scans_are_not_logged_but_busy_ones_are(self):
        scheduler.tick(); scheduler.tick()
        self.assertEqual([e for e in optiondb.audit_log(10) if e["event"] == "scan"], [])
        self.put(NAME, CSV)
        scheduler.tick()
        events = [e["event"] for e in optiondb.audit_log(10)]
        self.assertEqual(events.count("scan"), 1)
        self.assertIn("import_ok", events)

    def test_symlinks_in_the_inbox_are_ignored(self):
        inbox = config.inbox_dir()
        inbox.mkdir(parents=True, exist_ok=True)
        target = Path(self.tmp.name) / "secret.csv"
        target.write_text(CSV)
        (inbox / NAME).symlink_to(target)
        self.assertEqual(scheduler.ingest_inbox(), {"stored": 0, "duplicate": 0, "rejected": 0})
        self.assertTrue(target.exists())


class FakeMcp(http.server.BaseHTTPRequestHandler):
    """A tiny derivatives MCP endpoint that returns NSE's option-chain JSON layout."""
    calls = []

    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeMcp.calls.append(body.get("method"))
        m, mid = body.get("method"), body.get("id")
        if mid is None:
            self.send_response(202); self.end_headers(); return
        if m == "initialize":
            res = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake-fo", "version": "1"}}
        elif m == "tools/list":
            res = {"tools": [{"name": "get_option_chain", "inputSchema": {"type": "object", "properties": {"symbol": {"type": "string"}, "expiryDate": {"type": "string"}}, "required": ["symbol"]}}]}
        else:
            sym = body["params"]["arguments"].get("symbol")
            base = 22600 if sym == "NIFTY" else 54000
            data = [{"strikePrice": base + d, "CE": {"openInterest": 1000 + d, "lastPrice": 100 - d / 10}, "PE": {"openInterest": 900 - d, "lastPrice": 100 + d / 10}} for d in (-100, 0, 100)]
            payload = {"records": {"expiryDates": ["27-Oct-2026"], "underlyingValue": base, "data": data}}
            res = {"content": [{"type": "text", "text": json.dumps(payload)}], "isError": False}
        out = json.dumps({"jsonrpc": "2.0", "id": mid, "result": res}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Mcp-Session-Id", "s1")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class ConfiguredEndpointTests(Fresh):
    def test_scheduled_fetch_stores_snapshots_and_survives_endpoint_outage(self):
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeMcp)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        config.settings.fo_url = f"http://127.0.0.1:{httpd.server_address[1]}/mcp"
        self.assertIn("NIFTY", scheduler.tick() and "NIFTY")  # tick runs without raising
        snaps = {s["symbol"]: s for s in optiondb.snapshots()}
        self.assertEqual(set(snaps), {"NIFTY", "BANKNIFTY"})
        self.assertTrue(snaps["NIFTY"]["source"].startswith("mcp:"))
        live = options.option_chain("NIFTY")
        self.assertTrue(live["available"])
        self.assertEqual(live["spot"], 22600)
        self.assertEqual(live["summary"]["atm"], 22600.0)
        # endpoint goes away: the page still gets the saved snapshot, with a warning
        httpd.shutdown(); httpd.server_close()
        store.clear_memory()
        down = options.option_chain("NIFTY")
        self.assertTrue(down["available"])
        self.assertEqual(down["tool"], "saved snapshot")
        self.assertTrue(down["warning"])
        scheduler.tick()  # a failed fetch is audited, not raised
        self.assertIn("fetch_failed", [e["event"] for e in optiondb.audit_log(20)])
        self.assertTrue(optiondb.verify_audit()["ok"])


class ApiTests(Fresh):
    def setUp(self):
        super().setUp()
        config.settings.offline, config.settings.news, config.settings.option_interval, config.settings.log_requests = True, False, 0, False
        config.settings.require_login = False
        config.settings.host, config.settings.port = "127.0.0.1", 0
        self.httpd = server.make_server()
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close()
        config.settings.offline, config.settings.news, config.settings.log_requests = False, True, True
        super().tearDown()

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, (json.loads(data) if data[:1] in (b"{", b"[") else data)

    OK = {"Content-Type": "text/csv", "X-Requested-With": "MarketLens"}

    def test_import_then_read_back_and_audit(self):
        s, d = self.req("POST", f"/api/options/import?filename={NAME}", CSV.encode(), self.OK)
        self.assertEqual((s, d["status"]), (200, "stored"))
        self.assertEqual(self.req("POST", f"/api/options/import?filename={NAME}", CSV.encode(), self.OK)[1]["status"], "duplicate")
        s, chain = self.req("GET", "/api/options?symbol=NIFTY")
        self.assertTrue(chain["available"])
        self.assertEqual(chain["meta"]["source"], f"csv:{NAME}")
        s, meta = self.req("GET", "/api/options/meta")
        self.assertEqual(meta["symbols"], ["NIFTY"])
        s, audit = self.req("GET", "/api/audit?limit=5")
        self.assertTrue(audit["verify"]["ok"])
        self.assertEqual(audit["entries"][0]["event"], "import_duplicate")

    def test_import_safeguards(self):
        self.assertEqual(self.req("POST", "/api/options/import", CSV.encode(), {"Content-Type": "text/csv"})[0], 403)  # no custom header
        self.assertEqual(self.req("POST", "/api/options/import", CSV.encode(), {**self.OK, "Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.req("POST", "/api/options/import", CSV.encode(), {"Content-Type": "application/json", "X-Requested-With": "MarketLens"})[0], 415)
        self.assertEqual(self.req("POST", "/api/options/import", b"", self.OK)[0], 400)
        # The size check uses Content-Length, so claim a large body and send almost nothing: the server must
        # refuse without reading it (sending the whole body would just race the server closing the socket).
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.putrequest("POST", "/api/options/import")
        for k, v in {**self.OK, "Content-Length": str(optiondb.MAX_CSV_BYTES + 10)}.items():
            c.putheader(k, v)
        c.endheaders(b"x")
        self.assertEqual(c.getresponse().status, 413)
        c.close()
        s, d = self.req("POST", "/api/options/import?filename=x.csv", b"not a csv", self.OK)
        self.assertEqual(s, 400)
        self.assertIn("STRIKE", d["error"])
        self.assertEqual(self.req("POST", "/api/stock/TCS", b"x", self.OK)[0], 404)

    def test_wrong_host_header_is_refused(self):  # DNS-rebinding protection
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.putrequest("GET", "/api/config", skip_host=True)
        c.putheader("Host", "evil.example")
        c.endheaders()
        self.assertEqual(c.getresponse().status, 403)
        c.close()

    def test_option_chain_without_data_explains_how_to_get_some(self):
        s, d = self.req("GET", "/api/options?symbol=NIFTY")
        self.assertFalse(d["available"])
        self.assertIn("inbox", d["reason"])
        self.assertIn("--fo-mcp-url", d["reason"])


class McpServerTests(Fresh):
    def rpc(self, method, params=None, mid=1):
        return options_mcp.handle({"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}})

    def test_initialize_list_and_unknown_method(self):
        self.assertEqual(self.rpc("initialize")["result"]["serverInfo"]["name"], "marketlens-options")
        self.assertEqual([t["name"] for t in self.rpc("tools/list")["result"]["tools"]],
                         ["option_chain_latest", "option_chain_snapshots", "option_chain_import_csv", "option_chain_audit_log"])
        self.assertEqual(self.rpc("nope")["error"]["code"], -32601)
        self.assertIsNone(options_mcp.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def call(self, name, args):
        res = self.rpc("tools/call", {"name": name, "arguments": args})["result"]
        return json.loads(res["content"][0]["text"]), res["isError"]

    def test_import_read_audit_through_tools(self):
        out, err = self.call("option_chain_import_csv", {"csv_text": CSV, "symbol": "NIFTY", "expiry": "27-Oct-2026"})
        self.assertEqual((out["status"], err), ("stored", False))
        latest, err = self.call("option_chain_latest", {"symbol": "NIFTY"})
        self.assertEqual((len(latest["rows"]), err), (3, False))
        self.assertEqual(self.call("option_chain_latest", {"symbol": "FINNIFTY"})[1], True)
        snaps, _ = self.call("option_chain_snapshots", {"limit": 5})
        self.assertEqual(snaps["snapshots"][0]["source"], "csv:upload")
        audit, _ = self.call("option_chain_audit_log", {})
        self.assertEqual((audit["entries"][0]["actor"], audit["verify"]["ok"]), ("mcp", True))

    def test_inbox_file_cannot_escape_the_inbox(self):
        config.inbox_dir().mkdir(parents=True, exist_ok=True)
        (Path(self.tmp.name) / "outside.csv").write_text(CSV)
        for evil in ("../outside.csv", "/etc/passwd", "../../../../etc/passwd"):
            out, err = self.call("option_chain_import_csv", {"inbox_file": evil, "symbol": "NIFTY", "expiry": "27-Oct-2026"})
            self.assertTrue(err, evil)
        (config.inbox_dir() / NAME).write_text(CSV)
        self.assertEqual(self.call("option_chain_import_csv", {"inbox_file": NAME})[0]["status"], "stored")

    def test_stdio_end_to_end(self):
        env = dict(os.environ, PYTHONPATH=os.pathsep.join(sys.path))
        p = subprocess.Popen([sys.executable, "-m", "marketlens.options_mcp", "--data-dir", self.tmp.name], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env=env)
        try:
            lines = [json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}), "not json",
                     json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}),
                     json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})]
            out, _ = p.communicate("\n".join(lines) + "\n", timeout=30)
        finally:
            p.kill()
        resp = [json.loads(x) for x in out.strip().splitlines()]
        self.assertEqual([r.get("id") for r in resp], [1, None, 2])
        self.assertEqual(resp[1]["error"]["code"], -32700)
        self.assertEqual(len(resp[2]["result"]["tools"]), 4)


if __name__ == "__main__":
    unittest.main()
