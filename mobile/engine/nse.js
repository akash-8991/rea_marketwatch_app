/* NSE MCP client (streamable-http), port of nse.py: a fresh MCP session per attempt (the load balancer only knows a session
 * on the backend that made it, so ~half of attempts get a 404 and are retried), at most 2 requests in flight, and a persisted
 * 15-minute circuit breaker when the edge answers 401/403/429. Uses the global fetch: in the Android app Capacitor's native
 * HTTP layer replaces it, which is why no CORS rule applies there. */

export const BREAKER_SECONDS = 15 * 60;
export const MAX_WORKERS = 2;
const MISS_LIMIT = 6;
const HDR = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };

export class UpstreamBlocked extends Error {}
export class HttpError extends Error { constructor(status) { super(`HTTP ${status}`); this.status = status; } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Reject after ms even if the transport ignores AbortController (Capacitor's native HTTP may). */
export const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

/** Fixed set of "lanes" (max two NSE requests in flight, as before). Each lane keeps its own warm MCP session per endpoint. */
class LanePool {
  constructor(n) { this.free = Array.from({ length: n }, (_, i) => ({ id: i, sessions: {}, misses: {} })); this.q = []; }
  acquire() { return this.free.length ? Promise.resolve(this.free.pop()) : new Promise((r) => this.q.push(r)); }
  release(lane) { const next = this.q.shift(); if (next) next(lane); else this.free.push(lane); }
}

export function parseBody(raw) {
  raw = raw.trim();
  if (raw.startsWith('event:') || raw.startsWith('data:')) {
    for (const line of raw.split(/\r?\n/)) if (line.startsWith('data:')) { raw = line.slice(5).trim(); break; }
  }
  return raw ? JSON.parse(raw) : {};
}

export class NseClient {
  constructor({ storage, cmUrl, bhavcopyUrl, offline = false, fetchFn = (...a) => fetch(...a), now = () => Date.now() / 1000, delayMs = 150, timeoutMs = 20000, onBlocked = null }) {
    Object.assign(this, { s: storage, cmUrl, bhavcopyUrl, offline, fetchFn, now, delayMs, timeoutMs, onBlocked });
    this.pool = new LanePool(MAX_WORKERS);
    this.stats = { requests: 0, sessions: 0, misses: 0 };
    this.breaker = { until: 0, reason: '' };
  }

  async loadBreaker() {
    const b = await this.s.get('breaker');
    if (b && b.until > this.now()) this.breaker = { until: b.until, reason: b.reason || 'paused' };
  }
  retryInSeconds() { return Math.max(0, Math.floor(this.breaker.until - this.now())); }
  available() { return !this.offline && this.now() >= this.breaker.until; }

  async openBreaker(code) {
    this.breaker = { until: this.now() + BREAKER_SECONDS, reason: `NSE MCP returned HTTP ${code}; paused until retry window` };
    try { await this.s.set('breaker', this.breaker); } catch (e) { /* storage unavailable */ }
    if (this.onBlocked) { try { await this.onBlocked(code); } catch (e) { /* audit is best effort here */ } }
  }

  async post(url, body, sid = null) {
    this.stats.requests++;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const headers = { ...HDR, ...(sid ? { 'Mcp-Session-Id': sid } : {}) };
      const r = await withTimeout(this.fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal }), this.timeoutMs);
      if (r.status >= 400 && !(r.status === 404 && body.method === 'notifications/initialized')) throw new HttpError(r.status);
      return [r.headers.get('Mcp-Session-Id'), await withTimeout(r.text(), this.timeoutMs)];
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new Error('connection error');
    } finally { clearTimeout(timer); }
  }

  async initSession(url) {
    this.stats.sessions++;
    const [sid] = await this.post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'marketlens-mobile', version: '1' } } });
    try { await this.post(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid); } catch (e) { /* NSE answers 404 here yet still accepts the session */ }
    return sid;
  }

  /** One JSON-RPC call. A lane keeps its session between calls: NSE's load balancer answers 404 whenever a request lands on a
   * backend that does not know the session (measured: about 60% of calls), and a retry on the SAME session usually lands on the
   * right one, which costs 1 request instead of the 3 a fresh session costs. After MISS_LIMIT 404s in a row the session is dropped. */
  async rpc(url, method, params = {}, attempts = 14) {
    let last = null, netFails = 0, hardFails = 0, backoff = 0;
    for (let i = 0; i < attempts; i++) {
      if (this.offline) throw new UpstreamBlocked('offline mode (no NSE requests are made)');
      if (this.now() < this.breaker.until) throw new UpstreamBlocked(this.breaker.reason);
      if (backoff) { await sleep(backoff); backoff = 0; }
      const lane = await this.pool.acquire();
      let paced = false;
      try {
        const sid = lane.sessions[url] || (lane.sessions[url] = await this.initSession(url));
        const [, raw] = await this.post(url, { jsonrpc: '2.0', id: 2, method, params }, sid);
        lane.misses[url] = 0;
        paced = true;   // the politeness gap is applied when the lane is released, not before the caller gets its answer
        const msg = parseBody(raw);
        if (msg.error) throw new Error(`${method}: ${String(JSON.stringify(msg.error)).slice(0, 160)}`);
        return msg.result || {};
      } catch (e) {
        last = e;
        if (e instanceof HttpError && [401, 403, 429].includes(e.status)) { await this.openBreaker(e.status); throw new UpstreamBlocked(this.breaker.reason); }
        if (e instanceof HttpError && e.status === 404) {
          this.stats.misses++;
          lane.misses[url] = (lane.misses[url] || 0) + 1;
          if (lane.misses[url] >= MISS_LIMIT || !lane.sessions[url]) { delete lane.sessions[url]; lane.misses[url] = 0; }
        } else if (e instanceof HttpError || e.message === 'connection error' || e instanceof SyntaxError) {
          delete lane.sessions[url];   // unknown state: start clean next time
          if (hardFails >= 5) throw new Error(`${method} failed after ${hardFails + 1} errors: ${last && last.message}`);   // NSE is really failing: report it instead of hammering it
          backoff = Math.min(60 * 2 ** hardFails++, 1000);   // a real error (not a routine misroute): wait longer each time before trying again
          if (e.message === 'connection error' && ++netFails >= 3) throw new Error(`${method} failed: no answer from NSE (${this.timeoutMs / 1000} s timeout, 3 tries)`);
        } else throw e;
      } finally {
        // Pacing (at most one request per lane per delayMs) keeps NSE's edge happy but must not add to latency: hold the lane, not the reply.
        if (paced && this.delayMs) setTimeout(() => this.pool.release(lane), this.delayMs); else this.pool.release(lane);
      }
    }
    throw new Error(`${method} failed: ${last}`);
  }

  async mcp(url, tool, args = {}, attempts = 14) {
    const res = await this.rpc(url, 'tools/call', { name: tool, arguments: args }, attempts);
    const text = (res.content || []).map((c) => c.text || '').join('');
    if (res.isError) throw new Error(`${tool}: ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch (e) { return { _text: text }; }
  }

  cm(tool, args) { return this.mcp(this.cmUrl, tool, args); }
  bh(tool, args) { return this.mcp(this.bhavcopyUrl, tool, args); }
}
