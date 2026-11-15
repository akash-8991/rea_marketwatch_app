"""Controls added after the pre-production audit (security-audit/AUDIT_REPORT.md): administrator role, closed registration and recovery beyond loopback, lockout design,
signed-in password change and account deletion, Secure cookies and proxies, host allow-list, safe upstream errors, server-side order limits, file modes. Offline."""
import json
import os
import stat
import time
import unittest
from pathlib import Path

import test_auth
import test_broker
from marketlens import accounts, broker, config, optiondb, server, store

PW = test_auth.PW
SECOND = {"name": "Ben Rao", "email": "ben@example.com", "dob": "1988-02-03", "userId": "ben_rao", "password": "Cobalt-Meadow-83x"}


class Http(test_auth.OverHttp):
    def setUp(self):
        super().setUp()
        s = config.settings
        self.saved3 = (s.public_url, s.trusted_proxies, s.allowed_hosts, s.open_signup, s.identity_recovery, s.session_idle_seconds, s.host)

    def tearDown(self):
        s = config.settings
        s.public_url, s.trusted_proxies, s.allowed_hosts, s.open_signup, s.identity_recovery, s.session_idle_seconds, s.host = self.saved3
        super().tearDown()

    def user(self, body):
        st, h, d = self.post("/api/auth/signup", body)
        self.assertEqual(st, 201, d)
        return self.cookie_of(h)

    def get(self, path, cookie):
        return self.call("GET", path, None, {"Cookie": cookie})


class AdministratorRole(Http):
    def test_first_account_is_the_administrator_and_others_are_not(self):
        a = self.user(self.SIGNUP)
        b = self.user(SECOND)
        self.assertTrue(self.get("/api/auth/me", a)[2]["user"]["isAdmin"])
        self.assertFalse(self.get("/api/auth/me", b)[2]["user"]["isAdmin"])

    def test_only_the_administrator_reaches_broker_audit_metrics_and_import(self):
        a, b = self.user(self.SIGNUP), self.user(SECOND)
        for path in ("/api/broker/account", "/api/broker/login-url", "/api/audit", "/api/metrics", "/api/broker/order/ABCD1234", "/api/broker/order?tag=ML1"):
            self.assertEqual(self.get(path, b)[0], 403, path)
            self.assertNotEqual(self.get(path, a)[0], 403, path)
        for path, body in (("/api/broker/kill", {"on": False}), ("/api/broker/credentials", {"apiKey": "ABCDEF123", "apiSecret": "SECRET123"}), ("/api/broker/forget", {}), ("/api/broker/order", {"order": {}})):
            self.assertEqual(self.post(path, body, b)[0], 403, path)
        st, _, d = self.call("POST", "/api/options/import", None, {"Content-Type": "text/csv", "X-Requested-With": "MarketLens", "Cookie": b}, raw=b"x")
        self.assertEqual(st, 403)
        self.assertEqual(self.post("/api/broker/kill", {"on": False}, a)[0], 200)

    def test_broker_status_hides_account_details_from_other_users_and_options_meta_hides_the_path(self):
        a, b = self.user(self.SIGNUP), self.user(SECOND)
        broker.save_credentials("APIKEY12345", "SECRET123")
        theirs, mine = self.get("/api/broker/status", b)[2], self.get("/api/broker/status", a)[2]
        self.assertTrue(theirs["restricted"])
        self.assertNotIn("apiKey", theirs)
        self.assertNotIn("user", theirs)
        self.assertIn("apiKey", mine)
        self.assertNotIn("dbPath", self.get("/api/options/meta", b)[2])
        self.assertIn("dbPath", self.get("/api/options/meta", a)[2])

    def test_old_database_without_the_column_makes_the_first_account_administrator(self):
        optiondb._db().executescript("DROP TABLE IF EXISTS users; CREATE TABLE users (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, dob TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login TEXT);")
        optiondb._db().execute("INSERT INTO users (user_id,name,email,dob,pw_hash,created_at,updated_at) VALUES ('old_one','Old One','o@example.com','1980-01-01','x','t','t'),('old_two','Old Two','p@example.com','1980-01-01','x','t','t')")
        accounts._ready["conn"] = None
        self.assertEqual([u["admin"] for u in accounts.list_users()], [True, False])

    def test_make_admin_from_the_command_line(self):
        self.user(self.SIGNUP)
        self.user(SECOND)
        accounts.set_admin("ben_rao", True)
        self.assertEqual([u["admin"] for u in accounts.list_users()], [True, True])


