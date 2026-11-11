"""In-process server-side latency: a fully cached live feed (12 and 1 symbols) and tick recording, against the 1 ms budget. NSE is faked, the clock is fixed."""
import sys, time, statistics, tempfile, datetime
import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src'))   # run from a checkout: python3 tools/bench-latency.py
from pathlib import Path
from unittest import mock
from marketlens import config, market, nse, ticks, store, optiondb
tmp=tempfile.mkdtemp(); config.settings.data_dir=Path(tmp); store.clear_memory()
IST=datetime.timezone(datetime.timedelta(hours=5,minutes=30)); now=datetime.datetime(2026,11,9,10,30,tzinfo=IST).timestamp()
def cm(tool,args=None):
    if tool=="cm_get_live_indices": return {"indices":{"derivatives":[{"indexName":"NIFTY 50","last":22500,"previousClose":22400,"percChange":.4}]}}
    return {"stock":{"lastTradedPrice":105,"preClosePrice":100,"openPrice":101,"highPrice":106,"lowPrice":99,"volume":1000,"latestTimestamp":"2026-11-09 10:29:55"}}
nse.cm=cm
with mock.patch("time.time", lambda: now):
    syms=[f"S{i}" for i in range(12)]
    market.live_feed(syms)  # warm
    def t(fn,n=2000):
        a=[]
        for _ in range(n):
            t0=time.perf_counter(); fn(); a.append((time.perf_counter()-t0)*1000)
        a.sort(); return a[len(a)//2], a[int(len(a)*.95)], a[int(len(a)*.99)], a[-1]
    print("live_feed cached, 12 symbols  p50/p95/p99/max ms:", ["%.3f"%x for x in t(lambda: market.live_feed(syms))])
    print("live_feed cached, 1 symbol    p50/p95/p99/max ms:", ["%.3f"%x for x in t(lambda: market.live_feed(['S0']))])
    k=[0]
    def rec():
        k[0]+=1; ticks.record("ZZ", 100+(k[0]%7), 1000+k[0], f"2026-11-09 10:{(k[0]//60)%60:02d}:{k[0]%60:02d}", now=now)
    print("ticks.record                  p50/p95/p99/max ms:", ["%.4f"%x for x in t(rec,5000)])
