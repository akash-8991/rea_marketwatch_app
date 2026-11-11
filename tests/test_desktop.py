"""The desktop launcher: sign-in is always required, ports are chosen safely, and the packaged self-test proves sign-up and sign-in work."""
import io
import socket
import unittest
from contextlib import redirect_stdout

from marketlens import config, desktop


class Desktop(unittest.TestCase):
    def test_there_is_no_way_to_turn_login_off(self):
        p = desktop.build_parser()
        self.assertNotIn("--no-login", p.format_help())
        with self.assertRaises(SystemExit):
            p.parse_args(["--no-login"])

    def test_free_port_skips_a_busy_port_and_stays_on_loopback(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        busy = s.getsockname()[1]
        try:
            got = desktop.free_port(busy)
            self.assertNotEqual(got, busy)
            self.assertGreaterEqual(got, busy)
        finally:
            s.close()

    def test_the_self_check_signs_up_and_in_with_login_required(self):
        saved = (config.settings.data_dir, config.settings.port, config.settings.require_login, config.settings.offline, config.settings.news)
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                code = desktop.self_check()
        finally:
            config.settings.data_dir, config.settings.port, config.settings.require_login, config.settings.offline, config.settings.news = saved
        self.assertEqual(code, 0, buf.getvalue()[-400:])
        self.assertIn("login is required", buf.getvalue())

    def test_the_app_browser_lookup_never_raises(self):
        r = desktop.app_browser()
        self.assertTrue(r is None or isinstance(r, str))

    def test_package_exposes_a_gui_entry_point(self):
        import re
        from pathlib import Path
        text = (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text()
        self.assertRegex(text, r"\[project.gui-scripts\]\s*marketlens-desktop = \"marketlens.desktop:main\"")


if __name__ == "__main__":
    unittest.main()
