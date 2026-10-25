"""Local HTTP server: serves the web app and a small JSON API. Binds to localhost by default.

Operational behaviour (see docs/OPERATIONS.md):
- HTTP/1.1 keep-alive, a real listen backlog, a cap on open connections and on in-flight requests (503 + Retry-After
  beyond it), and per-client token-bucket rate limits (429 + Retry-After).
- Every response carries X-Request-ID; API requests are logged as one JSON line each (no query strings, no bodies).
- /healthz (liveness), /readyz (readiness), /api/metrics (latency percentiles, counters, data freshness).
- Static files are served from memory with ETag, gzip and revalidation; directory listings do not exist.
"""
import gzip
import hashlib
import json
import math
import os
import re
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import accounts, analysis, market, news, nse, optiondb, options, ratelimit, scheduler, securities, store
from .config import settings
from .metrics import metrics

STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
MAX_UPLOAD = optiondb.MAX_CSV_BYTES
LOOPBACK = ("127.0.0.1", "localhost", "::1", "[::1]")
RID_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")
KNOWN_ROUTES = {"/healthz", "/readyz", "/api/config", "/api/bootstrap", "/api/extras", "/api/sentiment", "/api/search", "/api/options",
                "/api/options/meta", "/api/options/import", "/api/audit", "/api/metrics", "/api/vitals",
                "/api/auth/status", "/api/auth/me", "/api/auth/signup", "/api/auth/login", "/api/auth/logout", "/api/auth/forgot-user-id", "/api/auth/update-credentials"}
PUBLIC_API = {"/api/auth/status", "/api/auth/signup", "/api/auth/login", "/api/auth/logout", "/api/auth/forgot-user-id", "/api/auth/update-credentials"}
COOKIE = "ml_session"
MAX_AUTH_BODY = 4096
CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png",
          ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"}
COMPRESSIBLE = ("text/", "application/json", "image/svg")
_limiter = ratelimit.TokenBuckets()
_suppressed = {}
_audit_gate = {}  # event class -> last time we wrote an audit row (floods are summarised, not logged one by one)
_static_cache = {}


# ---------- payloads ----------
def bootstrap_payload():
    """Live data when NSE answers; otherwise the last saved snapshot, flagged stale."""
    try:
        boot = dict(store.cached("bootstrap", 60, market.build_bootstrap), stale=False)
    except Exception as e:
        snap = store.disk_get("bootstrap")
        if snap is None:
            raise
        boot = dict(snap, stale=True, staleReason=str(e)[:200], retryInSeconds=nse.retry_in_seconds())
    boot["offline"] = settings.offline
    valid = {sec for sec, _ in market.SECTOR_INDICES}
    boot["sectorIndices"] = [x for x in boot.get("sectorIndices", []) if x.get("sector") in valid]   # tiles saved by an older release carry old labels
    boot["stocks"] = [dict(s, sector=market.SECTOR_MAP.get(s["sym"], "Other"), techSnap=analysis.technical_snapshot(s)) for s in boot["stocks"]]   # classification applied at serve time, so saved snapshots follow the current list
    return boot


def extras_payload():
    boot = store.disk_get("bootstrap") or {}
    stocks = boot.get("stocks", [])
    market.start_extras([s["sym"] for s in stocks])
    raw = store.disk_get("extras")
    st = market.extras_state()
    return {"ready": raw is not None, "refreshing": st["state"] == "running", "done": st["done"], "total": st["total"],
            "data": market.derive_extras(raw, stocks, boot) if raw else {}}


def stock_payload(sym):
    try:
        d = dict(store.cached("stock:" + sym, 300, lambda: market.stock_detail(sym)), stale=False)
    except Exception as e:
        d = store.disk_get("stock-" + sym)
        if d is None:
            raise
        d = dict(d, stale=True, staleReason=str(e)[:200])
    meta = securities.get(sym) or {}
    return dict(d, analysis=market.analyze_detail(d), company=meta.get("company"), industry=meta.get("industry"))


