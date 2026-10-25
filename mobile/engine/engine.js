/* The on-device "server": routes the same /api/* requests the web UI already makes, with the same JSON shapes as server.py,
 * but answers them in-process. No sockets, no listening port. handle() returns {status, body, setToken?}. */
import * as analysis from './analysis.js';
import { Accounts, AuthError } from './accounts.js';
import { Cache, Snapshots, MemoryStorage } from './storage.js';
import { CsvError, OptionStore, SYMBOL_RE as OPT_SYMBOL } from './options.js';
import { Market, SYMBOL_RE } from './market.js';
import { News } from './news.js';
import { NseClient, UpstreamBlocked } from './nse.js';
import { BhavcopySource, INDEX_SYMBOLS } from './bhavcopy.js';
import { OptionFeed } from './optionfeed.js';
import { inSessionHours, lastSessionDate, marketState } from './marketclock.js';
import { summarize } from './options.js';
import { migrate } from './migrations.js';
import { SECTOR_INDICES } from './sectors.js';
import { Securities } from './securities.js';

export const VERSION = '0.3.0-mobile';
const MAX_UPLOAD = 2_000_000;

export const DEFAULTS = {
  cmUrl: 'https://mcp.nseindia.in/cmmkt/mcp', bhavcopyUrl: 'https://mcp.nseindia.in/bhavcopy/cm/mcp',
  offline: false, news: true, requireLogin: true, universeSize: 60, pbkdf2Iterations: 600000,
};

