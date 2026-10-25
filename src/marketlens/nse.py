"""Minimal MCP streamable-http client for NSE's MCP servers, with polite rate limiting.

The NSE endpoints sit behind a load balancer that only recognises a session on the backend that
created it (about half of the attempts get a 404), so each attempt starts a fresh session and we retry.
A 401/403/429 means the edge is refusing us: a circuit breaker then stops all traffic for
BREAKER_SECONDS (persisted on disk so a restart does not probe a blocked endpoint again).
"""
import gzip
import http.client
import json
import os
import threading
import time
import urllib.error
import urllib.parse

from .config import settings

HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
BREAKER_SECONDS = 15 * 60
MAX_WORKERS = 2
_local = threading.local()
_net = threading.Semaphore(MAX_WORKERS)  # global cap on simultaneous upstream requests
_breaker = {"until": 0.0, "reason": ""}


class UpstreamBlocked(RuntimeError):
    """NSE is unreachable on purpose (offline mode, or the circuit breaker is open)."""


def _breaker_file():
    return os.path.join(str(settings.data_dir), "breaker.json")


def load_breaker():
    try:
        with open(_breaker_file()) as f:
            b = json.load(f)
        if b.get("until", 0) > time.time():
            _breaker.update(until=b["until"], reason=b.get("reason", "paused"))
    except (OSError, ValueError):
        pass


def _open_breaker(code):
    _breaker.update(until=time.time() + BREAKER_SECONDS, reason=f"NSE MCP returned HTTP {code}; paused until retry window")
    try:
        from . import optiondb
        optiondb.safe_audit("upstream_blocked", "nse", f"NSE MCP returned HTTP {code}; all NSE traffic paused for {BREAKER_SECONDS // 60} min", outcome="error", channel="system")
    except Exception:
        pass
    try:
        os.makedirs(str(settings.data_dir), exist_ok=True)
        with open(_breaker_file(), "w") as f:
            json.dump(_breaker, f)
    except OSError:
        pass


def retry_in_seconds():
    return max(0, int(_breaker["until"] - time.time()))


def available():
    """True when a live NSE call may be attempted right now."""
    return not settings.offline and time.time() >= _breaker["until"]


def _conn(url, fresh=False):
    conns = getattr(_local, "conns", None)
    if conns is None:
        conns = _local.conns = {}
    u = urllib.parse.urlparse(url)
    if fresh or u.netloc not in conns:
        old = conns.pop(u.netloc, None)
        if old:
            old.close()
        cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
        conns[u.netloc] = cls(u.netloc, timeout=40)
    return conns[u.netloc], (u.path or "/")


def _post(url, body, sid=None, fresh_conn=False):
    h = dict(HDR)
    if sid:
        h["Mcp-Session-Id"] = sid
    conn, path = _conn(url, fresh_conn)
    try:
        conn.request("POST", path, body=json.dumps(body).encode(), headers=h)
        r = conn.getresponse()
        raw = r.read()
    except (http.client.HTTPException, OSError):
        conn.close()
        _local.conns.pop(urllib.parse.urlparse(url).netloc, None)
        raise urllib.error.URLError("connection error")
    if r.status >= 400:
        if not (r.status == 404 and body.get("method") == "notifications/initialized"):
            _local.conns.pop(urllib.parse.urlparse(url).netloc, None)
        raise urllib.error.HTTPError(url, r.status, r.reason, r.headers, None)
    if r.headers.get("Content-Encoding") == "gzip":
        raw = gzip.decompress(raw)
    return r.headers.get("Mcp-Session-Id"), raw.decode("utf-8", "replace")


def _parse(raw):
    raw = raw.strip()
    if raw.startswith("event:") or raw.startswith("data:"):
        for line in raw.splitlines():
            if line.startswith("data:"):
                raw = line[5:].strip()
                break
    return json.loads(raw) if raw else {}


def _session(url, fresh=False):
    sessions = getattr(_local, "sessions", None)
    if sessions is None:
        sessions = _local.sessions = {}
    if fresh or url not in sessions:
        sid, _ = _post(url, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "marketlens", "version": "1"}}}, fresh_conn=fresh)
        try:
            _post(url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
        except Exception:
            pass  # the NSE server answers 404 here yet still accepts the session
        sessions[url] = sid
    return sessions[url]


def rpc(url, method, params=None, attempts=8):
    """One JSON-RPC request on a fresh MCP session. Returns the `result` object."""
    last = None
    for _ in range(attempts):
        if settings.offline:
            raise UpstreamBlocked("offline mode (no NSE requests are made)")
        if time.time() < _breaker["until"]:
            raise UpstreamBlocked(_breaker["reason"])
        try:
            with _net:
                sid = _session(url, fresh=True)
                _, raw = _post(url, {"jsonrpc": "2.0", "id": 2, "method": method, "params": params or {}}, sid)
                time.sleep(0.15)
            msg = _parse(raw)
            if "error" in msg:
                raise RuntimeError(f"{method}: {str(msg['error'])[:160]}")
            return msg.get("result", {})
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 403, 429):
                _open_breaker(e.code)
                raise UpstreamBlocked(_breaker["reason"])
            time.sleep(0.1)
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last = e
            time.sleep(0.1)
    raise RuntimeError(f"{method} failed: {last}")


def mcp(url, tool, args=None, attempts=8):
    """Call one MCP tool and return its JSON payload (or {"_text": ...} when it is not JSON)."""
    res = rpc(url, "tools/call", {"name": tool, "arguments": args or {}}, attempts)
    text = "".join(c.get("text", "") for c in res.get("content", []))
    if res.get("isError"):
        raise RuntimeError(f"{tool}: {text[:160]}")
    try:
        return json.loads(text)
    except ValueError:
        return {"_text": text}


def cm(tool, args=None):
    return mcp(settings.cm_url, tool, args)


def bh(tool, args=None):
    return mcp(settings.bhavcopy_url, tool, args)