def config_payload():
    return {"offline": settings.offline, "news": settings.news, "loginRequired": settings.require_login, "options": options.status(), "version": _version(), "rules": analysis.RULES,
            "rateLimits": {k: {"burst": v[0], "perSecond": v[1]} for k, v in _limiter.limits.items()} if settings.rate_limit else None}


def readiness():
    checks = {}
    checks["dataDirWritable"] = os.access(str(settings.data_dir), os.W_OK)
    try:
        optiondb._db().execute("SELECT 1").fetchone()
        checks["database"] = True
    except Exception:
        checks["database"] = False
    checks["dataAvailable"] = store.disk_get("bootstrap") is not None or nse.available()
    return {"ready": all(checks.values()), "checks": checks}


def metrics_payload():
    out = metrics.snapshot()
    ages = {name: store.disk_age(key) for name, key in (("bootstrap", "bootstrap"), ("extras", "extras"), ("sentiment", "sentiment"),
                                                         ("newsIndia", "news-india"), ("newsGlobal", "news-global"))}
    out["dataAgeSeconds"] = {k: (None if v is None else round(v)) for k, v in ages.items()}
    out["upstream"] = {"nseOffline": settings.offline, "nseAvailable": nse.available(), "nseRetryInSeconds": nse.retry_in_seconds()}
    out["rateLimiterKeys"] = _limiter.size()
    out["scheduler"] = scheduler.status()
    return out


def _version():
    from . import __version__
    return __version__


# ---------- request classification ----------
def route_label(path):
    """Bounded-cardinality label for metrics: templates, never raw paths."""
    if path.startswith("/api/stock/"):
        return "/api/stock/:sym"
    if path.startswith("/api/peers/"):
        return "/api/peers/:sym"
    if path.startswith("/api/news/stock/"):
        return "/api/news/stock/:sym"
    if re.fullmatch(r"/api/news/(india|global)", path):
        return "/api/news/:region"
    if path in KNOWN_ROUTES:
        return path
    return "/api/other" if path.startswith("/api/") else "/static"


def classify(method, path):
    """Traffic class used for rate limiting; None means exempt (health probes)."""
    if path in ("/healthz", "/readyz"):
        return None
    if method == "POST":
        return "auth" if path.startswith("/api/auth/") else "write"
    if path.startswith(("/api/stock/", "/api/peers/", "/api/search", "/api/news/")) or path == "/api/options":
        return "expensive"
    return "read" if path.startswith("/api/") else "static"


def _clean_filename(name):
    name = os.path.basename(urllib.parse.unquote(name or ""))
    return re.sub(r"[^A-Za-z0-9._ -]", "_", name)[:120]


def load_static(rel):
    """Return a cached {body, gz, etag, ctype} for a file inside the static folder, or None (never outside it)."""
    rel = rel.lstrip("/") or "index.html"
    if "\x00" in rel:
        return None
    root = os.path.realpath(STATIC)
    full = os.path.realpath(os.path.join(root, rel))
    if not full.startswith(root + os.sep) or not os.path.isfile(full):
        return None
    st = os.stat(full)
    key = (st.st_mtime_ns, st.st_size)
    hit = _static_cache.get(full)
    if hit and hit[0] == key:
        return hit[1]
    with open(full, "rb") as f:
        body = f.read()
    ctype = CTYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
    entry = {"body": body, "ctype": ctype, "etag": '"%s"' % hashlib.sha1(body).hexdigest()[:20],
             "gz": gzip.compress(body, 6, mtime=0) if len(body) > 1024 and ctype.startswith(COMPRESSIBLE) else None}
    _static_cache[full] = (key, entry)
    return entry


def _gate(name, seconds=60.0):
    """True at most once per `seconds` for an event class, so floods become one audit row instead of thousands."""
    now = time.monotonic()
    if now - _audit_gate.get(name, -1e9) >= seconds:
        _audit_gate[name] = now
        return True
    return False


