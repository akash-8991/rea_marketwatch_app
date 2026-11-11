/* Latency monitor: how long each stage of the data and trading path takes, as percentiles, against a budget.
 * The budget of 1 ms applies to what this app itself computes in-process (applying a feed answer, fusing signals, building an intent, the risk engine, executing on the paper or shadow
 * broker, queueing an audit entry). It cannot apply to the network: NSE's servers, Yahoo and Zerodha are hundreds of milliseconds away, and even the local server round trip is a few
 * milliseconds. Those stages are measured and shown, without a 1 ms budget, so nobody mistakes one for the other. */
const CAP = 2000;
export const BUDGET_MS = 1;

export class Latency {
  constructor(clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())) { this.clock = clock; this.s = new Map(); }
  record(stage, ms, budget = null) {
    let x = this.s.get(stage); if (!x) { x = { buf: new Float64Array(CAP), n: 0, total: 0, max: 0, over: 0, budget }; this.s.set(stage, x); }
    x.buf[x.n % CAP] = ms; x.n++; x.total += ms; if (ms > x.max) x.max = ms; if (x.budget != null && ms > x.budget) x.over++;
  }
  /** Time a synchronous function. */
  time(stage, fn, budget = BUDGET_MS) { const t = this.clock(); try { return fn(); } finally { this.record(stage, this.clock() - t, budget); } }
  /** Time an async function (includes anything it awaits). */
  async timeAsync(stage, fn, budget = null) { const t = this.clock(); try { return await fn(); } finally { this.record(stage, this.clock() - t, budget); } }
  stats(stage) {
    const x = this.s.get(stage); if (!x || !x.n) return null;
    const k = Math.min(x.n, CAP), a = Array.from(x.buf.subarray(0, k)).sort((p, q) => p - q), at = (f) => a[Math.min(k - 1, Math.floor(f * k))];
    return { stage, n: x.n, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: x.max, mean: x.total / x.n, budget: x.budget, over: x.over, within: x.budget == null ? null : at(0.99) <= x.budget };
  }
  all() { return [...this.s.keys()].map((k) => this.stats(k)).filter(Boolean); }
  reset() { this.s.clear(); }
}

export const lat = new Latency();
if (typeof window !== 'undefined') window.MLLatency = lat;
