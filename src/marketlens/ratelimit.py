"""In-process token-bucket rate limiter.

One bucket per (client, traffic class), bounded in memory (least-recently-used keys are dropped). The key is the
TCP peer address, never X-Forwarded-For (a client can forge that header); behind a reverse proxy, rate-limit at the
proxy. Limits are per process: this app is single-instance by design, so no shared store is needed. If the limiter
itself raises, callers fail open (a limiter bug must not take the app down).
"""
import collections
import threading
import time

# class -> (burst capacity, tokens refilled per second)
DEFAULT_LIMITS = {
    "static": (400, 200.0),     # HTML, JS, CSS
    "read": (300, 100.0),       # cheap API reads served from local snapshots
    "live": (120, 40.0),        # the one-second feed (answered from a one-second cache; upstream calls have their own budget)
    "expensive": (40, 4.0),     # may call NSE, Yahoo or Google (stock detail, search, news, option chain)
    "write": (10, 0.5),         # CSV import, web vitals
    "auth": (8, 0.1),           # sign-up, sign-in, recovery: 8 quickly, then one every 10 s
}


class TokenBuckets:
    def __init__(self, limits=None, max_keys=2048, clock=time.monotonic):
        self.limits = dict(limits or DEFAULT_LIMITS)
        self.max_keys, self.clock = max_keys, clock
        self._b = collections.OrderedDict()
        self._lock = threading.Lock()

    def allow(self, client, cls, cost=1.0):
        """Return (allowed, retry_after_seconds)."""
        cap, rate = self.limits[cls]
        now = self.clock()
        with self._lock:
            key = (client, cls)
            tokens, last = self._b.pop(key, (cap, now))
            tokens = min(cap, tokens + (now - last) * rate)
            ok = tokens >= cost
            if ok:
                tokens -= cost
            self._b[key] = (tokens, now)
            while len(self._b) > self.max_keys:
                self._b.popitem(last=False)
            return ok, (0.0 if ok else (cost - tokens) / rate)

    def size(self):
        with self._lock:
            return len(self._b)
