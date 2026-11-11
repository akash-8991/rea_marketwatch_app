"""The Zerodha adapter and its server-side gate, against a fake Kite. Nothing touches the network."""
import hashlib
import json
import os
import stat
import tempfile
import unittest
import urllib.parse
from pathlib import Path

from marketlens import broker, config, optiondb, ratelimit


class FakeKite:
    def __init__(self):
        self.calls, self.orders = [], []
        self.fail_orders = None

    def __call__(self, method, url, headers=None, data=None, timeout=12):
        u = urllib.parse.urlparse(url)
        form = dict(urllib.parse.parse_qsl(data.decode())) if data else {}
        self.calls.append((method, u.path, form, dict(headers or {})))
        ok = lambda d: (200, json.dumps({"status": "success", "data": d}).encode())
        if u.path == "/session/token" and method == "POST":
            want = hashlib.sha256((form["api_key"] + form["request_token"] + "SECRET123").encode()).hexdigest()
            if form.get("checksum") != want:
                return 403, json.dumps({"status": "error", "message": "Invalid checksum", "error_type": "TokenException"}).encode()
            return ok({"access_token": "ACCESSTOKEN9", "user_id": "AB1234", "user_name": "Test Person", "email": "t@example.com", "login_time": "2026-11-11 09:00:00"})
        if u.path == "/session/token" and method == "DELETE":
            return ok(True)
        if "Authorization" not in (headers or {}):
            return 403, json.dumps({"status": "error", "message": "Incorrect api_key or access_token", "error_type": "TokenException"}).encode()
        if u.path == "/orders/regular" and method == "POST":
            if self.fail_orders:
                return self.fail_orders
            oid = f"2611{len(self.orders):08d}"
            self.orders.append({"order_id": oid, "status": "OPEN", "filled_quantity": 0, "tag": form["tag"], "average_price": 0})
            return ok({"order_id": oid})
        if u.path.startswith("/orders/regular/") and method == "DELETE":
            return ok({"order_id": u.path.rsplit("/", 1)[1]})
        if u.path == "/orders":
            return ok(self.orders)
        if u.path == "/user/profile":
            return ok({"user_id": "AB1234", "user_name": "Test Person"})
        if u.path == "/user/margins/equity":
            return ok({"net": 123456.0})
        return ok([])


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        optiondb.close()
        self.saved = (config.settings.data_dir, config.settings.live_orders, config.settings.host, config.settings.port, broker._http)
        config.settings.data_dir, config.settings.live_orders = Path(self.tmp.name), False
        self.kite = FakeKite()
        broker._http = self.kite
        broker._tags.clear()
        broker._sent.clear()
        broker._states.clear()

    def tearDown(self):
        optiondb.close()
        config.settings.data_dir, config.settings.live_orders, config.settings.host, config.settings.port, broker._http = self.saved
        self.tmp.cleanup()

    def connect(self, live=False):
        broker.save_credentials("APIKEY12345", "SECRET123")
        url = broker.login_url()["url"]
        state = urllib.parse.unquote(urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["redirect_params"][0]).split("=")[1]
        self.assertTrue(broker.check_state(state))
        broker.exchange("REQTOKEN1234")
        config.settings.live_orders = live

    def order(self, **kw):
        return dict({"tradingsymbol": "RELIANCE", "exchange": "NSE", "transaction_type": "BUY", "order_type": "LIMIT", "quantity": 10, "price": 1200.5, "product": "CNC", "validity": "DAY", "tag": "ML1234abcd"}, **kw)

    def test_login_flow_checksum_state_and_status_never_leak_secrets(self):
        self.assertEqual(broker.status()["configured"], False)
        with self.assertRaises(broker.BrokerError):
            broker.save_credentials("bad key!", "x")
        with self.assertRaises(broker.BrokerError):
            broker.login_url()
        self.connect()
        st = broker.status()
        self.assertTrue(st["connected"] and st["configured"])
        self.assertEqual(st["user"]["id"], "AB1234")
        text = json.dumps(st)
        for secret in ("SECRET123", "ACCESSTOKEN9", "APIKEY12345"):
            self.assertNotIn(secret, text)
        self.assertIn("/broker/callback", st["redirectUrl"])
        self.assertEqual(self.kite.calls[-1][1], "/session/token")
        self.assertEqual(self.kite.calls[-1][2]["checksum"], hashlib.sha256(b"APIKEY12345REQTOKEN1234SECRET123").hexdigest())
        self.assertFalse(broker.check_state("never-issued"), "an unknown state is refused")
        self.assertGreater(st["tokenExpiresAt"], __import__("time").time())

    def test_credentials_file_is_owner_only_and_forget_removes_it(self):
        broker.save_credentials("APIKEY12345", "SECRET123")
        p = Path(self.tmp.name) / "broker.json"
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        broker.forget()
        self.assertFalse(p.exists())
        self.assertFalse(broker.status()["configured"])

    def test_a_wrong_secret_fails_cleanly(self):
        broker.save_credentials("APIKEY12345", "WRONGSECRET")
        with self.assertRaises(broker.BrokerError) as e:
            broker.exchange("REQTOKEN1234")
        self.assertNotIn("WRONGSECRET", str(e.exception))
        self.assertFalse(broker.status()["connected"])

    def test_reads_work_when_connected_and_say_so_when_not(self):
        with self.assertRaises(broker.BrokerError) as e:
            broker.account()
        self.assertEqual(e.exception.status, 401)
        self.connect()
        acc = broker.account()
        self.assertEqual(acc["margins"]["net"], 123456.0)
        self.assertEqual(self.kite.calls[-1][3]["Authorization"], "token APIKEY12345:ACCESSTOKEN9")

    def test_live_orders_are_off_by_default(self):
        self.connect(live=False)
        with self.assertRaises(broker.BrokerError) as e:
            broker.place_order(self.order())
        self.assertEqual(e.exception.status, 403)
        self.assertFalse(any(c[1] == "/orders/regular" for c in self.kite.calls))

    def test_the_gate_rejects_every_unsafe_order(self):
        self.connect(live=True)
        bad = [self.order(order_type="MARKET"), self.order(price=0), self.order(quantity=0), self.order(quantity=2.5 if False else "x"), self.order(tag=""), self.order(tag="has space"),
               self.order(tradingsymbol="bad sym!"), self.order(transaction_type="SHORT"), self.order(product="XXX"), self.order(quantity=1000, price=1200), self.order(exchange="NYSE")]
        for o in bad:
            with self.assertRaises(broker.BrokerError, msg=str(o)):
                broker.place_order(o)
        self.assertFalse(any(c[1] == "/orders/regular" for c in self.kite.calls), "nothing unsafe reached Kite")

    def test_kill_switch_blocks_orders_even_when_live(self):
        self.connect(live=True)
        self.assertTrue(broker.set_kill(True, "test"))
        with self.assertRaises(broker.BrokerError) as e:
            broker.place_order(self.order())
        self.assertEqual(e.exception.status, 423)
        self.assertFalse(broker.set_kill(False))
        self.assertIn("order_id", broker.place_order(self.order()))

    def test_an_order_is_sent_once_per_tag_and_form_fields_are_exact(self):
        self.connect(live=True)
        a = broker.place_order(self.order())
        b = broker.place_order(self.order())
        self.assertEqual(a["order_id"], b["order_id"])
        self.assertTrue(b["duplicate"])
        sent = [c for c in self.kite.calls if c[1] == "/orders/regular"]
        self.assertEqual(len(sent), 1)
        f = sent[0][2]
        self.assertEqual((f["tradingsymbol"], f["exchange"], f["transaction_type"], f["order_type"], f["quantity"], f["price"], f["tag"]), ("RELIANCE", "NSE", "BUY", "LIMIT", "10", "1200.50", "ML1234abcd"))

    def test_orders_per_second_are_capped(self):
        self.connect(live=True)
        for i in range(broker.MAX_OPS):
            broker.place_order(self.order(tag=f"ML00{i}"))
        with self.assertRaises(broker.BrokerError) as e:
            broker.place_order(self.order(tag="ML009"))
        self.assertEqual(e.exception.status, 429)

    def test_a_refusal_frees_the_tag_but_an_unknown_outcome_never_retries(self):
        self.connect(live=True)
        self.kite.fail_orders = (400, json.dumps({"status": "error", "message": "Insufficient funds", "error_type": "InputException"}).encode())
        with self.assertRaises(broker.BrokerError):
            broker.place_order(self.order())
        self.kite.fail_orders = None
        self.assertIn("order_id", broker.place_order(self.order()), "a definite refusal can be fixed and resent with the same tag")
        self.kite.fail_orders = (502, b"{}")
        with self.assertRaises(broker.BrokerError):
            broker.place_order(self.order(tag="ML777"))
        self.kite.fail_orders = None
        self.assertIsNone(broker._tags.get("ML777"), "the tag stays reserved after an unknown outcome")

    def test_status_lookup_by_id_and_tag_maps_to_desk_states(self):
        self.connect(live=True)
        r = broker.place_order(self.order())
        self.assertEqual(broker.order_status(order_id=r["order_id"])["status"], "ACKNOWLEDGED")
        self.kite.orders[0].update(status="COMPLETE", filled_quantity=10, average_price=1201.0)
        s = broker.order_status(tag="ML1234abcd")
        self.assertEqual((s["status"], s["filled"], s["price"]), ("FILLED", 10, 1201.0))
        self.kite.orders[0].update(status="OPEN", filled_quantity=4)
        self.assertEqual(broker.order_status(order_id=r["order_id"])["status"], "PARTIALLY_FILLED")
        self.assertEqual(broker.map_order({"status": "REJECTED", "status_message": "margin"})["reason"], "margin")
        self.assertIsNone(broker.order_status(order_id="nope"))

    def test_cancel_and_logout(self):
        self.connect(live=True)
        self.assertTrue(broker.cancel_order("261100000000"))
        broker.logout()
        self.assertFalse(broker.status()["connected"])
        with self.assertRaises(broker.BrokerError):
            broker.account()

    def test_token_expiry_is_6am_ist_next_day(self):
        import datetime
        IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
        at = lambda s: datetime.datetime.fromisoformat(s).replace(tzinfo=IST).timestamp()
        self.assertEqual(broker._next_expiry(at("2026-11-11T09:00:00")), at("2026-11-12T06:00:00"))
        self.assertEqual(broker._next_expiry(at("2026-11-11T03:00:00")), at("2026-11-11T06:00:00"))

    def test_the_live_flag_and_rate_class_exist(self):
        self.assertFalse(config.Settings().live_orders)
        self.assertIn("broker", ratelimit.DEFAULT_LIMITS)


if __name__ == "__main__":
    unittest.main()
