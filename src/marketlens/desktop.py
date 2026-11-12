"""MarketLens desktop app: a double-click program (`marketlens-desktop`, or the MarketLens.app / MarketLens.exe built from it) that starts the local server and opens its own window.

It is the same app and the same screens as the phone app: on first start you create an account (name, email, date of birth, user ID, password), afterwards you sign in with the
user ID and password, and you stay signed in for up to 15 days (until you sign out). Sign-in is always required here: there is no --no-login in the desktop launcher, so the app can never
open without a login screen. Accounts and data live in the user's data folder and survive updates.

Window: if pywebview is installed (`pip install "marketlens[desktop]"`) a native window is used. Otherwise the launcher opens Chrome, Edge, Chromium or Brave in app mode (their own window,
no tabs or address bar, with a private profile in the data folder so closing the window really ends the session). Otherwise a small control window (tkinter) or the default browser.
Closing the window quits the app. `--check` starts the server on a spare port, signs up and signs in a throw-away account to prove the login works, and exits (used to test the packages).
"""
import argparse
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser

from . import __version__, config

APP_NAME = "MarketLens"


def _ensure_streams():
    """A windowed program has no console: give print() somewhere to go so start-up never fails on it."""
    if sys.stdout is None or sys.stderr is None:
        log = os.path.join(str(config.settings.data_dir), "desktop.log")
        os.makedirs(str(config.settings.data_dir), exist_ok=True)
        f = open(log, "a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stdout or f
        sys.stderr = sys.stderr or f


def free_port(preferred=8080, host="127.0.0.1", tries=40):
    """The preferred port if it is free, else the next free one (so a second copy, or another program, never blocks start-up)."""
    for p in range(preferred, preferred + tries):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, p))
                return p
            except OSError:
                continue
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def app_browser():
    """Path of an installed Chromium-family browser that can open a bare app window, or None."""
    names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser", "chrome"]
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    candidates = []
    if sys.platform == "darwin":
        for a in ("Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"):
            candidates.append(f"/Applications/{a}.app/Contents/MacOS/{a}")
    elif sys.platform.startswith("win"):
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
            if base:
                candidates += [os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"), os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                               os.path.join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")]
    return next((c for c in candidates if os.path.exists(c)), None)


