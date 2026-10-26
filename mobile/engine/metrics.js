/* Per-route latency percentiles and error counts for the on-device API (the desktop server has the equivalent in src/marketlens/metrics.py).
 * Labels are route templates, never raw paths, so symbols never become metric names. Ring buffers keep memory bounded. */
const KEEP = 500;
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
const round = (x) => (x == null ? null : Math.round(x * 100) / 100);

export const routeLabel = (path) => path.replace(/^\/api\/(stock|quote|history|peers)\/[^/?]+/, '/api/$1/:sym').replace(/^\/api\/news\/stock\/[^/?]+/, '/api/news/stock/:sym').replace(/\?.*$/, '');

export class Metrics {
  constructor(now = () => (globalThis.performance ? performance.now() : Date.now())) { this.now = now; this.routes = new Map(); this.started = Date.now(); }
  start() { return this.now(); }
  observe(route, status, t0) {
    const ms = this.now() - t0;
    const r = this.routes.get(route) || { n: 0, errors: 0, ring: [] };
    r.n++; if (status >= 500) r.errors++;
    r.ring.push(ms); if (r.ring.length > KEEP) r.ring.shift();
    this.routes.set(route, r);
  }
  snapshot() {
    const routes = {};
    for (const [label, r] of this.routes) {
      const s = [...r.ring].sort((a, b) => a - b);
      routes[label] = { n: r.n, errors: r.errors, p50_ms: round(pct(s, 0.5)), p95_ms: round(pct(s, 0.95)), p99_ms: round(pct(s, 0.99)), max_ms: round(s[s.length - 1]) };
    }
    return { uptimeSeconds: Math.round((Date.now() - this.started) / 1000), routes };
  }
}