class BeyondLoopback(Http):
    def test_registration_and_recovery_close_when_bound_beyond_loopback(self):
        self.user(self.SIGNUP)
        config.settings.host = "0.0.0.0"
        st = self.call("GET", "/api/auth/status")[2]
        self.assertFalse(st["signupOpen"])
        self.assertFalse(st["recoveryEnabled"])
        s, _, d = self.post("/api/auth/signup", SECOND)
        self.assertEqual(s, 403)
        self.assertIn("closed", d["error"])
        s, _, d = self.post("/api/auth/forgot-user-id", {"name": "Asha Verma", "email": "asha@example.com", "dob": "1990-05-17"})
        self.assertEqual(s, 403)
        self.assertIn("switched off", d["error"])
        config.settings.open_signup = True
        config.settings.identity_recovery = True
        self.assertEqual(self.post("/api/auth/signup", SECOND)[0], 201, "an explicit setting overrides the automatic one")

    def test_the_first_account_can_always_be_created(self):
        config.settings.host = "0.0.0.0"
        self.assertEqual(self.post("/api/auth/signup", self.SIGNUP)[0], 201)

    def test_idle_limit_is_eight_hours_beyond_loopback(self):
        self.assertEqual(config.session_idle(), 15 * 24 * 3600)
        config.settings.host = "0.0.0.0"
        self.assertEqual(config.session_idle(), 8 * 3600)
        config.settings.session_idle_seconds = 600
        self.assertEqual(config.session_idle(), 600)

    def test_host_allow_list_applies_only_when_configured(self):
        config.settings.host = "0.0.0.0"
        self.assertEqual(self.call("GET", "/healthz", None, {"Host": "evil.example"})[0], 200, "nothing configured: no comparison")
        config.settings.public_url = "https://app.example"
        self.assertEqual(self.call("GET", "/healthz", None, {"Host": "evil.example"})[0], 403)
        self.assertEqual(self.call("GET", "/healthz", None, {"Host": "app.example"})[0], 200)
        self.assertEqual(self.call("GET", "/healthz", None, {"Host": "app.example", "Origin": "https://evil.example"})[0], 403)

    def test_cookie_is_secure_only_behind_https(self):
        s, h, _ = self.post("/api/auth/signup", self.SIGNUP)
        self.assertNotIn("Secure", h["set-cookie"])
        self.post("/api/auth/logout", {}, self.cookie_of(h))
        config.settings.public_url = "https://app.example"
        s, h, _ = self.post("/api/auth/login", {"userId": "asha_v", "password": PW})
        self.assertIn("Secure", h["set-cookie"])
        config.settings.public_url = ""
        config.settings.trusted_proxies = ("127.0.0.1",)
        s, h, _ = self.post("/api/auth/login", {"userId": "asha_v", "password": PW}, None, {"X-Forwarded-Proto": "https"})
        self.assertIn("Secure", h["set-cookie"])
        config.settings.trusted_proxies = ()
        s, h, _ = self.post("/api/auth/login", {"userId": "asha_v", "password": PW}, None, {"X-Forwarded-Proto": "https"})
        self.assertNotIn("Secure", h["set-cookie"], "an untrusted peer cannot claim https")


class Lockout(Http):
    def test_a_stranger_cannot_lock_the_owner_out(self):
        self.user(self.SIGNUP)
        config.settings.trusted_proxies = ("127.0.0.1",)
        bad = {"userId": "asha_v", "password": "wrong-password-1"}
        for _ in range(accounts.LOCK_AFTER):
            self.post("/api/auth/login", bad, None, {"X-Forwarded-For": "203.0.113.9"})
        self.assertEqual(self.post("/api/auth/login", bad, None, {"X-Forwarded-For": "203.0.113.9"})[0], 429, "that address is locked")
        self.assertEqual(self.post("/api/auth/login", {"userId": "asha_v", "password": PW}, None, {"X-Forwarded-For": "198.51.100.7"})[0], 200, "the owner, elsewhere, is not")

    def test_many_addresses_together_still_lock_the_account(self):
        self.user(self.SIGNUP)
        config.settings.trusted_proxies = ("127.0.0.1",)
        for i in range(accounts.LOCK_AFTER_USER):
            self.post("/api/auth/login", {"userId": "asha_v", "password": "wrong-password-1"}, None, {"X-Forwarded-For": f"203.0.113.{i + 1}"})
        self.assertEqual(self.post("/api/auth/login", {"userId": "asha_v", "password": PW}, None, {"X-Forwarded-For": "198.51.100.200"})[0], 429)

    def test_forwarded_for_is_ignored_unless_the_peer_is_a_trusted_proxy(self):
        self.user(self.SIGNUP)
        bad = {"userId": "asha_v", "password": "wrong-password-1"}
        for i in range(accounts.LOCK_AFTER):
            self.post("/api/auth/login", bad, None, {"X-Forwarded-For": f"203.0.113.{i + 1}"})   # forged, different each time: all count against the real peer
        self.assertEqual(self.post("/api/auth/login", {"userId": "asha_v", "password": PW}, None, {"X-Forwarded-For": "198.51.100.1"})[0], 429)


