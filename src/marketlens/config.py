"""Runtime settings for MarketLens. One module-level `settings` object, filled in by the CLI or tests."""
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path


def default_data_dir() -> Path:
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    elif sys.platform.startswith("win"):
        base = Path(os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming")))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share")))
    return base / "MarketLens"


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 8080
    data_dir: Path = field(default_factory=default_data_dir)
    offline: bool = False          # never call NSE; serve saved snapshots only
    news: bool = True              # fetch Yahoo Finance / Google News RSS
    universe_size: int = 60        # most-traded stocks tracked
    cm_url: str = field(default_factory=lambda: os.environ.get("NSE_CM_MCP_URL", "https://mcp.nseindia.in/cmmkt/mcp"))
    bhavcopy_url: str = field(default_factory=lambda: os.environ.get("NSE_BHAVCOPY_MCP_URL", "https://mcp.nseindia.in/bhavcopy/cm/mcp"))
    fo_url: str = field(default_factory=lambda: os.environ.get("NSE_FO_MCP_URL", ""))  # derivatives MCP (option chain)
    option_interval: int = 150     # seconds between inbox scans / configured-endpoint fetches (2.5 minutes); 0 disables
    option_inbox: str = ""         # folder watched for CSVs you download yourself (default: <data dir>/option-inbox)
    option_symbols: tuple = ("NIFTY", "BANKNIFTY")  # fetched from the configured endpoint on each tick
    rate_limit: bool = True        # per-client token buckets (see ratelimit.py); 429 with Retry-After when exceeded
    max_inflight: int = 64         # concurrent requests before load shedding (503 + Retry-After)
    max_connections: int = 256     # open connections before new ones are refused
    log_requests: bool = True      # one JSON line per API request on stderr
    require_login: bool = True     # accounts: every API call except sign-up/sign-in/recovery needs a session (--no-login turns it off)
    live_orders: bool = field(default_factory=lambda: os.environ.get("MARKETLENS_LIVE_ORDERS", "") == "1")   # allow real orders through the Zerodha adapter (off unless --enable-live-orders)
    public_url: str = ""           # https://your.host when the app sits behind a TLS reverse proxy: adds Secure to the cookie and fixes the allowed Host
    trusted_proxies: tuple = ()    # peer addresses of reverse proxies whose X-Forwarded-For / X-Forwarded-Proto are believed (default: none)
    allowed_hosts: tuple = ()      # Host headers accepted when the server is bound beyond loopback (default: only the public_url host, if any)
    open_signup: object = None     # None = automatic: open on loopback, closed after the first (administrator) account on any other address; True/False forces it
    identity_recovery: object = None   # name + email + date of birth recovery: None = on for loopback only, True/False forces it
    session_idle_seconds: int = 0  # 0 = automatic: no idle limit on loopback, 8 hours on any other address
    pbkdf2_iterations: int = 600_000   # password hashing cost (OWASP 2023 guidance for PBKDF2-SHA256)


settings = Settings()


def inbox_dir() -> Path:
    return Path(settings.option_inbox) if settings.option_inbox else settings.data_dir / "option-inbox"


def is_loopback(host=None):
    return (host or settings.host) in ("127.0.0.1", "localhost", "::1", "[::1]")


def signup_open(users_exist):
    """May a new account be created? The very first account always may (it becomes the administrator); later ones follow the setting."""
    if not users_exist:
        return True
    return is_loopback() if settings.open_signup is None else bool(settings.open_signup)


def recovery_enabled():
    return is_loopback() if settings.identity_recovery is None else bool(settings.identity_recovery)


def session_idle():
    from_setting = settings.session_idle_seconds
    return from_setting if from_setting > 0 else (15 * 24 * 3600 if is_loopback() else 8 * 3600)


def harden_files():
    """Private by default: files this program creates are readable by their owner only (the data folder holds accounts, personal details and the Zerodha session). No effect on Windows."""
    try:
        os.umask(0o077)
    except (AttributeError, OSError):
        pass


def use_bundled_certificates():
    """Make HTTPS work where Python has no certificate store of its own: a frozen desktop app (PyInstaller) and python.org builds on macOS ship without one, so every request to NSE,
    Yahoo, Google and Zerodha fails certificate verification ("no answer from NSE"). Point OpenSSL at certifi's bundle when it is installed. A SSL_CERT_FILE you set yourself
    (for example for a company proxy) that exists is left alone."""
    cur = os.environ.get("SSL_CERT_FILE")
    if cur and os.path.exists(cur):
        return False
    try:
        import certifi
        path = certifi.where()
    except ImportError:
        return False
    if os.path.exists(path):
        os.environ["SSL_CERT_FILE"] = path
        return True
    return False


def configure(**kw) -> Settings:
    for k, v in kw.items():
        if v is None:
            continue
        if not hasattr(settings, k):
            raise AttributeError(k)
        setattr(settings, k, Path(v) if k == "data_dir" else v)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(settings.data_dir, 0o700)
    except OSError:
        pass
    return settings
