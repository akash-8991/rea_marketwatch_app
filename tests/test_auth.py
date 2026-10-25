"""Accounts: storage, validation, lockouts, recovery, sessions, cookies, CSRF, audit hygiene. Offline."""
import http.client
import json
import tempfile
import threading
import unittest
from pathlib import Path

from marketlens import accounts, config, optiondb, ratelimit, server, store

PW = "Tr0ub4dor&Horse-Staple"
GOOD = dict(name="Asha Verma", email="Asha.Verma@Example.com", dob="1990-05-17", user_id="asha_v", password=PW)


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class Fresh(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        s = config.settings
        self.saved = (s.data_dir, s.pbkdf2_iterations, s.require_login, accounts.now)
        s.data_dir, s.pbkdf2_iterations = Path(self.tmp.name), 1000          # fast hashing for tests
        self.clock = Clock()
        accounts.now = self.clock
        accounts._ready["conn"] = None

    def tearDown(self):
        optiondb.close()
        s = config.settings
        s.data_dir, s.pbkdf2_iterations, s.require_login, accounts.now = self.saved
        accounts._ready["conn"] = None
        self.tmp.cleanup()

    def make(self, **over):
        d = dict(GOOD, **over)
        return accounts.signup(d["name"], d["email"], d["dob"], d["user_id"], d["password"])

    def err(self, fn, *a, **k):
        with self.assertRaises(accounts.AuthError) as cm:
            fn(*a, **k)
        return cm.exception


class Storage(Fresh):
    def test_password_is_hashed_salted_and_never_stored(self):
        self.make()
        self.make(name="Ravi Rao", email="ravi@example.com", user_id="ravi_r")          # same password, different user
        rows = optiondb._db().execute("SELECT pw_hash FROM users ORDER BY id").fetchall()
        a, b = rows[0][0], rows[1][0]
        self.assertTrue(a.startswith("pbkdf2_sha256$1000$"))
        self.assertNotEqual(a, b)                                                        # different random salts
        self.assertNotIn(PW, a + b)
        raw = Path(optiondb.db_path()).read_bytes()
        self.assertNotIn(PW.encode(), raw)                                               # not anywhere in the database file
        self.assertTrue(accounts.verify_password(PW, a) and not accounts.verify_password(PW + "x", a))

    def test_default_hashing_cost_is_high(self):
        self.assertGreaterEqual(config.Settings().pbkdf2_iterations, 600_000)

    def test_stored_profile_and_normalisation(self):
        self.make()
        row = optiondb._db().execute("SELECT user_id, name, email, dob FROM users").fetchone()
        self.assertEqual(row, ("asha_v", "Asha Verma", "asha.verma@example.com", "1990-05-17"))

    def test_database_file_is_owner_only(self):
        self.make()
        import os, sys
        if sys.platform != "win32":
            self.assertEqual(os.stat(optiondb.db_path()).st_mode & 0o077, 0)


class Validation(Fresh):
    def test_each_field_is_checked_with_a_clear_message(self):
        cases = [("name", dict(name="A"), "name"), ("name", dict(name="12345"), "name"), ("email", dict(email="not-an-email"), "email"), ("email", dict(email="a@b"), "email"),
                 ("dob", dict(dob="1990-13-45"), "dob"), ("dob", dict(dob="2999-01-01"), "dob"), ("dob", dict(dob="1850-01-01"), "dob"), ("dob", dict(dob=""), "dob"),
                 ("userId", dict(user_id="ab"), "userId"), ("userId", dict(user_id="has space"), "userId"), ("userId", dict(user_id="x" * 33), "userId")]
        for label, over, field in cases:
            e = self.err(self.make, **over)
            self.assertEqual((e.field, e.status), (field, 400), (label, over))

    def test_password_policy(self):
        for pw, why in (("short1!", "short"), ("password123", "common"), ("1234567890", "common"), ("aaaaaaaaaaaa", "repeats"), ("xx" + "asha_v" + "yy1234", "contains user id"),
                        ("my-asha.verma-pw99", "contains email name")):
            e = self.err(self.make, password=pw)
            self.assertEqual((e.field, e.status), ("password", 400), why)
        self.make()          # a long passphrase is fine

    def test_duplicates_are_refused_case_insensitively(self):
        self.make()
        self.assertEqual(self.err(self.make, user_id="ASHA_V", email="other@example.com").status, 409)
        self.assertEqual(self.err(self.make, user_id="someone_else", email="ASHA.VERMA@example.com").status, 409)
        self.assertEqual(accounts.user_count(), 1)


class Login(Fresh):
    def test_success_and_generic_failure(self):
        self.make()
        self.assertEqual(accounts.login("ASHA_V", PW)[1], "asha_v")                      # user ID is case-insensitive
        bad_pw = self.err(accounts.login, "asha_v", "wrong-password-1")
        bad_user = self.err(accounts.login, "nobody_here", "wrong-password-1")
        self.assertEqual((bad_pw.status, str(bad_pw)), (401, "Incorrect user ID or password."))
        self.assertEqual(str(bad_pw), str(bad_user))                                     # cannot tell which part was wrong

    def test_unknown_users_still_cost_a_password_check(self):
        calls = []
        original = accounts.verify_password
        accounts.verify_password = lambda *a: calls.append(a) or original(*a)
        try:
            self.err(accounts.login, "ghost_user", "whatever-pass-1")
        finally:
            accounts.verify_password = original
        self.assertEqual(len(calls), 1)                                                   # equalises timing for known and unknown IDs

    def test_lockout_after_five_failures_blocks_even_the_right_password_then_expires_and_doubles(self):
        self.make()
        for _ in range(4):
            self.assertEqual(self.err(accounts.login, "asha_v", "bad-password-0").status, 401)
        e = self.err(accounts.login, "asha_v", "bad-password-0")                          # 5th failure triggers the lock
        e = self.err(accounts.login, "asha_v", PW)
        self.assertEqual(e.status, 429)
        self.assertTrue(14 * 60 <= e.retry_after <= 15 * 60 + 1)
        self.clock.t += 15 * 60 + 5
        self.assertEqual(accounts.login("asha_v", PW)[1], "asha_v")                       # unlocked, and success clears the counter
        for _ in range(5):
            self.err(accounts.login, "asha_v", "bad-password-0")
        self.assertEqual(self.err(accounts.login, "asha_v", PW).status, 429)              # a fresh run of failures locks again
        for _ in range(5):                                                                  # (level 1 cleared on success; build level 2 instead)
            pass

    def test_second_lockout_is_longer(self):
        self.make()
        waits = []
        for _ in range(2):
            for _ in range(5):
                self.err(accounts.login, "asha_v", "bad-password-0") if _ < 5 else None
            waits.append(self.err(accounts.login, "asha_v", "bad-password-0").retry_after)
            self.clock.t += waits[-1] + 1
        self.assertGreater(waits[1], waits[0] * 1.8)

    def test_unknown_user_ids_are_throttled_too(self):
        for _ in range(5):
            self.err(accounts.login, "ghost_user", "bad-password-0")
        self.assertEqual(self.err(accounts.login, "ghost_user", "bad-password-0").status, 429)


class Recovery(Fresh):
    def setUp(self):
        super().setUp()
        self.make()

    ID = dict(name="Asha Verma", email="asha.verma@example.com", dob="1990-05-17")

    def test_user_id_is_shown_only_when_all_three_match_ignoring_case_and_spacing(self):
        self.assertEqual(accounts.forgot_user_id("  asha   VERMA ", "ASHA.VERMA@EXAMPLE.COM ", "1990-05-17"), "asha_v")

    def test_any_single_wrong_field_gives_the_same_generic_failure(self):
        msgs = set()
        for over in (dict(name="Asha Verna"), dict(email="asha.verma@example.org"), dict(dob="1990-05-18"), dict(name="", email="", dob="")):
            e = self.err(accounts.forgot_user_id, **dict(self.ID, **over))
            self.assertEqual(e.status, 403)
            msgs.add(str(e))
        self.assertEqual(msgs, {"The details do not match our records."})

    def test_guessing_the_date_of_birth_is_locked_out(self):
        for d in range(5):
            self.err(accounts.forgot_user_id, "Asha Verma", "asha.verma@example.com", f"1990-05-0{d + 1}")
        e = self.err(accounts.forgot_user_id, **self.ID)                                  # even the correct details are refused while locked
        self.assertEqual(e.status, 429)

    def test_unknown_emails_get_the_same_treatment(self):
        e = self.err(accounts.forgot_user_id, "Nobody", "nobody@example.com", "2000-01-01")
        self.assertEqual((e.status, str(e)), (403, "The details do not match our records."))
        for _ in range(4):
            self.err(accounts.forgot_user_id, "Nobody", "nobody@example.com", "2000-01-01")
        self.assertEqual(self.err(accounts.forgot_user_id, "Nobody", "nobody@example.com", "2000-01-01").status, 429)

    def test_change_password_needs_matching_details_and_ends_all_sessions(self):
        token = accounts.create_session(accounts.login("asha_v", PW)[0])
        self.assertIsNotNone(accounts.user_for_token(token))
        self.err(accounts.update_credentials, "Asha Verma", "asha.verma@example.com", "1990-05-18", None, "A-new-Passphrase-77")
        self.assertEqual(accounts.login("asha_v", PW)[1], "asha_v")                       # unchanged after a failed attempt
        self.assertEqual(accounts.update_credentials(**self.ID, new_user_id=None, new_password="A-new-Passphrase-77"), ["password"])
        self.assertIsNone(accounts.user_for_token(token))                                 # every device must sign in again
        self.assertEqual(self.err(accounts.login, "asha_v", PW).status, 401)
        self.assertEqual(accounts.login("asha_v", "A-new-Passphrase-77")[1], "asha_v")

    def test_change_user_id_and_both_together(self):
        self.assertEqual(accounts.update_credentials(**self.ID, new_user_id="asha.verma", new_password="Another-Long-Phrase-9"), ["user ID", "password"])
        self.assertEqual(self.err(accounts.login, "asha_v", "Another-Long-Phrase-9").status, 401)
        self.assertEqual(accounts.login("asha.verma", "Another-Long-Phrase-9")[1], "asha.verma")

    def test_taken_user_id_changes_nothing(self):
        self.make(name="Ravi Rao", email="ravi@example.com", user_id="ravi_r")
        e = self.err(accounts.update_credentials, **self.ID, new_user_id="RAVI_R", new_password="Another-Long-Phrase-9")
        self.assertEqual(e.status, 409)
        self.assertEqual(accounts.login("asha_v", PW)[1], "asha_v")                       # neither field was changed (transaction rolled back)

    def test_something_to_change_is_required_and_new_password_is_checked(self):
        self.assertEqual(self.err(accounts.update_credentials, **self.ID).field, "newPassword")
        self.assertEqual(self.err(accounts.update_credentials, **self.ID, new_password="password123").status, 400)


class Sessions(Fresh):
    def test_stays_signed_in_for_15_days_then_ends(self):
        pk = self.make()[0]
        token = accounts.create_session(pk)
        self.assertEqual(accounts.user_for_token(token)["userId"], "asha_v")
        self.assertNotIn(token, optiondb._db().execute("SELECT group_concat(token_hash) FROM sessions").fetchone()[0])   # only a hash is stored
        self.clock.t += 14 * 24 * 3600                                                      # app closed for two weeks: still signed in
        self.assertIsNotNone(accounts.user_for_token(token))
        self.clock.t += 23 * 3600                                                           # 14 days 23 h
        self.assertIsNotNone(accounts.user_for_token(token))
        self.clock.t += 2 * 3600                                                            # past 15 days, even though it was just used
        self.assertIsNone(accounts.user_for_token(token))

    def test_use_does_not_extend_beyond_15_days(self):
        token = accounts.create_session(self.make()[0])
        for _ in range(31):                                                                 # keep it busy for 15.5 days (12 h steps)
            self.clock.t += 12 * 3600
            accounts.user_for_token(token)
        self.assertIsNone(accounts.user_for_token(token))

    def test_logout_and_junk_tokens(self):
        token = accounts.create_session(self.make()[0])
        accounts.end_session(token)
        self.assertIsNone(accounts.user_for_token(token))
        for junk in (None, "", "x" * 500, "' OR 1=1 --", "../../etc"):
            self.assertIsNone(accounts.user_for_token(junk))


class AuditHygiene(Fresh):
    def test_no_secrets_or_personal_fields_in_the_audit_log_and_the_chain_holds(self):
        self.make()
        self.err(accounts.login, "asha_v", "Wrong-Passphrase-123")
        accounts.login("asha_v", PW)
        self.err(accounts.forgot_user_id, "Asha Verma", "asha.verma@example.com", "1990-01-01")
        accounts.forgot_user_id("Asha Verma", "asha.verma@example.com", "1990-05-17")
        accounts.update_credentials("Asha Verma", "asha.verma@example.com", "1990-05-17", None, "Brand-New-Passphrase-5")
        dump = json.dumps(optiondb.audit_log(100))
        for secret in (PW, "Wrong-Passphrase-123", "Brand-New-Passphrase-5", "1990-05-17", "1990-01-01", "asha.verma@example.com", "Asha Verma"):
            self.assertNotIn(secret, dump)
        events = {e["event"] for e in optiondb.audit_log(100)}
        self.assertTrue({"signup_ok", "login_failed", "login_ok", "identity_check_failed", "user_id_recovered", "credentials_changed"} <= events)
        self.assertEqual([e["outcome"] for e in optiondb.audit_log(100) if e["event"] in ("login_failed", "identity_check_failed")], ["denied", "denied"])
        self.assertTrue(optiondb.verify_audit()["ok"])

    def test_hostile_user_ids_cannot_inject_into_the_log_actor_field(self):
        self.err(accounts.login, "x'; DROP TABLE users;--" + "y" * 100, "whatever-pass-1")
        self.assertEqual(optiondb.audit_log(1)[0]["actor"], "anonymous")
        self.assertEqual(accounts.user_count(), 0)


class AdminCommands(Fresh):
    def test_machine_owner_can_reset_a_password(self):
        self.make()
        for _ in range(5):
            self.err(accounts.login, "asha_v", "bad-password-0")                            # locked out
        accounts.admin_reset_password("asha_v", "Owner-Chosen-Passphrase-1")
        self.assertEqual(accounts.login("asha_v", "Owner-Chosen-Passphrase-1")[1], "asha_v")   # lock cleared, new password works
        self.assertEqual(self.err(accounts.admin_reset_password, "nobody", "Owner-Chosen-Passphrase-1").status, 404)
        self.assertEqual(self.err(accounts.admin_reset_password, "asha_v", "short").status, 400)
        self.assertEqual(accounts.list_users()[0]["userId"], "asha_v")
        e = [x for x in optiondb.audit_log(20) if x["event"] == "password_reset_admin"][0]
        self.assertEqual((e["channel"], e["actor"]), ("cli", "asha_v"))


class OverHttp(Fresh):
    JSON = {"Content-Type": "application/json", "X-Requested-With": "MarketLens"}

    def setUp(self):
        super().setUp()
        s = config.settings
        self.saved2 = (s.offline, s.news, s.option_interval, s.rate_limit, s.log_requests, s.host, s.port)
        s.offline, s.news, s.option_interval, s.rate_limit, s.log_requests, s.host, s.port = True, False, 0, False, False, "127.0.0.1", 0
        s.require_login = True
        accounts.now = __import__("time").time                                              # the real clock for cookie/session timing
        store.clear_memory()
        store.disk_put("bootstrap", {"asOf": "x", "stocks": [], "indices": [], "valuation": []})
        self.httpd = server.make_server()
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown(); self.httpd.server_close()
        s = config.settings
        s.offline, s.news, s.option_interval, s.rate_limit, s.log_requests, s.host, s.port = self.saved2
        super().tearDown()

    def call(self, method, path, body=None, headers=None, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, body=raw if raw is not None else (json.dumps(body).encode() if body is not None else None), headers=headers or {})
        r = c.getresponse()
        data = r.read()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        c.close()
        try:
            data = json.loads(data)
        except ValueError:
            pass
        return r.status, hdrs, data

    def post(self, path, body, cookie=None, extra=None):
        h = dict(self.JSON, **(extra or {}))
        if cookie:
            h["Cookie"] = cookie
        return self.call("POST", path, body, h)

    @staticmethod
    def cookie_of(headers):
        return headers["set-cookie"].split(";")[0]

    SIGNUP = {"name": "Asha Verma", "email": "asha@example.com", "dob": "1990-05-17", "userId": "asha_v", "password": PW}

    def test_api_requires_a_session_but_the_shell_and_probes_do_not(self):
        for path in ("/api/config", "/api/bootstrap", "/api/audit", "/api/metrics", "/api/options?symbol=NIFTY", "/api/stock/TCS", "/api/auth/me"):
            s, _, d = self.call("GET", path)
            self.assertEqual((s, d["error"]) if isinstance(d, dict) else s, (401, "authentication required"), path)
        self.assertEqual(self.call("POST", "/api/options/import", None, {"Content-Type": "text/csv", "X-Requested-With": "MarketLens"}, raw=b"x")[0], 401)
        for path in ("/", "/js/app.js", "/healthz", "/api/auth/status"):
            self.assertEqual(self.call("GET", path)[0], 200, path)
        self.assertEqual(self.call("GET", "/api/auth/status")[2], {"loginRequired": True, "usersExist": False, "signedIn": False})

    def test_signup_sets_a_hardened_cookie_and_signs_you_in(self):
        s, h, d = self.post("/api/auth/signup", self.SIGNUP)
        self.assertEqual((s, d["user"]["userId"], d["user"]["name"]), (201, "asha_v", "Asha Verma"))
        self.assertIsInstance(d["user"]["uid"], int)
        flags = h["set-cookie"]
        self.assertIn("HttpOnly", flags); self.assertIn("SameSite=Strict", flags); self.assertIn("Path=/", flags)
        cookie = self.cookie_of(h)
        me = self.call("GET", "/api/auth/me", headers={"Cookie": cookie})[2]["user"]
        self.assertEqual((me["userId"], me["uid"]), ("asha_v", d["user"]["uid"]))
        self.assertEqual(self.call("GET", "/api/config", headers={"Cookie": cookie})[0], 200)
        self.assertEqual(self.call("GET", "/api/auth/status", headers={"Cookie": cookie})[2]["signedIn"], True)

    def test_logout_ends_the_session_server_side(self):
        cookie = self.cookie_of(self.post("/api/auth/signup", self.SIGNUP)[1])
        s, h, _ = self.post("/api/auth/logout", {}, cookie)
        self.assertIn("Max-Age=0", h["set-cookie"])
        self.assertEqual(self.call("GET", "/api/config", headers={"Cookie": cookie})[0], 401)      # the old cookie is dead, not just forgotten

    def test_forged_tampered_and_garbage_cookies_are_rejected(self):
        for c in ("ml_session=abc", "ml_session=" + "A" * 43, "ml_session=%00", "other=1", "ml_session=' OR 1=1--", ";;;"):
            self.assertEqual(self.call("GET", "/api/config", headers={"Cookie": c})[0], 401, c)

    def test_login_failure_is_generic_and_lockout_returns_retry_after(self):
        self.post("/api/auth/signup", self.SIGNUP)
        for _ in range(5):
            s, h, d = self.post("/api/auth/login", {"userId": "asha_v", "password": "wrong-password-1"})
        self.assertEqual((s, d["error"]), (401, "Incorrect user ID or password."))
        self.assertNotIn("set-cookie", h)
        s, h, d = self.post("/api/auth/login", {"userId": "asha_v", "password": PW})
        self.assertEqual(s, 429)
        self.assertGreaterEqual(int(h["retry-after"]), 60)

    def test_csrf_and_content_type_and_size_protections(self):
        self.assertEqual(self.call("POST", "/api/auth/login", {"userId": "a", "password": "b"}, {"Content-Type": "application/json"})[0], 403)            # no custom header
        self.assertEqual(self.call("POST", "/api/auth/login", {"userId": "a", "password": "b"}, dict(self.JSON, Origin="http://evil.example"))[0], 403)  # cross-site
        self.assertEqual(self.call("POST", "/api/auth/login", None, {"Content-Type": "text/plain", "X-Requested-With": "MarketLens"}, raw=b"x")[0], 415)
        self.assertEqual(self.call("POST", "/api/auth/login", None, self.JSON, raw=b"{" + b" " * 5000 + b"}")[0], 413)
        self.assertEqual(self.call("POST", "/api/auth/login", None, self.JSON, raw=b"not json")[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/login", None, self.JSON, raw=b"[1]")[0], 400)
        self.assertEqual(self.call("POST", "/api/auth/nothing", {}, self.JSON)[0], 401)       # unknown API paths reveal nothing without a session
        cookie = self.cookie_of(self.post("/api/auth/signup", self.SIGNUP)[1])
        self.assertEqual(self.call("POST", "/api/auth/nothing", {}, dict(self.JSON, Cookie=cookie))[0], 404)

    def test_types_are_enforced_so_odd_json_cannot_break_validation(self):
        for body in ({"userId": ["a"], "password": {"x": 1}}, {"userId": 5, "password": None}, {}):
            self.assertEqual(self.post("/api/auth/login", body)[0], 401)
        self.assertEqual(self.post("/api/auth/signup", {"name": 1, "email": [], "dob": {}, "userId": None, "password": 3})[0], 400)

    def test_recovery_endpoints_and_session_ending_over_http(self):
        s0, h0, d0 = self.post("/api/auth/signup", self.SIGNUP)
        cookie, first_uid = self.cookie_of(h0), d0["user"]["uid"]
        ident = {"name": "asha verma", "email": "ASHA@example.com", "dob": "1990-05-17"}
        self.assertEqual(self.post("/api/auth/forgot-user-id", ident)[2], {"userId": "asha_v"})
        s, _, d = self.post("/api/auth/forgot-user-id", dict(ident, dob="1990-05-18"))
        self.assertEqual((s, d["error"]), (403, "The details do not match our records."))
        s, h, d = self.post("/api/auth/update-credentials", dict(ident, newUserId="asha.new", newPassword="Another-Long-Phrase-9"))
        self.assertEqual((s, d["changed"]), (200, ["user ID", "password"]))
        self.assertEqual(self.call("GET", "/api/config", headers={"Cookie": cookie})[0], 401)                      # old session is gone
        s, h, d = self.post("/api/auth/login", {"userId": "asha.new", "password": "Another-Long-Phrase-9"})
        self.assertEqual(s, 200)
        self.assertEqual(d["user"]["uid"], first_uid)                                                            # same account number after renaming

    def test_auth_endpoints_have_their_own_strict_rate_limit(self):
        config.settings.rate_limit = True
        server._limiter = ratelimit.TokenBuckets({"static": (1000, 1e6), "read": (1000, 1e6), "expensive": (40, 4.0), "write": (10, 0.5), "auth": (3, 0.001)})
        codes = [self.post("/api/auth/login", {"userId": "ghost_user", "password": "bad-password-1"})[0] for _ in range(5)]
        self.assertEqual(codes, [401, 401, 401, 429, 429])
        self.assertEqual(self.call("GET", "/api/auth/status")[0], 200)                                            # other classes unaffected

    def test_import_is_attributed_to_the_signed_in_user_in_the_audit_log(self):
        cookie = self.cookie_of(self.post("/api/auth/signup", self.SIGNUP)[1])
        csv = "CALLS,,PUTS\n,OI,STRIKE,OI\n" + "".join(f",{o},{k},{o}\n" for o, k in ((10, 100), (20, 110), (30, 120)))
        s, _, _ = self.call("POST", "/api/options/import?symbol=NIFTY&expiry=27-Oct-2026&filename=a.csv", raw=csv.encode(), headers={"Content-Type": "text/csv", "X-Requested-With": "MarketLens", "Cookie": cookie})
        self.assertEqual(s, 200)
        e = [x for x in optiondb.audit_log(20) if x["event"] == "import_ok"][0]
        self.assertEqual((e["actor"], e["channel"]), ("asha_v", "web"))

    def test_login_can_be_turned_off(self):
        config.settings.require_login = False
        self.assertEqual(self.call("GET", "/api/config")[0], 200)
        self.assertEqual(self.call("GET", "/api/auth/status")[2]["loginRequired"], False)


if __name__ == "__main__":
    unittest.main()