def wait_ready(url_host, port, timeout=30.0):
    """Wait until the server answers /healthz."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            c = http.client.HTTPConnection(url_host, port, timeout=2)
            c.request("GET", "/healthz")
            if c.getresponse().status == 200:
                return True
        except OSError:
            time.sleep(0.15)
    return False


def open_window(url, quit_server):
    """Show the app. Returns only when the window is closed (then the caller quits)."""
    try:
        import webview  # optional: pip install "marketlens[desktop]"
        webview.create_window(APP_NAME, url, width=1440, height=900, min_size=(360, 480))
        webview.start()
        return "native window"
    except ImportError:
        pass
    exe = app_browser()
    if exe:
        profile = os.path.join(str(config.settings.data_dir), "browser-profile")   # its own profile: the window is a separate program, and closing it ends it
        os.makedirs(profile, exist_ok=True)
        subprocess.run([exe, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1440,900", "--no-first-run", "--no-default-browser-check"], check=False)
        return "browser app window"
    try:
        import tkinter
        root = tkinter.Tk()
        root.title(APP_NAME)
        tkinter.Label(root, text=f"{APP_NAME} is running at\n{url}", padx=24, pady=16).pack()
        tkinter.Button(root, text="Open in my browser", command=lambda: webbrowser.open(url)).pack(pady=4)
        tkinter.Button(root, text="Quit", command=root.destroy).pack(pady=(4, 16))
        webbrowser.open(url)
        root.mainloop()
        return "control window"
    except Exception:
        webbrowser.open(url)
        print(f"{APP_NAME} is running at {url}. Press Ctrl+C to quit.")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return "default browser"


def tls_check(host="mcp.nseindia.in"):
    """Does HTTPS verification work in this program? A certificate failure is a FAIL (the app could not reach NSE for anyone); no network at all is only noted."""
    import ssl
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((host, 443), timeout=8) as s, ctx.wrap_socket(s, server_hostname=host):
            return f"HTTPS certificates verified ({host})"
    except ssl.SSLCertVerificationError as e:
        return f"FAIL: HTTPS certificate verification failed ({getattr(e, 'verify_message', e)}): the program has no certificate store"
    except OSError:
        return "HTTPS not tested (no network)"


def self_check(out_file=None):
    """Prove the packaged app can sign a user up and in: start on a spare port with a throw-away data folder, sign up, read the session back, sign out. Exit code 0 means it works."""
    tmp = tempfile.mkdtemp(prefix="marketlens-check-")

    def report(line):   # a windowed program has no console, so the verdict can also go to a file
        print(line)
        if out_file:
            with open(out_file, "w", encoding="utf-8") as f:
                f.write(line + "\n")
    try:
        config.configure(host="127.0.0.1", port=0, data_dir=tmp, offline=True, news=False, option_interval=0, require_login=True, log_requests=False)
        from . import cli
        httpd = cli.start(argparse.Namespace())
        port = httpd.server_address[1]
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        if not wait_ready("127.0.0.1", port, 15):
            report("FAIL: server did not start")
            return 1

        def call(method, path, body=None, cookie=None):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
            h = {"X-Requested-With": "MarketLens", "Content-Type": "application/json"}
            if cookie:
                h["Cookie"] = cookie
            c.request(method, path, json.dumps(body) if body is not None else None, h)
            r = c.getresponse()
            return r.status, r.getheader("Set-Cookie"), json.loads(r.read() or b"{}")

        st, _, status = call("GET", "/api/auth/status")
        assert st == 200 and status["loginRequired"] is True, f"login must be required: {status}"
        assert call("GET", "/api/bootstrap")[0] == 401, "data must need a session"
        st, cookie, body = call("POST", "/api/auth/signup", {"name": "Check User", "email": "check@example.com", "dob": "1990-01-01", "userId": "checkuser1", "password": "Zq9!vLm4#Rw7xK2p"})
        assert st == 201 and cookie, f"sign-up failed: {st} {body}"
        cookie = cookie.split(";")[0]
        st, _, me = call("GET", "/api/auth/me", cookie=cookie)
        assert st == 200 and me["user"]["userId"] == "checkuser1", f"session did not hold: {st} {me}"
        st, _, _ = call("POST", "/api/auth/logout", {}, cookie=cookie)
        assert st == 200
        assert call("GET", "/api/auth/me", cookie=cookie)[0] == 401, "signed out"
        st, cookie2, body = call("POST", "/api/auth/login", {"userId": "checkuser1", "password": "Zq9!vLm4#Rw7xK2p"})
        assert st == 200 and cookie2, f"sign-in failed: {st} {body}"
        tls = tls_check()
        if tls.startswith("FAIL"):
            report(tls)
            return 1
        report(f"OK: {APP_NAME} {__version__} - sign-up, session, sign-out and sign-in work (login is required); {tls}.")
        httpd.shutdown()
        return 0
    except AssertionError as e:
        report(f"FAIL: {e}")
        return 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def build_parser():
    p = argparse.ArgumentParser(prog="marketlens-desktop", description=f"{APP_NAME} desktop app: starts the local server and opens its own window. Sign-in is always required.")
    p.add_argument("--port", type=int, default=None, help="port to use (default 8080, or the next free one)")
    p.add_argument("--data-dir", default=None, help="where accounts and data are kept (default: your user data folder)")
    p.add_argument("--offline", action="store_true", help="never call NSE; serve saved snapshots only")
    p.add_argument("--no-news", action="store_true", help="do not fetch Yahoo Finance / Google News headlines")
    p.add_argument("--enable-live-orders", action="store_true", help="allow real orders to Zerodha (off by default; see docs/BROKER.md)")
    p.add_argument("--browser", action="store_true", help="open the default browser instead of an app window")
    p.add_argument("--check", action="store_true", help="self-test: start, sign up, sign in, exit (0 = the login works)")
    p.add_argument("--check-out", default=None, metavar="FILE", help="also write the self-test verdict to FILE (a windowed program has no console)")
    p.add_argument("--version", action="version", version=f"{APP_NAME} desktop {__version__}")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    config.use_bundled_certificates()   # a frozen app has no system certificate store: without this every request to NSE fails verification
    config.configure(data_dir=args.data_dir)
    _ensure_streams()
    if args.check:
        return self_check(args.check_out)
    port = free_port(args.port or 8080)
    # require_login is forced on: the desktop app never starts without its sign-in screen
    config.configure(host="127.0.0.1", port=port, data_dir=args.data_dir, offline=True if args.offline else None, news=False if args.no_news else None,
                     live_orders=True if args.enable_live_orders else None, require_login=True)
    from . import cli
    httpd = cli.start(argparse.Namespace())
    threading.Thread(target=httpd.serve_forever, daemon=True, name="server").start()
    if not wait_ready("127.0.0.1", port):
        print("The server did not start; see the log in the data folder.")
        return 1
    url = f"http://127.0.0.1:{port}/"
    if args.browser:
        webbrowser.open(url)
        print(f"{APP_NAME} is running at {url}. Press Ctrl+C to quit.")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    else:
        how = open_window(url, httpd.shutdown)
        print(f"{APP_NAME}: {how} closed; quitting.")
    httpd.shutdown()
    httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
