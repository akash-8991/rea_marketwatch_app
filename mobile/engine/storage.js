/* Key-value storage behind one async interface.
 *  - MemoryStorage: tests and Node.
 *  - IdbStorage: the app (IndexedDB in the Android WebView; survives restarts, no 5 MB localStorage ceiling).
 * Values are JSON. A per-engine mutex (see lock()) serialises read-modify-write sequences such as the audit chain. */

export class MemoryStorage {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? JSON.parse(this.m.get(k)) : null; }
  async set(k, v) { this.m.set(k, JSON.stringify(v)); }
  async del(k) { this.m.delete(k); }
  async keys(prefix = '') { return [...this.m.keys()].filter((k) => k.startsWith(prefix)); }
}

export class IdbStorage {
  constructor(name = 'marketlens') { this.name = name; this.dbp = null; }
  db() {
    if (!this.dbp) {
      this.dbp = new Promise((res, rej) => {
        const r = indexedDB.open(this.name, 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    return this.dbp;
  }
  async tx(mode, fn) {
    const db = await this.db();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode), s = t.objectStore('kv');
      let out;
      Promise.resolve(fn(s)).then((v) => { out = v; }, rej);
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async get(k) { const v = await this.tx('readonly', (s) => this.req(s.get(k))); return v === undefined ? null : v; }
  async set(k, v) { await this.tx('readwrite', (s) => { s.put(v, k); }); }
  async del(k) { await this.tx('readwrite', (s) => { s.delete(k); }); }
  async keys(prefix = '') { const all = await this.tx('readonly', (s) => this.req(s.getAllKeys())); return all.filter((k) => k.startsWith(prefix)); }
}

/** Tiny promise mutex: lock(name, fn) runs fn after every earlier call with the same name has finished. */
const tails = new Map();
export function lock(name, fn) {
  const prev = tails.get(name) || Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(name, run.catch(() => {}));
  return run;
}

/** In-memory TTL cache with stale-on-error, the JS counterpart of store.cached(). */
export class Cache {
  constructor(now = () => Date.now()) { this.m = new Map(); this.inflight = new Map(); this.now = now; }
  async cached(key, ttlSeconds, fn) {
    const hit = this.m.get(key);
    if (hit && hit.until > this.now()) return hit.val;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const val = await fn();
        this.m.set(key, { until: this.now() + ttlSeconds * 1000, val });
        return val;
      } catch (e) {
        if (hit) return hit.val;
        throw e;
      } finally { this.inflight.delete(key); }
    })();
    this.inflight.set(key, p);
    return p;
  }
  clear() { this.m.clear(); }
}

/** Snapshot-on-disk helpers (the JS counterpart of store.disk_put/get/age/keys). */
export class Snapshots {
  constructor(storage, now = () => Date.now()) { this.s = storage; this.now = now; }
  async put(key, val) { await this.s.set('snap:' + key, { at: this.now(), val }); }
  async get(key) { const r = await this.s.get('snap:' + key); return r ? r.val : null; }
  async age(key) { const r = await this.s.get('snap:' + key); return r ? (this.now() - r.at) / 1000 : null; }
  async keys(prefix) { return (await this.s.keys('snap:' + prefix)).map((k) => k.slice(5)); }
}