# ---------- handler ----------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # keep-alive: far fewer connections than HTTP/1.0 (see docs/ASSESSMENT.md)
    timeout = 30                    # idle connections are closed after 30 s
    server_version = "MarketLens"
    sys_version = ""

    def log_message(self, *args):   # replaced by structured logging in _dispatch
        pass

    # --- response helpers
    def _headers_common(self, ctype=None):
        self.send_header("X-Request-ID", self.rid)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")

    def _send(self, status, body=b"", ctype="application/json", extra=None, gz=None):
        self.status = status
        use_gz = gz is not None and "gzip" in (self.headers.get("Accept-Encoding") or "")
        payload = gz if use_gz else body
        self.send_response(status)
        self._headers_common()
        if status != 304:
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(payload)))
            if gz is not None:
                self.send_header("Vary", "Accept-Encoding")
                if use_gz:
                    self.send_header("Content-Encoding", "gzip")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        if self.command == "POST" and not self._body_read:
            self.send_header("Connection", "close")   # an unread request body would corrupt the next keep-alive request
            self.close_connection = True
        self.end_headers()
        self.sent = len(payload)
        if self.command != "HEAD" and status != 304:
            self.wfile.write(payload)

    def _json(self, obj, code=200, extra=None):
        body = json.dumps(obj).encode()
        gz = gzip.compress(body, 5, mtime=0) if len(body) > 1024 else None
        self._send(code, body, "application/json", dict({"Cache-Control": "no-store"}, **(extra or {})), gz)

    def _error(self, code, message, headers=None, **more):
        self._json(dict({"error": message, "requestId": self.rid}, **more), code, headers)

    def _request_id(self):
        rid = self.headers.get("X-Request-ID", "")
        return rid if RID_RE.match(rid) else uuid.uuid4().hex[:16]

    # --- guards
    def _guard(self):
        """Block DNS-rebinding and cross-site requests: only our own loopback origin may call the server."""
        if settings.host not in LOOPBACK:
            return True
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        if (self.headers.get("Host") or "").lower() not in hosts:
            self._error(403, "forbidden host")
            return False
        origin = self.headers.get("Origin")
        if origin and origin.lower() not in {f"http://{h}" for h in hosts}:
            self._error(403, "forbidden origin")
            return False
        return True

    def _limited(self, cls):
        """Apply the token bucket for this client and class; True when the request may proceed."""
        try:
            ok, retry = _limiter.allow(self.client_address[0], cls)
        except Exception as e:  # a limiter bug must not take the app down: fail open, but say so
            self._log("error", "rate_limiter_failed", error=e.__class__.__name__)
            return True
        if ok:
            return True
        metrics.incr("rate_limited")
        if _gate("rate:" + cls):
            optiondb.safe_audit("rate_limited", "server", f"{cls} limit exceeded", outcome="denied")
        wait = max(1, math.ceil(retry))
        self._error(429, "rate limit exceeded; slow down", {"Retry-After": str(wait)}, trafficClass=cls, retryAfterSeconds=wait)
        return False

    # --- request lifecycle
    def _dispatch(self, method):
        t0 = time.perf_counter()
        self.status, self.sent, self._body_read, self.route, self.user = 0, 0, False, "other", None
        self.rid = self._request_id()
        optiondb.ctx.request_id, optiondb.ctx.channel = self.rid, "web"
        admitted = self.server.slots.acquire(blocking=False)
        if admitted:
            metrics.gauge_inflight(1)
        try:
            path = urllib.parse.urlparse(self.path).path
            self.route = route_label(path)
            if not admitted:
                metrics.incr("load_shed")
                if _gate("shed"):
                    optiondb.safe_audit("load_shed", "server", f"more than {settings.max_inflight} requests in flight", outcome="denied")
                return self._error(503, "server busy; retry shortly", {"Retry-After": "1"}, retryAfterSeconds=1)
            if not self._guard():
                return
            cls = classify(method, path)
            if cls and settings.rate_limit and not self._limited(cls):
                return
            self.user = self._current_user() if settings.require_login else None
            if settings.require_login and path.startswith("/api/") and path not in PUBLIC_API and not self.user:
                return self._error(401, "authentication required")   # enforced here, not only in the browser
            self._route(method, path)
        except Exception as e:
            metrics.incr("internal_errors")
            last = traceback.extract_tb(e.__traceback__)[-1]
            self._log("error", "unhandled_exception", error=e.__class__.__name__, where=f"{os.path.basename(last.filename)}:{last.lineno}")
            if not self.status:
                self._error(500, "internal error")
        finally:
            if admitted:
                metrics.gauge_inflight(-1)
                self.server.slots.release()
            ms = (time.perf_counter() - t0) * 1000
            metrics.observe(self.route, self.status or 500, ms)
            if settings.log_requests and (self.route.startswith("/api") or self.status >= 400):
                if self.status in (429, 503):   # a flood of rejections becomes one summary line every 5 s, not one line each
                    _suppressed[self.route] = _suppressed.get(self.route, 0) + 1
                    if _gate("log:" + self.route, 5.0):
                        self._log("warn", "request", ms=round(ms, 2), suppressedSinceLast=_suppressed.pop(self.route) - 1)
                else:
                    self._log("warn" if self.status >= 400 else "info", "request", ms=round(ms, 2))

    def _log(self, level, msg, **more):
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z", "level": level, "msg": msg, "requestId": getattr(self, "rid", None),
               "method": self.command, "route": getattr(self, "route", None), "status": getattr(self, "status", None), "bytes": getattr(self, "sent", None),
               "client": self.client_address[0]}
        rec.update(more)
        sys.stderr.write(json.dumps(rec) + "\n")

    def do_GET(self):
        self._dispatch("GET")

    do_HEAD = do_GET

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    do_DELETE = do_PATCH = do_PUT

    # --- accounts
    def _token(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        try:
            c = SimpleCookie()
            c.load(raw)
            m = c.get(COOKIE)
            return m.value if m else None
        except Exception:
            return None

    def _current_user(self):
        try:
            return accounts.user_for_token(self._token())
        except Exception as e:
            self._log("error", "session_lookup_failed", error=e.__class__.__name__)
            return None

    @staticmethod
    def _cookie(token):
        return f"{COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={accounts.SESSION_IDLE if token else 0}"

    def _auth_post(self, path):
        if self.headers.get("X-Requested-With") != "MarketLens":
            return self._error(403, "missing X-Requested-With header")
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return self._error(415, "send application/json")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if not 0 < length <= MAX_AUTH_BODY:
            return self._error(413 if length > MAX_AUTH_BODY else 400, "request body must be 1 to 4096 bytes")
        raw = self.rfile.read(length)
        self._body_read = True
        try:
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError
        except ValueError:
            return self._error(400, "invalid JSON")
        g = lambda k, n=200: body.get(k) if isinstance(body.get(k), str) and len(body.get(k)) <= n else ""
        try:
            if path == "/api/auth/signup":
                row = accounts.signup(g("name"), g("email"), g("dob", 20), g("userId", 40), g("password", 128))
                return self._json({"user": {"uid": row[0], "userId": row[1], "name": row[2]}}, 201, {"Set-Cookie": self._cookie(accounts.create_session(row[0]))})
            if path == "/api/auth/login":
                row = accounts.login(g("userId", 64), g("password", 256))
                return self._json({"user": {"uid": row[0], "userId": row[1], "name": row[2]}}, 200, {"Set-Cookie": self._cookie(accounts.create_session(row[0]))})
            if path == "/api/auth/logout":
                accounts.end_session(self._token())
                return self._json({"ok": True}, 200, {"Set-Cookie": self._cookie("")})
            if path == "/api/auth/forgot-user-id":
                return self._json({"userId": accounts.forgot_user_id(g("name"), g("email"), g("dob", 20))})
            if path == "/api/auth/update-credentials":
                changed = accounts.update_credentials(g("name"), g("email"), g("dob", 20), g("newUserId", 40), g("newPassword", 128))
                return self._json({"changed": changed}, 200, {"Set-Cookie": self._cookie("")})   # sessions ended: sign in again
        except accounts.AuthError as e:
            metrics.incr("auth_failures")
            more = {"field": e.field} if e.field else {}
            if e.retry_after:
                more["retryAfterSeconds"] = e.retry_after
            return self._error(e.status, str(e), {"Retry-After": str(e.retry_after)} if e.retry_after else None, **more)
        return self._error(404, "not found")

    # --- routing
    def _route(self, method, path):
        u = urllib.parse.urlparse(self.path)
        if method == "POST":
            return self._post(u)
        if method not in ("GET", "HEAD"):
            return self._error(405, "method not allowed", {"Allow": "GET, HEAD, POST"})
        if path == "/healthz":
            return self._json({"status": "ok", "version": _version(), "uptimeSeconds": round(time.time() - metrics.started, 1)})
        if path == "/readyz":
            r = readiness()
            return self._json(r, 200 if r["ready"] else 503)
        if not path.startswith("/api/"):
            return self._static(path)
        if method == "HEAD":
            return self._error(405, "method not allowed", {"Allow": "GET"})
        qs = urllib.parse.parse_qs(u.query)
        try:
            return self._api_get(path, qs)
        except nse.UpstreamBlocked as e:
            return self._error(502, str(e)[:300])
        except Exception as e:  # upstream failure: report it, never crash the server
            return self._error(502, str(e)[:300])

    def _static(self, path):
        entry = load_static(urllib.parse.unquote(path))
        if entry is None:
            return self._send(404, b"Not found", "text/plain; charset=utf-8", {"Cache-Control": "no-store"})
        extra = {"ETag": entry["etag"], "Cache-Control": "no-cache"}   # revalidate, so upgrading never leaves stale JS in the browser
        if self.headers.get("If-None-Match") == entry["etag"]:
            return self._send(304, b"", entry["ctype"], extra)
        self._send(200, entry["body"], entry["ctype"], extra, entry["gz"])

    def _api_get(self, p, qs):
        if p == "/api/auth/status":
            return self._json({"loginRequired": settings.require_login, "usersExist": accounts.user_count() > 0, "signedIn": bool(self.user)})
        if p == "/api/auth/me":
            return self._json({"user": {"uid": self.user["pk"], "userId": self.user["userId"], "name": self.user["name"]}}) if self.user else self._error(401, "not signed in")
        if p == "/api/config":
            return self._json(config_payload())
        if p == "/api/bootstrap":
            return self._json(bootstrap_payload())
        if p == "/api/extras":
            return self._json(extras_payload())
        if p == "/api/sentiment":
            boot = store.disk_get("bootstrap") or {}
            return self._json(news.sentiment_status([s["sym"] for s in boot.get("stocks", [])]))
        m = re.match(r"^/api/stock/([^/]+)$", p)
        if m:
            sym = urllib.parse.unquote(m.group(1)).upper()
            if not market.SYMBOL_RE.match(sym):
                return self._error(400, "bad symbol")
            return self._json(stock_payload(sym))
        if p == "/api/search":
            return self._json(market.search(qs.get("q", [""])[0]))
        m = re.match(r"^/api/peers/([^/]+)$", p)
        if m:
            sym = urllib.parse.unquote(m.group(1)).upper()
            if not market.SYMBOL_RE.match(sym):
                return self._error(400, "bad symbol")
            return self._json(market.peers(sym))
        m = re.match(r"^/api/news/(india|global)$", p)
        if m:
            return self._json(news.region_news(m.group(1)))
        m = re.match(r"^/api/news/stock/([^/]+)$", p)
        if m:
            sym = urllib.parse.unquote(m.group(1)).upper()
            if not market.SYMBOL_RE.match(sym):
                return self._error(400, "bad symbol")
            return self._json(news.stock_news(sym))
        if p == "/api/options/meta":
            return self._json({"symbols": optiondb.symbols(), "scheduler": scheduler.status(), "snapshots": optiondb.snapshots(limit=10), "dbPath": optiondb.db_path()})
        if p == "/api/audit":
            return self._json({"entries": optiondb.audit_log(qs.get("limit", ["30"])[0]), "verify": optiondb.verify_audit()})
        if p == "/api/metrics":
            return self._json(metrics_payload())
        if p == "/api/options":
            sym = qs.get("symbol", ["NIFTY"])[0]
            if not market.SYMBOL_RE.match(sym):
                return self._error(400, "bad symbol")
            return self._json(options.option_chain(sym, qs.get("expiry", [""])[0][:32]))
        return self._error(404, "not found")

    def _vitals(self):
        if self.headers.get("X-Requested-With") != "MarketLens":
            return self._error(403, "missing X-Requested-With header")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if not 0 < length <= 2048:
            return self._error(413 if length > 2048 else 400, "vitals payload must be 1 to 2048 bytes")
        raw = self.rfile.read(length)
        self._body_read = True
        try:
            sample = json.loads(raw)
            if not isinstance(sample, dict):
                raise ValueError
        except ValueError:
            return self._error(400, "invalid JSON")
        return self._json({"accepted": metrics.observe_vitals(sample)}, 202)

    def _post(self, u):
        if u.path.startswith("/api/auth/"):
            return self._auth_post(u.path)
        if settings.require_login and not self.user:
            return self._error(401, "authentication required")
        if u.path == "/api/vitals":
            return self._vitals()
        if u.path != "/api/options/import":
            return self._error(404, "not found")
        if self.headers.get("X-Requested-With") != "MarketLens":
            return self._error(403, "missing X-Requested-With header")
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() not in ("text/csv", "text/plain", "application/octet-stream"):
            return self._error(415, "send the CSV as text/csv")
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self._error(400, "empty body")
        if length > MAX_UPLOAD:
            return self._error(413, "file is larger than 2 MB")
        qs = urllib.parse.parse_qs(u.query)
        body = self.rfile.read(length)
        self._body_read = True
        try:
            spot = float(qs["spot"][0]) if qs.get("spot", [""])[0] else None
            res = optiondb.import_csv(body.decode("utf-8-sig", "replace"), (self.user or {}).get("userId", "web"), _clean_filename(qs.get("filename", [""])[0]),
                                      qs.get("symbol", [""])[0] or None, qs.get("expiry", [""])[0] or None, spot)
            return self._json(res)
        except (optiondb.CsvError, ValueError) as e:
            return self._error(400, str(e))


class BoundedServer(ThreadingHTTPServer):
    """Threaded server with a real listen backlog and caps on open connections and in-flight requests."""
    request_queue_size = 128
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler):
        self.slots = threading.BoundedSemaphore(max(1, settings.max_inflight))
        self.conn_slots = threading.BoundedSemaphore(max(1, settings.max_connections))
        super().__init__(addr, handler)

    def process_request(self, request, client_address):
        if not self.conn_slots.acquire(blocking=False):
            metrics.incr("connections_refused")
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.conn_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.conn_slots.release()

    def handle_error(self, request, client_address):  # one JSON line instead of a traceback dump
        sys.stderr.write(json.dumps({"level": "error", "msg": "connection_error", "client": client_address[0], "error": str(sys.exc_info()[1])[:120]}) + "\n")


def make_server():
    global _limiter
    _limiter = ratelimit.TokenBuckets()
    nse.load_breaker()
    httpd = BoundedServer((settings.host, settings.port), Handler)
    optiondb.safe_audit("startup", "server", f"started v{_version()} offline={settings.offline} news={settings.news} "
                        f"option_interval={settings.option_interval} endpoint_configured={bool(settings.fo_url)} rate_limit={settings.rate_limit}", channel="system")
    scheduler.start()  # no-op when option_interval is 0
    return httpd
