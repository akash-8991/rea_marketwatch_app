"""Bounded-cardinality request metrics: route templates (never raw paths or user ids), status classes, latency percentiles."""
import collections
import threading
import time

LATENCY_SAMPLES = 2000  # per route, newest kept


def percentile(sorted_vals, q):
    if not sorted_vals:
        return None
    return sorted_vals[min(len(sorted_vals) - 1, int(round(q * (len(sorted_vals) - 1))))]


class Metrics:
    def __init__(self):
        self.started = time.time()
        self._lock = threading.Lock()
        self._lat = collections.defaultdict(lambda: collections.deque(maxlen=LATENCY_SAMPLES))
        self._count = collections.Counter()
        self.counters = collections.Counter()  # rate_limited, load_shed, upstream_blocked, internal_errors ...
        self.inflight = 0
        self._vitals = collections.defaultdict(lambda: collections.deque(maxlen=500))   # metric -> newest samples

    def observe(self, route, status, ms):
        with self._lock:
            self._lat[route].append(ms)
            self._count[(route, f"{status // 100}xx")] += 1

    def incr(self, name, by=1):
        with self._lock:
            self.counters[name] += by

    def gauge_inflight(self, delta):
        with self._lock:
            self.inflight += delta

    VITALS = {"ttfb": 60000, "fcp": 60000, "lcp": 120000, "cls": 50, "inp": 60000}   # accepted metrics and their sane upper bounds

    def observe_vitals(self, sample):
        """Store browser-reported vitals. Unknown keys, non-numbers and out-of-range values are ignored (bounded, no free text)."""
        kept = 0
        with self._lock:
            for k, limit in self.VITALS.items():
                v = sample.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= limit and v == v:
                    self._vitals[k].append(float(v)); kept += 1
        return kept

    def snapshot(self):
        with self._lock:
            routes = {}
            for route, dq in self._lat.items():
                vals = sorted(dq)
                routes[route] = {"samples": len(vals), "p50_ms": round(percentile(vals, .5), 2), "p95_ms": round(percentile(vals, .95), 2),
                                 "p99_ms": round(percentile(vals, .99), 2), "max_ms": round(vals[-1], 2)}
            by_route = collections.defaultdict(dict)
            for (route, cls), n in self._count.items():
                by_route[route][cls] = n
            vitals = {k: {"samples": len(dq), "p50": round(percentile(sorted(dq), .5), 3), "p75": round(percentile(sorted(dq), .75), 3), "p95": round(percentile(sorted(dq), .95), 3)}
                      for k, dq in self._vitals.items() if dq}
            return {"uptimeSeconds": round(time.time() - self.started, 1), "inflight": self.inflight, "counters": dict(self.counters), "webVitals": vitals,
                    "routes": {r: dict(routes.get(r, {}), statuses=by_route.get(r, {})) for r in sorted(set(routes) | set(by_route))}}


metrics = Metrics()