class OwnAccount(Http):
    def test_change_password_needs_the_current_password_and_ends_sessions(self):
        c = self.user(self.SIGNUP)
        s, _, d = self.post("/api/auth/change-password", {"currentPassword": "not-the-password", "newPassword": "Cobalt-Meadow-83x"}, c)
        self.assertEqual(s, 403)
        s, h, d = self.post("/api/auth/change-password", {"currentPassword": PW, "newPassword": "Cobalt-Meadow-83x"}, c)
        self.assertEqual((s, d), (200, {"changed": True}))
        self.assertEqual(self.get("/api/auth/me", c)[0], 401, "every session ended")
        self.assertEqual(self.post("/api/auth/login", {"userId": "asha_v", "password": PW})[0], 401)
        self.assertEqual(self.post("/api/auth/login", {"userId": "asha_v", "password": "Cobalt-Meadow-83x"})[0], 200)

    def test_change_password_requires_a_session(self):
        self.user(self.SIGNUP)
        self.assertEqual(self.post("/api/auth/change-password", {"currentPassword": PW, "newPassword": "Cobalt-Meadow-83x"})[0], 401)

    def test_delete_account_removes_the_person_and_their_details(self):
        a = self.user(self.SIGNUP)
        b = self.user(SECOND)
        self.assertEqual(self.post("/api/auth/delete-account", {"password": "wrong"}, b)[0], 403)
        self.assertEqual(self.post("/api/auth/delete-account", {"password": SECOND["password"]}, b)[1].get("set-cookie", "").startswith("ml_session=;"), True)
        self.assertEqual(self.post("/api/auth/login", {"userId": "ben_rao", "password": SECOND["password"]})[0], 401)
        rows = optiondb._db().execute("SELECT COUNT(*) FROM users WHERE email='ben@example.com'").fetchone()[0]
        self.assertEqual(rows, 0)
        audit = json.dumps(optiondb.audit_log(50))
        self.assertIn("account_deleted", audit)
        self.assertNotIn("ben@example.com", audit)
        self.assertEqual(self.get("/api/auth/me", a)[0], 200, "other accounts are untouched")

    def test_the_only_administrator_cannot_delete_themselves_while_others_exist(self):
        a = self.user(self.SIGNUP)
        self.user(SECOND)
        s, _, d = self.post("/api/auth/delete-account", {"password": PW}, a)
        self.assertEqual(s, 409)
        accounts.set_admin("ben_rao", True)
        self.assertEqual(self.post("/api/auth/delete-account", {"password": PW}, a)[0], 200)


class UpstreamErrors(unittest.TestCase):
    def test_known_short_reasons_pass_and_internals_do_not(self):
        self.assertEqual(server._upstream_message(RuntimeError("tools/call failed: no answer from NSE (3 tries): connection error: TimeoutError")), "tools/call failed: no answer from NSE (3 tries): connection error: TimeoutError")
        for secret in ("open('/Users/me/.ssh/id_rsa') failed", "GET https://internal.example/x failed", "C:\\Users\\me\\x"):
            self.assertEqual(server._upstream_message(RuntimeError(secret)), "the data source did not answer; try again shortly")
        self.assertEqual(server._upstream_message(KeyError("secret-key-name")), "the data source did not answer; try again shortly")


class AuditAnchor(test_auth.Fresh):
    def test_a_recorded_head_must_still_be_in_the_chain(self):
        optiondb.safe_audit("a", "t", "one")
        optiondb.safe_audit("b", "t", "two")
        v = optiondb.verify_audit()
        self.assertTrue(v["ok"] and v["head"])
        self.assertTrue(optiondb.verify_audit(v["head"])["ok"])
        bad = optiondb.verify_audit("0" * 64)
        self.assertFalse(bad["ok"])
        self.assertTrue(bad["anchorMissing"])


