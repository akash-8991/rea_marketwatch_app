/* The on-device "server": routes the same /api/* requests the web UI already makes, with the same JSON shapes as server.py,
 * but answers them in-process. No sockets, no listening port. handle() returns {status, body, setToken?}. */
import * as analysis from './analysis.js';
import { Accounts, AuthError } from './accounts.js';
import { Cache, Snapshots, MemoryStorage } from './storage.js';
import { CsvError, OptionStore, SYMBOL_RE as OPT_SYMBOL } from './options.js';
import { Market, SYMBOL_RE } from './market.js';
import { News } from './news.js';
import { NseClient, UpstreamBlocked } from './nse.js';

export const VERSION = '0.3.0-mobile';
const MAX_UPLOAD = 2_000_000;

export const DEFAULTS = {
  cmUrl: 'https://mcp.nseindia.in/cmmkt/mcp', bhavcopyUrl: 'https://mcp.nseindia.in/bhavcopy/cm/mcp',
  offline: false, news: true, requireLogin: true, universeSize: 60, pbkdf2Iterations: 600000,
};

export function createEngine({ storage = new MemoryStorage(), fetchFn, settings = {}, now = () => Date.now() } = {}) {
  const cfg = { ...DEFAULTS, ...settings };
  const cache = new Cache(now), snaps = new Snapshots(storage, now);
  const opts = new OptionStore(storage);
  const accounts = new Accounts(storage, opts, { iterations: cfg.pbkdf2Iterations, now: () => now() / 1000 });
  const nse = new NseClient({ storage, cmUrl: cfg.cmUrl, bhavcopyUrl: cfg.bhavcopyUrl, offline: cfg.offline, fetchFn, now: () => now() / 1000, delayMs: cfg.nseDelayMs ?? 150,
    onBlocked: (code) => opts.safeAudit('upstream_blocked', 'nse', `NSE MCP returned HTTP ${code}; all NSE traffic paused for 15 min`, { outcome: 'error', channel: 'system' }) });
  const market = new Market({ nse, snaps, cache, settings: cfg, now: () => new Date(now()) });
  const news = new News({ cache, snaps, fetchFn, enabled: cfg.news, delayMs: cfg.feedDelayMs ?? 200, now: () => new Date(now()) });
  const started = now();

  const json = (body, status = 200, extra = {}) => ({ status, body, ...extra });
  const err = (status, message, more = {}) => json({ error: message, ...more }, status);

  async function bootstrapPayload() {
    let boot;
    try { boot = { ...(await cache.cached('bootstrap', 60, () => market.buildBootstrap())), stale: false }; } catch (e) {
      const snap = await snaps.get('bootstrap');
      if (!snap) throw e;
      boot = { ...snap, stale: true, staleReason: String(e.message).slice(0, 200), retryInSeconds: nse.retryInSeconds() };
    }
    boot.offline = cfg.offline;
    boot.stocks = boot.stocks.map((s) => ({ ...s, techSnap: analysis.technicalSnapshot(s) }));
    return boot;
  }

  async function extrasPayload() {
    const boot = (await snaps.get('bootstrap')) || {}, stocks = boot.stocks || [];
    await market.startExtras(stocks.map((s) => s.sym));
    const raw = await snaps.get('extras'), st = market.extrasJob;
    return { ready: raw !== null, refreshing: st.state === 'running', done: st.done, total: st.total, data: raw ? market.deriveExtras(raw, stocks, boot) : {} };
  }

  async function stockPayload(sym) {
    let d;
    try { d = { ...(await cache.cached('stock:' + sym, 300, () => market.stockDetail(sym))), stale: false }; } catch (e) {
      d = await snaps.get('stock-' + sym);
      if (!d) throw e;
      d = { ...d, stale: true, staleReason: String(e.message).slice(0, 200) };
    }
    return { ...d, analysis: await market.analyzeDetail(d) };
  }

  const optionsStatus = () => ({ configured: false, reason: 'On the phone, option-chain data comes from CSV files you download from NSE and import here. No derivatives endpoint is configured.' });

  const configPayload = () => ({ offline: cfg.offline, news: cfg.news, loginRequired: cfg.requireLogin, options: optionsStatus(), version: VERSION, rules: analysis.RULES, rateLimits: null, platform: 'mobile' });

  async function optionChain(symbol, expiry) {
    const snap = await opts.latest((symbol || 'NIFTY').toUpperCase(), expiry);
    if (snap) return { ...snap, available: true, tool: 'saved snapshot', warning: null };
    return { available: false, reason: 'No option-chain data yet. Download the CSV from NSE’s option-chain page in your phone’s browser, then use Import below and pick the file. The NSE servers MarketLens uses by default (cash market and bhavcopy) have no option-chain tool.' };
  }

  async function authPost(path, body, token) {
    const g = (k, n = 200) => (typeof body[k] === 'string' && body[k].length <= n ? body[k] : '');
    try {
      if (path === '/api/auth/signup') {
        const u = await accounts.signup(g('name'), g('email'), g('dob', 20), g('userId', 40), g('password', 128));
        return json({ user: u }, 201, { setToken: await accounts.createSession(u.uid) });
      }
      if (path === '/api/auth/login') {
        const u = await accounts.login(g('userId', 64), g('password', 256));
        return json({ user: u }, 200, { setToken: await accounts.createSession(u.uid) });
      }
      if (path === '/api/auth/logout') { await accounts.endSession(token); return json({ ok: true }, 200, { setToken: '' }); }
      if (path === '/api/auth/forgot-user-id') return json({ userId: await accounts.forgotUserId(g('name'), g('email'), g('dob', 20)) });
      if (path === '/api/auth/update-credentials') {
        const changed = await accounts.updateCredentials(g('name'), g('email'), g('dob', 20), g('newUserId', 40), g('newPassword', 128));
        return json({ changed }, 200, { setToken: '' });
      }
    } catch (e) {
      if (e instanceof AuthError) return err(e.status, e.message, { ...(e.field ? { field: e.field } : {}), ...(e.retryAfter ? { retryAfterSeconds: e.retryAfter } : {}) });
      throw e;
    }
    return err(404, 'not found');
  }

  const PUBLIC = new Set(['/api/auth/status', '/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/auth/forgot-user-id', '/api/auth/update-credentials']);

  /** handle('GET', '/api/stock/TCS', {token, headers, body}) */
  async function handle(method, rawPath, { token = null, headers = {}, body = '' } = {}) {
    const u = new URL(rawPath, 'http://app.local'), p = u.pathname, qs = u.searchParams;
    try {
      const user = cfg.requireLogin ? await accounts.userForToken(token) : { pk: 0, userId: 'local', name: 'You' };
      if (cfg.requireLogin && p.startsWith('/api/') && !PUBLIC.has(p) && !user) return err(401, 'authentication required');
      if (method === 'POST') {
        if (p.startsWith('/api/auth/')) {
          if (headers['x-requested-with'] !== 'MarketLens') return err(403, 'missing X-Requested-With header');
          let parsed; try { parsed = JSON.parse(body); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); } catch (e) { return err(400, 'invalid JSON'); }
          if (String(body).length > 4096) return err(413, 'request body must be 1 to 4096 bytes');
          return authPost(p, parsed, token);
        }
        if (p === '/api/vitals') return json({ ok: true });
        if (p !== '/api/options/import') return err(404, 'not found');
        if (headers['x-requested-with'] !== 'MarketLens') return err(403, 'missing X-Requested-With header');
        if (!body) return err(400, 'empty body');
        if (new TextEncoder().encode(body).length > MAX_UPLOAD) return err(413, 'file is larger than 2 MB');
        const sp = qs.get('spot');
        try {
          return json(await opts.importCsv(body, user ? user.userId : 'app', (qs.get('filename') || '').replace(/[^\w .\-()]/g, '').slice(0, 120), qs.get('symbol') || null, qs.get('expiry') || null, sp ? parseFloat(sp) : null));
        } catch (e) { if (e instanceof CsvError || e instanceof RangeError) return err(400, e.message); throw e; }
      }
      if (method !== 'GET' && method !== 'HEAD') return err(405, 'method not allowed');
      if (p === '/healthz') return json({ status: 'ok', version: VERSION, uptimeSeconds: Math.round((now() - started) / 100) / 10 });
      if (p === '/api/auth/status') return json({ loginRequired: cfg.requireLogin, usersExist: (await accounts.userCount()) > 0, signedIn: !!(user && cfg.requireLogin) });
      if (p === '/api/auth/me') return user ? json({ user: { uid: user.pk, userId: user.userId, name: user.name } }) : err(401, 'not signed in');
      if (p === '/api/config') return json(configPayload());
      if (p === '/api/bootstrap') return json(await bootstrapPayload());
      if (p === '/api/extras') return json(await extrasPayload());
      if (p === '/api/sentiment') return json(await news.sentimentStatus(((await snaps.get('bootstrap')) || { stocks: [] }).stocks.map((s) => s.sym)));
      let m = /^\/api\/stock\/([^/]+)$/.exec(p);
      if (m) { const sym = decodeURIComponent(m[1]).toUpperCase(); return SYMBOL_RE.test(sym) ? json(await stockPayload(sym)) : err(400, 'bad symbol'); }
      if (p === '/api/search') return json(await market.search(qs.get('q') || ''));
      m = /^\/api\/news\/(india|global)$/.exec(p);
      if (m) return json(await news.regionNews(m[1]));
      m = /^\/api\/news\/stock\/([^/]+)$/.exec(p);
      if (m) { const sym = decodeURIComponent(m[1]).toUpperCase(); return SYMBOL_RE.test(sym) ? json(await news.stockNews(sym)) : err(400, 'bad symbol'); }
      if (p === '/api/options/meta') return json({ symbols: await opts.symbols(), scheduler: { inbox: 'Import CSV button (this phone has no inbox folder)', intervalSeconds: 0, lastRun: null, nextRun: null, result: 'manual import only' }, snapshots: await opts.snapshots(10), dbPath: 'app-private storage' });
      if (p === '/api/audit') return json({ entries: await opts.auditLog(qs.get('limit') || '30'), verify: await opts.verifyAudit() });
      if (p === '/api/metrics') return json({ platform: 'mobile', nse: { offline: cfg.offline, available: nse.available(), retryInSeconds: nse.retryInSeconds() } });
      if (p === '/api/options') { const sym = qs.get('symbol') || 'NIFTY'; return OPT_SYMBOL.test(sym) ? json(await optionChain(sym, (qs.get('expiry') || '').slice(0, 32))) : err(400, 'bad symbol'); }
      return err(404, 'not found');
    } catch (e) {
      if (e instanceof UpstreamBlocked) return err(502, String(e.message).slice(0, 300));
      return err(502, String((e && e.message) || e).slice(0, 300));
    }
  }

  return { handle, nse, market, news, accounts, opts, snaps, cache, storage, cfg };
}
