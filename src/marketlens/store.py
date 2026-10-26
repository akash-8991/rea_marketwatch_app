"""Small TTL cache (in memory, per-key locks) plus JSON snapshots on disk."""
import json
import os
import threading
import time

from .config import settings

_cache, _locks, _glock = {}, {}, threading.Lock()


def cached(key, ttl, fn):
    """Return fn() cached for `ttl` seconds; serve the stale value if a refresh fails."""
    with _glock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        lock = _locks.setdefault(key, threading.Lock())
    with lock:
        hit = _cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
        try:
            val = fn()
        except Exception:
            if hit:
                return hit[1]
            raise
        _cache[key] = (time.time() + ttl, val)
        return val


def peek(key):
    """The cached value if it is still fresh, else None. Never calls the loader."""
    with _glock:
        hit = _cache.get(key)
        return hit[1] if hit and hit[0] > time.time() else None


def forget(key):
    """Drop one cached value (used by 'refresh now', which still goes through the single-flight lock)."""
    with _glock:
        _cache.pop(key, None)


def clear_memory():
    with _glock:
        _cache.clear()


def _path(key):
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)
    return os.path.join(str(settings.data_dir), safe + ".json")


def disk_put(key, val):
    os.makedirs(str(settings.data_dir), exist_ok=True)
    tmp = _path(key) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(val, f)
    os.replace(tmp, _path(key))


def disk_get(key):
    try:
        with open(_path(key)) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def disk_age(key):
    try:
        return time.time() - os.path.getmtime(_path(key))
    except OSError:
        return None


def disk_keys(prefix):
    try:
        return [f[:-5] for f in os.listdir(str(settings.data_dir)) if f.startswith(prefix) and f.endswith(".json")]
    except OSError:
        return []
