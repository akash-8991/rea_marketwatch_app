"""Minimal MCP streamable-http client for NSE's MCP servers, with polite rate limiting.

The NSE endpoints sit behind a load balancer that only recognises a session on the backend that created it, so about 60% of requests
(measured) get a 404. Each of the two lanes therefore keeps one warm session per endpoint and simply retries on that same session: a retry
costs one request, where starting a fresh session costs three. After MISS_LIMIT misses in a row the session is dropped and re-created.
A 401/403/429 means the edge is refusing us: a circuit breaker then stops all traffic for BREAKER_SECONDS (persisted on disk so a restart
does not probe a blocked endpoint again). Politeness pacing (one request per lane per PACE seconds) holds the lane, not the caller's reply.
"""
import gzip
import http.client
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.parse

from .config import settings

HDR = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18"}
BREAKER_SECONDS = 15 * 60
MAX_WORKERS = 2
MISS_LIMIT = 6
PACE = 0.15
_breaker = {"until": 0.0, "reason": ""}
stats = {"requests": 0, "sessions": 0, "misses": 0}


class _Lane:
    """One of at most MAX_WORKERS simultaneous upstream channels: its own connections and sessions, used by one caller at a time."""
    def __init__(self):
        self.conns, self.sessions, self.misses = {}, {}, {}

    def conn(self, url, fresh=False):
        u = urllib.parse.urlparse(url)
        if fresh or u.netloc not in self.conns:
            old = self.conns.pop(u.netloc, None)
            if old:
                old.close()
            cls = http.client.HTTPSConnection if u.scheme == "https" else http.client.HTTPConnection
            self.conns[u.netloc] = cls(u.netloc, timeout=20)
        return self.conns[u.netloc], (u.path or "/")

    def post(self, url, body, sid=None):
        stats["requests"] += 1
        h = dict(HDR)
        if sid:
            h["Mcp-Session-Id"] = sid
        conn, path = self.conn(url)
        try:
            conn.request("POST", path, body=json.dumps(body).encode(), headers=h)
            r = conn.getresponse()
            raw = r.read()
        except (http.client.HTTPException, OSError):
            conn.close()
            self.conns.pop(urllib.parse.urlparse(url).netloc, None)
            raise urllib.error.URLError("connection error")
        if r.status >= 400:
            if r.status != 404:
                self.conns.pop(urllib.parse.urlparse(url).netloc, None)
            if not (r.status == 404 and body.get("method") == "notifications/initialized"):
                raise urllib.error.HTTPError(url, r.status, r.reason, r.headers, None)
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return r.headers.get("Mcp-Session-Id"), raw.decode("utf-8", "replace")

    def session(self, url):
        sid = self.sessions.get(url)
        if sid:
            return sid
        stats["sessions"] += 1
        sid, _ = self.post(url, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "marketlens", "version": "1"}}})
        try:
            self.post(url, {"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
        except Exception:
            pass  # the NSE server answers 404 here yet still accepts the session
        self.sessions[url] = sid
        return sid

    def drop(self, url):
        self.sessions.pop(url, None)
        self.misses[url] = 0


_lanes = queue.Queue()
for _i in range(MAX_WORKERS):
    _lanes.put(_Lane())


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


def _parse(raw):
    raw = raw.strip()
    if raw.startswith("event:") or raw.startswith("data:"):
        for line in raw.splitlines():
            if line.startswith("data:"):
                raw = line[5:].strip()
                break
    return json.loads(raw) if raw else {}


def rpc(url, method, params=None, attempts=14):
    """One JSON-RPC request. Returns the `result` object."""
    last, net_fails, hard_fails, backoff = None, 0, 0, 0.0
    for _ in range(attempts):
        if backoff:
            time.sleep(backoff)
            backoff = 0.0
        if settings.offline:
            raise UpstreamBlocked("offline mode (no NSE requests are made)")
        if time.time() < _breaker["until"]:
            raise UpstreamBlocked(_breaker["reason"])
        lane = _lanes.get()
        paced = False
        try:
            sid = lane.session(url)
            _, raw = lane.post(url, {"jsonrpc": "2.0", "id": 2, "method": method, "params": params or {}}, sid)
            lane.misses[url] = 0
            paced = True
            msg = _parse(raw)
            if "error" in msg:
                raise RuntimeError(f"{method}: {str(msg['error'])[:160]}")
            return msg.get("result", {})
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (401, 403, 429):
                _open_breaker(e.code)
                raise UpstreamBlocked(_breaker["reason"])
            if e.code == 404:
                stats["misses"] += 1
                lane.misses[url] = lane.misses.get(url, 0) + 1
                if lane.misses[url] >= MISS_LIMIT or url not in lane.sessions:
                    lane.drop(url)
            else:
                lane.drop(url)
                if hard_fails >= 5:
                    raise RuntimeError(f"{method} failed after {hard_fails + 1} errors: {last}")   # NSE is really failing: report it instead of hammering it
                backoff = min(0.06 * 2 ** hard_fails, 1.0)   # a real error, not a routine misroute: wait longer each time before trying again
                hard_fails += 1
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            last = e
            lane.drop(url)
            backoff = min(0.06 * 2 ** hard_fails, 1.0)
            hard_fails += 1
            if isinstance(e, urllib.error.URLError):
                net_fails += 1
                if net_fails >= 3:
                    raise RuntimeError(f"{method} failed: no answer from NSE (3 tries)")
        finally:
            if paced:   # the politeness gap holds the lane, not the caller's reply
                t = threading.Timer(PACE, _lanes.put, [lane]); t.daemon = True; t.start()
            else:
                _lanes.put(lane)
    raise RuntimeError(f"{method} failed: {last}")


def mcp(url, tool, args=None, attempts=14):
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
