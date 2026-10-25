#!/usr/bin/env python3
"""Small load tester for a running MarketLens server (standard library only).

  python tools/loadtest.py --url http://127.0.0.1:8080 --concurrency 16 --seconds 8 [--soak]

Reports per-endpoint latency percentiles (client-side, monotonic clock), throughput and error rate.
It measures a local server over loopback with whatever data the server holds; it says nothing about NSE,
the internet, or other machines. Point it only at a server you run yourself.
"""
import argparse
import http.client
import json
import statistics
import subprocess
import sys
import threading
import time
import urllib.parse

ENDPOINTS = ["/", "/js/app.js", "/api/config", "/api/bootstrap", "/api/extras", "/api/options?symbol=NIFTY", "/api/search?q=REL", "/api/stock/RELIANCE"]


def pct(sorted_ms, q):
    if not sorted_ms:
        return None
    return sorted_ms[min(len(sorted_ms) - 1, int(round(q * (len(sorted_ms) - 1))))]


def worker(host, port, paths, stop, results, lock, cookie=None):
    conn = http.client.HTTPConnection(host, port, timeout=15)
    i = 0
    while not stop.is_set():
        path = paths[i % len(paths)]
        i += 1
        t0 = time.perf_counter()
        status, size = 0, 0
        try:
            conn.request("GET", path, headers={"Accept-Encoding": "gzip", **({"Cookie": cookie} if cookie else {})})
            r = conn.getresponse()
            size = len(r.read())
            status = r.status
        except Exception:
            status = -1
            conn.close()
            conn = http.client.HTTPConnection(host, port, timeout=15)
        ms = (time.perf_counter() - t0) * 1000
        with lock:
            results.setdefault(path, []).append((ms, status, size))


def rss_kb(pid):
    try:
        return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(pid)]).strip())
    except Exception:
        return None


def run(url, concurrency, seconds, paths, pid=None, cookie=None):
    u = urllib.parse.urlparse(url)
    results, lock, stop = {}, threading.Lock(), threading.Event()
    threads = [threading.Thread(target=worker, args=(u.hostname, u.port, paths, stop, results, lock, cookie), daemon=True) for _ in range(concurrency)]
    rss0 = rss_kb(pid) if pid else None
    t0 = time.perf_counter()
    [t.start() for t in threads]
    time.sleep(seconds)
    stop.set()
    [t.join(timeout=20) for t in threads]
    elapsed = time.perf_counter() - t0
    report = {"concurrency": concurrency, "seconds": round(elapsed, 1), "endpoints": {}}
    total = errors = 0
    for path, rows in sorted(results.items()):
        ms = sorted(r[0] for r in rows)
        bad = sum(1 for r in rows if r[1] != 200)
        total, errors = total + len(rows), errors + bad
        report["endpoints"][path] = {"n": len(rows), "p50_ms": round(pct(ms, .50), 2), "p95_ms": round(pct(ms, .95), 2), "p99_ms": round(pct(ms, .99), 2),
                                     "max_ms": round(ms[-1], 2), "non200": bad, "bytes": rows[0][2]}
    report["total_requests"], report["rps"], report["error_rate"] = total, round(total / elapsed, 1), round(errors / max(total, 1), 4)
    statuses = {}
    for rows in results.values():
        for _, s, _ in rows:
            statuses[s] = statuses.get(s, 0) + 1
    report["status_counts"] = statuses
    if pid:
        report["rss_kb_before"], report["rss_kb_after"] = rss0, rss_kb(pid)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--concurrency", type=int, nargs="+", default=[1, 16])
    ap.add_argument("--seconds", type=float, default=8)
    ap.add_argument("--paths", nargs="*", default=ENDPOINTS)
    ap.add_argument("--pid", type=int, default=None, help="server pid, to report memory before/after")
    ap.add_argument("--out", default=None, help="write the JSON report here")
    ap.add_argument("--cookie", default=None, help="session cookie, e.g. ml_session=...; needed unless the server runs with --no-login")
    a = ap.parse_args()
    out = [run(a.url, c, a.seconds, a.paths, a.pid, a.cookie) for c in a.concurrency]
    text = json.dumps(out, indent=1)
    print(text)
    if a.out:
        open(a.out, "w").write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
