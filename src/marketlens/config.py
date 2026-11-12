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
    pbkdf2_iterations: int = 600_000   # password hashing cost (OWASP 2023 guidance for PBKDF2-SHA256)


settings = Settings()


def inbox_dir() -> Path:
    return Path(settings.option_inbox) if settings.option_inbox else settings.data_dir / "option-inbox"


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
    return settings
