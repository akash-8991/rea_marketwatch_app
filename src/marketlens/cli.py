"""Command line entry point: `marketlens` or `python -m marketlens`."""
import argparse
import json
import threading
import webbrowser

from . import __version__, config


def build_parser():
    p = argparse.ArgumentParser(prog="marketlens", description="MarketLens: local NSE markets dashboard (prices, news, screener, option chain).")
    p.add_argument("--host", default=None, help="interface to bind (default 127.0.0.1; keep it local, there is no login)")
    p.add_argument("--port", type=int, default=None, help="port (default 8080)")
    p.add_argument("--data-dir", default=None, help="where snapshots and caches are kept (default: your user data folder)")
    p.add_argument("--offline", action="store_true", help="never call NSE; serve saved snapshots only")
    p.add_argument("--no-news", action="store_true", help="do not fetch Yahoo Finance / Google News headlines")
    p.add_argument("--fo-mcp-url", default=None, help="NSE derivatives MCP endpoint used for the option chain (or set NSE_FO_MCP_URL)")
    p.add_argument("--option-inbox", default=None, help="folder to drop NSE option-chain CSVs into (default: <data dir>/option-inbox)")
    p.add_argument("--option-interval", type=int, default=None, help="seconds between inbox scans / endpoint fetches (default 150 = 2.5 min, 0 = off)")
    p.add_argument("--no-rate-limit", action="store_true", help="disable per-client rate limits (for benchmarking on your own machine)")
    p.add_argument("--audit", type=int, nargs="?", const=20, default=None, metavar="N", help="print the last N audit-log entries (default 20) and whether the hash chain verifies, then exit")
    p.add_argument("--audit-expect", metavar="HASH", default=None, help="with --audit: also check that this previously recorded head hash is still part of the chain")
    p.add_argument("--no-login", action="store_true", help="turn accounts off: no sign-in screen (for a single user on a trusted machine)")
    p.add_argument("--list-users", action="store_true", help="print the registered user IDs and exit")
    p.add_argument("--reset-password", metavar="USERID", default=None, help="set a new password for USERID (asks for it; machine owner only) and exit")
    p.add_argument("--make-admin", metavar="USERID", default=None, help="make USERID an administrator (broker connection, audit log, metrics, CSV import) and exit")
    p.add_argument("--public-url", default=None, metavar="URL", help="the https:// address people use when the app sits behind a TLS proxy: cookies get Secure and only that Host is accepted")
    p.add_argument("--allowed-host", action="append", default=None, metavar="HOST[:PORT]", help="Host header accepted when bound beyond loopback (repeatable)")
    p.add_argument("--trusted-proxy", action="append", default=None, metavar="IP", help="address of a reverse proxy whose X-Forwarded-For and X-Forwarded-Proto are believed (repeatable)")
    p.add_argument("--open-signup", action="store_true", help="let anyone who can reach the server create an account (default: only on loopback; elsewhere just the first, administrator, account)")
    p.add_argument("--no-recovery", action="store_true", help="switch off online recovery by name, email and date of birth (default: off when bound beyond loopback)")
    p.add_argument("--allow-recovery", action="store_true", help="allow online recovery by name, email and date of birth even when bound beyond loopback (weak: see docs/OPERATIONS.md)")
    p.add_argument("--session-idle-hours", type=float, default=None, help="sign out after this many idle hours (default: no limit on loopback, 8 elsewhere)")
    p.add_argument("--enable-live-orders", action="store_true", help="allow real orders to be sent to Zerodha through the Settings > Broker connection (off by default; see docs/BROKER.md before using it)")
    p.add_argument("--no-open", action="store_true", help="do not open a browser window")
    p.add_argument("--version", action="version", version=f"marketlens {__version__}")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    config.use_bundled_certificates()
    config.harden_files()
    config.configure(host=args.host, port=args.port, data_dir=args.data_dir, offline=True if args.offline else None,
                     news=False if args.no_news else None, fo_url=args.fo_mcp_url,
                     option_inbox=args.option_inbox, option_interval=args.option_interval,
                     rate_limit=False if args.no_rate_limit else None, require_login=False if args.no_login else None,
                     live_orders=True if args.enable_live_orders else None, public_url=args.public_url, allowed_hosts=tuple(args.allowed_host) if args.allowed_host else None,
                     trusted_proxies=tuple(args.trusted_proxy) if args.trusted_proxy else None, open_signup=True if args.open_signup else None,
                     identity_recovery=False if args.no_recovery else (True if args.allow_recovery else None),
                     session_idle_seconds=int(args.session_idle_hours * 3600) if args.session_idle_hours else None)
    if args.make_admin:
        from . import accounts
        try:
            accounts.set_admin(args.make_admin, True)
        except accounts.AuthError as e:
            print(f"Error: {e}")
            return 1
        print(f"{args.make_admin} is now an administrator.")
        return 0
    if args.list_users or args.reset_password:
        from . import accounts
        if args.list_users:
            for u in accounts.list_users():
                print(json.dumps(u))
            return 0
        try:
            accounts.admin_reset_password(args.reset_password, accounts.prompt_new_password())
        except accounts.AuthError as e:
            print(f"Error: {e}")
            return 1
        print(f"Password changed for {args.reset_password}; all their sessions were ended.")
        return 0
    if args.audit is not None:
        from . import optiondb
        for e in reversed(optiondb.audit_log(args.audit)):
            print(json.dumps(e))
        v = optiondb.verify_audit(args.audit_expect)
        print(json.dumps({"auditChain": "intact" if v["ok"] else "BROKEN", **v}))
        return 0 if v["ok"] else 1
    httpd = start(args)
    url = f"http://{config.settings.host}:{config.settings.port}/"
    if not args.no_open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