export function createEngine({ storage = new MemoryStorage(), fetchFn, optionSource = null, settings = {}, now = () => Date.now() } = {}) {
  const cfg = { ...DEFAULTS, ...settings };
  const cache = new Cache(now), snaps = new Snapshots(storage, now);
  const opts = new OptionStore(storage);
  const accounts = new Accounts(storage, opts, { iterations: cfg.pbkdf2Iterations, now: () => now() / 1000 });
  const nse = new NseClient({ storage, cmUrl: cfg.cmUrl, bhavcopyUrl: cfg.bhavcopyUrl, offline: cfg.offline, fetchFn, now: () => now() / 1000, delayMs: cfg.nseDelayMs ?? 150, timeoutMs: cfg.nseTimeoutMs ?? 20000,
    onBlocked: (code) => opts.safeAudit('upstream_blocked', 'nse', `NSE MCP returned HTTP ${code}; all NSE traffic paused for 15 min`, { outcome: 'error', channel: 'system' }) });
  const securities = new Securities({ storage, now, fetchText: async (url) => { const r = await fetchFn(url, { headers: { Accept: 'text/csv' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); },
    audit: (event, detail, outcome) => opts.safeAudit(event, 'system', detail, { outcome, channel: 'system' }) });
  const market = new Market({ nse, snaps, cache, securities, settings: cfg, now: () => new Date(now()) });
  const news = new News({ cache, snaps, fetchFn, enabled: cfg.news, delayMs: cfg.feedDelayMs ?? 200, now: () => new Date(now()) });
  const feed = new OptionFeed({ source: optionSource || new BhavcopySource({ now }), store: opts, now });
  const ready = migrate(storage, { migrations: settings.migrations, current: settings.schemaVersion }).then(() => null, (e) => e);   // data upgrade runs before the first request is served
  if (!cfg.offline && settings.refreshList !== false) ready.then((bad) => { if (!bad) securities.load().then(() => securities.refresh()).catch(() => {}); });   // the saved list first, then a weekly refresh in the background
  else ready.then((bad) => { if (!bad) securities.load().catch(() => {}); });
  const started = now();
  let bootRefresh = null;   // the one background refresh in flight

  const json = (body, status = 200, extra = {}) => ({ status, body, ...extra });
  const err = (status, message, more = {}) => json({ error: message, ...more }, status);

  /** Stale-while-revalidate: if anything is saved, answer from it AT ONCE and refresh behind the scenes (the UI polls again
   * while `refreshing` is true). Only a first run with nothing saved waits for NSE. */
  const ttl = (open, closed) => (inSessionHours(now()) ? open : closed);   // data only changes while the market trades

  /** What the live overlay should do after a base refresh: keep refreshing during the session; after the close fetch once so the
   * "last update" is the real close rather than a half-day-old end-of-day file; never repeat that catch-up for the same day. */
  function maybeStartLive(boot) {
    const syms = boot.stocks.map((s) => s.sym), t = now();
    if (inSessionHours(t)) return market.startLive(syms, null);
    const last = lastSessionDate(t), newest = boot.stocks.reduce((m, x) => ((x.ts || '').slice(0, 10) > m ? x.ts.slice(0, 10) : m), '');
    if (boot.liveCheckedFor === last || market.live.checkedFor === last || newest >= last) return false;
    return market.startLive(syms, last);
  }

  function revalidate() {
    if (!bootRefresh) {
      bootRefresh = cache.cached('bootstrap', ttl(60, 1800), async () => { const b = await market.buildBootstrap(); maybeStartLive(b); return b; }).then(() => ({ ok: true }), (e) => ({ ok: false, error: e })).then((r) => { bootRefresh = null; lastBoot = r; return r; });
    }
    return bootRefresh;
  }
  let lastBoot = null;

  async function withExtras(boot) {   // 52-week range and 30-day change arrive with the background job; show them as soon as they exist
    const raw = await snaps.get('extras');
    if (!raw) return boot;
    return { ...boot, stocks: boot.stocks.map((s) => { const e = raw[s.sym]; return e ? { ...s, hi52: s.hi52 ?? e.hi52 ?? null, lo52: s.lo52 ?? e.lo52 ?? null, pct30: s.pct30 ?? e.pct30 ?? null } : s; }) };
  }

  async function bootstrapPayload() {
    let boot;
    const memo = cache.m.get('bootstrap');
    if (memo && memo.until > now()) boot = { ...memo.val, stale: false, refreshing: false };            // fresh (< 60 s): no work at all
    else {
      const saved = await snaps.get('bootstrap');
      if (saved) {                                                                                       // instant answer, refresh in the background
        const blocked = !nse.available();
        if (!blocked) revalidate();
        const failed = !blocked && lastBoot && !lastBoot.ok && !bootRefresh;
        boot = { ...saved, stale: blocked || !!failed, refreshing: !blocked && !!bootRefresh };
        if (failed) Object.assign(boot, { staleReason: String(lastBoot.error.message).slice(0, 200), retryInSeconds: 0 });
        if (blocked) Object.assign(boot, { staleReason: nse.breaker.reason || 'offline mode', retryInSeconds: nse.retryInSeconds() });
      } else {                                                                                           // first run: nothing to show yet
        const r = await revalidate();
        if (!r.ok) throw r.error;
        boot = { ...(await snaps.get('bootstrap')), stale: false, refreshing: false };
      }
    }
    boot.offline = cfg.offline;
    const validSectors = new Set(SECTOR_INDICES.map(([sec]) => sec));
    boot.sectorIndices = (boot.sectorIndices || []).filter((x) => validSectors.has(x.sector));   // tiles saved by an older release carry old labels
    boot = await withExtras(boot);
    boot.stocks = market.mergeLive(boot.stocks);
    if (market.live.job.state === 'running') boot.refreshing = true;
    const seen = market.live.received ? market.liveSeen() : { received: 0, newest: boot.stocks.reduce((m, x) => ((x.ts || '') > m ? x.ts : m), '') };
    boot.market = marketState(now(), seen);
    boot.stocks = boot.stocks.map((s) => ({ ...s, sector: securities.sector(s.sym), techSnap: analysis.technicalSnapshot(s) }));   // classification applied at serve time, so saved snapshots follow the current list
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
    try { d = { ...(await cache.cached('stock:' + sym, ttl(60, 900), () => market.stockDetail(sym))), stale: false }; } catch (e) {
      d = await snaps.get('stock-' + sym);
      if (!d) throw e;
      d = { ...d, stale: true, staleReason: String(e.message).slice(0, 200) };
    }
    const meta = securities.get(sym) || {};
    return { ...d, analysis: await market.analyzeDetail(d), company: meta.company || null, industry: meta.industry || null };
  }

  const optionsStatus = () => ({ configured: true, auto: true, source: 'NSE end-of-day derivatives file' });

  const configPayload = () => ({ offline: cfg.offline, news: cfg.news, loginRequired: cfg.requireLogin, options: optionsStatus(), version: VERSION, rules: analysis.RULES, rateLimits: null, platform: 'mobile' });

  const INDEX_NAME = { NIFTY: 'NIFTY 50', BANKNIFTY: 'NIFTY BANK', NIFTYNXT50: 'NIFTY NEXT 50', FINNIFTY: 'NIFTY FIN SERVICE', MIDCPNIFTY: 'NIFTY MID SELECT' };

  /** Live underlying level while the market trades. The contract data (open interest, prices) is the last file NSE published. */
  async function liveSpot(sym) {
    if (!nse.available() || !marketState(now(), market.live.received ? market.liveSeen() : {}).live) return null;
    try {
      if (INDEX_NAME[sym]) return await market.indexLevel(INDEX_NAME[sym]);
      const r = await cache.cached('spot:' + sym, 60, () => nse.cm('cm_get_stock_quote', { symbol: sym }));
      return (r.stock && r.stock.lastTradedPrice) || null;
    } catch (e) { return null; }
  }

  async function optionChain(symbol, expiry) {
    const sym = (symbol || 'NIFTY').toUpperCase();
    let snap = await feed.chain(sym, expiry);
    const sp = snap ? await liveSpot(sym) : null;
    if (snap && sp) snap = { ...snap, spot: sp, spotLive: true, spotEstimated: false, summary: summarize(snap.rows, sp) };
    const st = feed.status();
    const failed = /^could not/.test(st.result);
    if (snap) return { ...snap, available: true, tool: 'NSE end-of-day file', warning: failed ? `${st.result}; showing what was saved earlier` : null, feed: st };
    return { available: false, reason: failed ? `${st.result}. Check the connection and try again, or import a CSV under “Import your own CSV”.` : `NSE has no option contracts for ${sym} in its latest file.`, feed: st };
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
    const bad = await ready;
    if (bad) return err(500, `Your saved data was not changed. ${String(bad.message).slice(0, 200)}`, { dataUpgrade: false });
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
      m = /^\/api\/peers\/([^/]+)$/.exec(p);
      if (m) { const sym = decodeURIComponent(m[1]).toUpperCase(); return SYMBOL_RE.test(sym) ? json(await market.peers(sym)) : err(400, 'bad symbol'); }
      m = /^\/api\/news\/(india|global)$/.exec(p);
      if (m) return json(await news.regionNews(m[1]));
      m = /^\/api\/news\/stock\/([^/]+)$/.exec(p);
      if (m) { const sym = decodeURIComponent(m[1]).toUpperCase(); return SYMBOL_RE.test(sym) ? json(await news.stockNews(sym)) : err(400, 'bad symbol'); }
      if (p === '/api/options/meta') {
        const st = await feed.refresh({ force: !!qs.get('refresh') });   // shares the one in-flight check; within the cooldown it returns at once
        return json({ symbols: await feed.symbols(), auto: true, feed: st, scheduler: { inbox: '', intervalSeconds: 0, lastRun: st.lastCheck, nextRun: null, result: st.result }, snapshots: await opts.snapshots(10), dbPath: 'app-private storage' });
      }
      if (p === '/api/audit') return json({ entries: await opts.auditLog(qs.get('limit') || '30'), verify: await opts.verifyAudit() });
      if (p === '/api/metrics') return json({ platform: 'mobile', nse: { offline: cfg.offline, available: nse.available(), retryInSeconds: nse.retryInSeconds() } });
      if (p === '/api/options') { const sym = qs.get('symbol') || 'NIFTY'; return OPT_SYMBOL.test(sym) ? json(await optionChain(sym, (qs.get('expiry') || '').slice(0, 32))) : err(400, 'bad symbol'); }
      return err(404, 'not found');
    } catch (e) {
      if (e instanceof UpstreamBlocked) return err(502, String(e.message).slice(0, 300));
      return err(502, String((e && e.message) || e).slice(0, 300));
    }
  }

  return { handle, feed, securities, nse, market, news, accounts, opts, snaps, cache, storage, cfg };
}