class FileModes(test_auth.Fresh):
    @unittest.skipUnless(os.name == "posix", "POSIX permissions")
    def test_database_and_its_side_files_are_owner_only(self):
        self.make()
        optiondb.safe_audit("x", "t", "y")
        for suffix in ("", "-wal", "-shm"):
            p = Path(optiondb.db_path() + suffix)
            if p.exists():
                self.assertEqual(stat.S_IMODE(p.stat().st_mode) & 0o077, 0, p.name)

    @unittest.skipUnless(os.name == "posix", "POSIX permissions")
    def test_configure_makes_the_data_folder_private(self):
        d = Path(self.tmp.name) / "fresh"
        config.configure(data_dir=d)
        self.assertEqual(stat.S_IMODE(d.stat().st_mode), 0o700)


class OrderGateLimits(test_broker.BrokerTests):
    """Reuses the broker fixtures (fake Kite, connect, order)."""

    def test_nan_and_infinite_prices_are_refused(self):
        self.connect(live=True)
        for bad in (float("nan"), float("inf")):
            with self.assertRaises(broker.BrokerError):
                broker.place_order(self.order(price=bad, tag="MLNAN1"))

    def test_daily_order_count_is_capped(self):
        self.connect(live=True)
        p = Path(self.tmp.name) / "broker.json"
        d = json.loads(p.read_text())
        d["max_daily_orders"] = 3
        p.write_text(json.dumps(d))
        for i in range(3):
            broker._sent.clear()
            broker.place_order(self.order(tag=f"MLD{i}"))
        broker._sent.clear()
        with self.assertRaises(broker.BrokerError) as e:
            broker.place_order(self.order(tag="MLD9"))
        self.assertEqual(e.exception.status, 403)
        self.assertIn("Daily order limit", str(e.exception))

    def test_daily_order_value_is_capped(self):
        self.connect(live=True)
        p = Path(self.tmp.name) / "broker.json"
        d = json.loads(p.read_text())
        d["max_daily_value"] = 15_000
        p.write_text(json.dumps(d))
        broker.place_order(self.order(tag="MLV1", quantity=10, price=1000))
        broker._sent.clear()
        with self.assertRaises(broker.BrokerError) as e:
            broker.place_order(self.order(tag="MLV2", quantity=10, price=1000))
        self.assertIn("Daily order value", str(e.exception))

    def test_a_refused_order_gives_its_allowance_back(self):
        self.connect(live=True)
        p = Path(self.tmp.name) / "broker.json"
        d = json.loads(p.read_text())
        d["max_daily_orders"] = 1
        p.write_text(json.dumps(d))
        self.kite.fail_orders = (400, json.dumps({"status": "error", "message": "Insufficient funds", "error_type": "InputException"}).encode())
        with self.assertRaises(broker.BrokerError):
            broker.place_order(self.order(tag="MLR1"))
        self.kite.fail_orders = None
        broker._sent.clear()
        self.assertIn("order_id", broker.place_order(self.order(tag="MLR2")))

    def test_a_restart_cannot_send_the_same_tag_twice(self):
        self.connect(live=True)
        first = broker.place_order(self.order(tag="MLSAME1"))
        broker._tags.clear()          # what a restart does to the in-memory record
        again = broker.place_order(self.order(tag="MLSAME1"))
        self.assertTrue(again["duplicate"])
        self.assertEqual(again["order_id"], first["order_id"])
        self.assertEqual(len([c for c in self.kite.calls if c[1] == "/orders/regular"]), 1)

    def test_symbol_allow_list(self):
        self.connect(live=True)
        p = Path(self.tmp.name) / "broker.json"
        d = json.loads(p.read_text())
        d["allowed_symbols"] = ["TCS"]
        p.write_text(json.dumps(d))
        with self.assertRaises(broker.BrokerError) as e:
            broker.place_order(self.order(tag="MLAL1"))
        self.assertEqual(e.exception.status, 403)
        self.assertIn("order_id", broker.place_order(self.order(tag="MLAL2", tradingsymbol="TCS")))

    def test_expired_session_token_is_removed_from_the_file(self):
        self.connect()
        p = Path(self.tmp.name) / "broker.json"
        d = json.loads(p.read_text())
        d["token_expires"] = time.time() - 5
        p.write_text(json.dumps(d))
        broker.status()
        self.assertNotIn("access_token", json.loads(p.read_text()))


class StartupGuard(unittest.TestCase):
    def test_live_orders_without_accounts_beyond_loopback_refuse_to_start(self):
        from marketlens import cli
        s = config.settings
        saved = (s.live_orders, s.require_login, s.host)
        s.live_orders, s.require_login, s.host = True, False, "0.0.0.0"
        try:
            with self.assertRaises(SystemExit) as e:
                cli.start(None)
            self.assertIn("Refusing to start", str(e.exception))
        finally:
            s.live_orders, s.require_login, s.host = saved


if __name__ == "__main__":
    unittest.main()