def start(args):
    """Create the server for already-parsed, already-configured arguments, start the background jobs, print the start-up summary and return the server (not yet serving).
    Shared by the command line and the desktop app so both start exactly the same thing."""
    if config.settings.live_orders and not config.is_loopback() and not config.settings.require_login:
        raise SystemExit("Refusing to start: live orders are enabled, the server is reachable beyond this computer and accounts are off (--no-login). Remove one of the three.")
    from . import server  # imported after configuration so paths pick up the data dir
    httpd = server.make_server()
    from . import securities
    securities.start_background()   # loads the saved stock lists and refreshes them from the official downloads when they are due
    url = f"http://{config.settings.host}:{config.settings.port}/"
    print(f"MarketLens {__version__} running at {url}")
    print(f"  data folder : {config.settings.data_dir}")
    print(f"  NSE data    : {'offline (saved snapshots only)' if config.settings.offline else 'live, fetched on demand and cached'}")
    print(f"  news        : {'off' if not config.settings.news else 'Yahoo Finance + Google News RSS'}")
    print(f"  stock list  : NSE Nifty Total Market constituents ({len(securities.ROWS)} stocks, weekly) + all NSE-listed equities ({len(securities.LISTED)}, every 6 hours), unless offline")
    print(f"  accounts    : {'sign-in required (--no-login to turn off)' if config.settings.require_login else 'off (--no-login): anyone who can open the page can use it'}")
    print(f"  option chain: inbox {config.inbox_dir()} scanned every {config.settings.option_interval}s; "
          f"{'endpoint configured' if config.settings.fo_url else 'no MCP endpoint (see --fo-mcp-url)'}")
    print(f"  live orders : {'ENABLED (--enable-live-orders): orders can be sent to Zerodha' if config.settings.live_orders else 'off (reading and paper trading only)'}")
    if not config.is_loopback():
        print(f"  exposure    : bound to {config.settings.host}: " + ("public URL " + config.settings.public_url if config.settings.public_url else "no --public-url or --allowed-host set, so the Host header is not checked and cookies are not marked Secure; put a TLS proxy in front and set them")
              + f"; registration {'open' if config.signup_open(True) else 'closed after the first (administrator) account'}; online recovery {'on' if config.recovery_enabled() else 'off'}")
    print("  Press Ctrl+C to stop.")
    return httpd
