/* NSE market data assembly: universe snapshot, per-stock detail, background extras, symbol search. Port of market.py. */
import * as analysis from './analysis.js';
import { SECTOR_INDICES } from './sectors.js';
import { inSessionHours, marketState } from './marketclock.js';
import { Ticks } from './ticks.js';
export const HEADLINE_INDICES = ['NIFTY 50', 'NIFTY BANK', 'NIFTY NEXT 50', 'NIFTY MIDCAP 100'];
export const SYMBOL_RE = /^[A-Za-z0-9&_-]{1,24}$/;
const DIV_RE = /(?:Rs\.?|Re\.?|INR)\s*([0-9]+(?:\.[0-9]+)?)/i;
const isoDay = (d) => d.toISOString().slice(0, 10);
const opt = async (p, dflt) => { try { return await p; } catch (e) { return dflt; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Change over the last 30 calendar days from daily rows ({date, close}), like NSE's perChange30d. */
export function pct30(rows) {
  const last = rows[rows.length - 1], cutoff = isoDay(new Date(new Date(last.date + 'T00:00:00Z').getTime() - 30 * 86400000));
  let base = null;
  for (const r of rows) { if (r.date <= cutoff) base = r; else break; }
  return base && base.close ? analysis.pyRound(((last.close - base.close) / base.close) * 100, 2) : null;
}

export function ttmDividend(actions, today = new Date()) {
  const cutoff = isoDay(new Date(today.getTime() - 365 * 86400000));
  let total = 0;
  for (const a of actions || []) {
    if (a.actionType === 'DIVIDEND' && (a.exDate || '') >= cutoff) { const m = DIV_RE.exec(a.purpose || ''); if (m) total += parseFloat(m[1]); }
  }
  return analysis.pyRound(total, 2);
}

export class Market {
  constructor({ nse, snaps, cache, securities, settings = {}, now = () => new Date() }) {
    Object.assign(this, { nse, snaps, cache, securities, now });
    this.universeSize = settings.universeSize || 60;
    this.extrasJob = { state: 'idle', done: 0, total: 0 };
    this.freshAt = new Map();
    this.ticks = new Ticks({ snaps, now: () => this.now().getTime() });
    this.active = new Map();   // symbol -> last time a client asked for it (the symbols that count against the live budget)
    this.searchDeadlineMs = settings.searchDeadlineMs || 450;   // symbol search answers from saved matches if NSE's search has not replied by then
    this.quoteDeadlineMs = settings.quoteDeadlineMs || 6000;   // a quote is answered from the saved copy if NSE has not replied by then
    this.live = { quotes: {}, received: 0, newest: '', job: { state: 'idle', done: 0, total: 0 }, checkedFor: null };
  }

  async corpActions(sym, years = 2) {
    const today = this.now(), frm = isoDay(new Date(today.getTime() - 365 * years * 86400000));
    return ((await this.nse.bh('get_corporate_actions', { symbol: sym, fromDate: frm, toDate: isoDay(today) })).actions) || [];
  }

  /** The home-page universe in a handful of calls: the five index/market calls and the top-50 list run together, then ONE bulk
   * quote for all symbols (it used to be one call per stock). 52-week range and 30-day change are filled in later by the extras job. */
  async buildBootstrap() {
    const n = this.nse;
    const settle = [n.cm('cm_get_live_indices', { group: '', nameFilter: '' }), n.bh('get_index_snapshot', { date: '', filter: '' }), n.bh('get_market_mood', { date: '' }), n.bh('get_market_breadth', { date: '' })];
    settle.forEach((p) => p.catch(() => {}));
    const top = await n.bh('get_top_by_volume', { date: '', n: 50, sortBy: 'value' });   // required: defines the stock universe (the tool returns at most 50)
    const eq = (top.stocks || []).filter((s) => s.series === 'EQ').slice(0, this.universeSize);
    const syms = eq.map((s) => s.symbol), turnover = Object.fromEntries(eq.map((s) => [s.symbol, s.traded_value]));
    const chunks = []; for (let i = 0; i < syms.length; i += 50) chunks.push(syms.slice(i, i + 50));
    const bulk = (await Promise.all(chunks.map((c) => n.bh('get_bulk_quote', { symbols: c })))).flatMap((r) => r.quotes || []);
    const [live, snap, mood, breadth] = await Promise.all(settle.map((p) => opt(p, {})));

    const liveIdx = {};
    Object.values(live.indices || {}).forEach((group) => group.forEach((i) => { liveIdx[i.indexName.toUpperCase()] = i; }));
    const snapIdx = Object.fromEntries((snap.indices || []).map((i) => [i.indexName.toUpperCase(), i]));

    const stocks = bulk.filter((q) => q.close).map((q) => ({
      sym: q.symbol, sector: this.securities.sector(q.symbol), price: q.close, prev: q.prev_close, open: q.open, high: q.high, low: q.low, volume: q.volume,
      valueCr: turnover[q.symbol] != null ? analysis.pyRound(turnover[q.symbol] / 1e7, 2) : null, hi52: null, lo52: null, pct30: null, ts: q.date,
    })).sort((a, b) => syms.indexOf(a.sym) - syms.indexOf(b.sym));
    if (!stocks.length) throw new Error('no quotes returned from NSE MCP');
    // Never replace newer data with older: the end-of-day bulk file can be a day behind the live quotes saved earlier.
    const prev = (await this.snaps.get('bootstrap')) || {}, prevBy = Object.fromEntries((prev.stocks || []).map((x) => [x.sym, x]));
    for (let i = 0; i < stocks.length; i++) { const p = prevBy[stocks[i].sym]; if (p && (p.ts || '') > (stocks[i].ts || '')) stocks[i] = { ...stocks[i], ...p }; }

    const idxRow = (name) => {
      const k = name.toUpperCase(), lv = liveIdx[k] || {}, sn = snapIdx[k] || {};
      const last = lv.last || sn.close;
      const prev = lv.previousClose || (last ? last - (sn.pointsChange || 0) : null);
      return { name: sn.indexName || lv.indexName || name, last, prev, pe: sn.pe, pb: sn.pb, divYield: sn.divYield, pct: lv.percChange !== undefined ? lv.percChange : sn.pctChange };
    };
    const sectorIdx = [];
    for (const [sec, ix] of SECTOR_INDICES) { const r = idxRow(ix); if (r.last) sectorIdx.push({ sector: sec, index: r.name, pct: r.pct }); }
    const boot = {
      asOf: mood.date || breadth.date, nseTimestamp: live.nseTimestamp, fetchedAt: this.now().toISOString().slice(0, 19),
      indices: HEADLINE_INDICES.filter((x) => x in liveIdx || x in snapIdx).map(idxRow),
      valuation: Object.keys(snapIdx).filter((k) => snapIdx[k].pe).slice(0, 120).map(idxRow),
      sectorIndices: sectorIdx, mood, breadth, stocks, sectorSource: 'NSE Nifty Total Market constituents list', liveCheckedFor: prev.liveCheckedFor ?? null,
    };
    await this.snaps.put('bootstrap', boot);
    return boot;
  }

  /* live overlay: real-time quotes, one stock at a time on two lanes (NSE has no multi-symbol live call: its bulk call is end-of-day) */
  liveSeen() { return { received: this.live.received, newest: this.live.newest }; }

  /** Fetch live quotes for `syms` in the background; `checkedFor` marks a one-off catch-up (after the close) so it is not repeated. */
  startLive(syms, checkedFor = null) {
    if (!syms.length || !this.nse.available() || this.live.job.state === 'running') return false;
    const job = (this.live.job = { state: 'running', done: 0, total: syms.length });
    (async () => {
      const queue = [...syms];   // most-traded first, so the top of every list is live soonest
      const one = async (sym) => {
        const r = await opt(this.nse.cm('cm_get_stock_quote', { symbol: sym }), null), q = r && r.stock;
        if (q && q.lastTradedPrice) {
          this.live.quotes[sym] = { price: q.lastTradedPrice, prev: q.preClosePrice, open: q.openPrice, high: q.highPrice, low: q.lowPrice, volume: q.volume,
            valueCr: q.value, hi52: q.fiftyTwoWeekHigh ?? null, lo52: q.fiftyTwoWeekLow ?? null, pct30: q.perChange30d ?? null, ts: q.latestTimestamp };
          this.live.received++;
          if ((q.latestTimestamp || '') > this.live.newest) this.live.newest = q.latestTimestamp;
        }
        job.done++;
      };
      await Promise.all([0, 1].map(async () => { while (queue.length && this.nse.available()) await one(queue.shift()); }));
      this.live.checkedFor = checkedFor;
      const snap = await this.snaps.get('bootstrap');   // keep the saved copy current: next time the market is closed, "last update" is the real close
      if (snap) await this.snaps.put('bootstrap', { ...snap, stocks: this.mergeLive(snap.stocks), liveCheckedFor: checkedFor });
      job.state = 'idle';
    })();
    return true;
  }

  mergeLive(stocks) {
    return stocks.map((s) => {
      const q = this.live.quotes[s.sym];
      return q ? { ...s, ...q, hi52: q.hi52 ?? s.hi52, lo52: q.lo52 ?? s.lo52, pct30: q.pct30 ?? s.pct30 } : s;
    });
  }

  /** Live level of an index by NSE's name, cached for a minute. */
  async indexLevel(name) {
    const r = await this.cache.cached('liveidx', 60, () => this.nse.cm('cm_get_live_indices', { group: '', nameFilter: '' }));
    for (const group of Object.values(r.indices || {})) for (const i of group) if (i.indexName.toUpperCase() === name) return i.last ?? null;
    return null;
  }

  /* extras: price history and corporate actions for every tracked stock. Runs only while the app is open. */
  startExtras(syms) {
    if (!syms.length || !this.nse.available() || this.extrasJob.state === 'running') return Promise.resolve(false);
    return this.snaps.age('extras').then((age) => {
      if (age !== null && age < 6 * 3600) return false;
      const job = (this.extrasJob = { state: 'running', done: 0, total: syms.length });
      (async () => {
        const data = {}, queue = [...syms];
        const one = async (sym) => {
          const out = { spark: [], closes: [], actions: null, hi52: null, lo52: null, pct30: null };
          const [h, r, a] = await Promise.all([opt(this.nse.bh('get_stock_history', { symbol: sym, months: 3, endDate: '' }), null),
            opt(this.nse.bh('get_52_week_high_low', { symbol: sym }), null), opt(this.corpActions(sym, 3), null)]);
          if (h) {
            const rows = (h.data || []).filter((x) => x.close), closes = rows.map((x) => x.close);
            out.closes = closes.slice(-70); out.spark = closes.slice(-22);
            if (rows.length) out.pct30 = pct30(rows);
          }
          if (r) { out.hi52 = r['52w_high'] ?? null; out.lo52 = r['52w_low'] ?? null; }
          out.actions = a;
          data[sym] = out; job.done++;
        };
        // two workers, matching the NSE client's two lanes: no burst, no idle lane
        await Promise.all([0, 1].map(async () => { while (queue.length && this.nse.available()) await one(queue.shift()); }));
        if (Object.values(data).some((v) => v.closes.length || v.actions !== null)) await this.snaps.put('extras', data);
        job.state = 'idle';
      })();
      return true;
    });
  }

  deriveExtras(raw, stocks, boot) {
    const ctx = analysis.valuationContext(boot), by = Object.fromEntries(stocks.map((s) => [s.sym, s])), out = {};
    for (const [sym, e] of Object.entries(raw || {})) {
      const s = by[sym] || {}, price = s.price, acts = e.actions;
      const div = acts !== null && acts !== undefined ? ttmDividend(acts, this.now()) : null;
      const tech = analysis.technicalFromHistory(e.closes || [], price);
      const fund = acts !== null && acts !== undefined ? analysis.fundamental(div, price, acts, s.sector, ctx, this.now()) : null;
      out[sym] = { spark: e.spark || [], divTtm: div, tech, fund, hi52: e.hi52 ?? null, lo52: e.lo52 ?? null, pct30: e.pct30 ?? null };
    }
    return out;
  }

  async stockDetail(sym) {
    const n = this.nse;
    const fq = n.cm('cm_get_stock_quote', { symbol: sym }), fh = n.bh('get_stock_history', { symbol: sym, months: 12, endDate: '' });
    const fr = n.bh('get_52_week_high_low', { symbol: sym }), fc = this.corpActions(sym, 3);
    [fq, fh, fr, fc].forEach((p) => p.catch(() => {}));
    const quote = (await fq).stock;
    if (!quote) throw new Error('symbol not found');
    const out = { sym, quote };
    try { const h = await fh; out.history = (h.data || []).map((r) => [r.date, r.open, r.high, r.low, r.close, r.volume]); out.historySummary = h.summary; } catch (e) { out.history = []; }
    out.range52 = await opt(fr, null); out.actions = await opt(fc, null);
    out.divTtm = ttmDividend(Array.isArray(out.actions) ? out.actions : (out.actions || {}).actions || [], this.now());
    await this.snaps.put('stock-' + sym, out);
    return out;
  }

  async analyzeDetail(d) {
    const boot = (await this.snaps.get('bootstrap')) || {}, ctx = analysis.valuationContext(boot), sector = (this.securities.get(d.sym) || {}).industry;
    const price = d.quote.lastTradedPrice, closes = (d.history || []).filter((r) => r[4]).map((r) => r[4]);
    let acts = d.actions; acts = acts && !Array.isArray(acts) ? acts.actions : acts;
    const tech = analysis.technicalFromHistory(closes, price) || analysis.technicalSnapshot({ price, prev: d.quote.preClosePrice, hi52: d.quote.fiftyTwoWeekHigh, lo52: d.quote.fiftyTwoWeekLow, pct30: d.quote.perChange30d });
    const fund = acts !== null && acts !== undefined ? analysis.fundamental(d.divTtm, price, acts, sector, ctx, this.now()) : null;
    return { tech, fund };
  }

  async knownSymbols() {
    const syms = {}, boot = (await this.snaps.get('bootstrap')) || {};
    for (const s of boot.stocks || []) syms[s.sym] = { symbol: s.sym, last_close: s.price, pct_change: s.prev ? analysis.pyRound(((s.price - s.prev) / s.prev) * 100, 2) : null, last_date: boot.asOf };
    for (const k of await this.snaps.keys('stock-')) syms[k.slice(6)] ||= { symbol: k.slice(6), last_close: null, pct_change: null, last_date: null };
    for (const k of Object.keys((await this.snaps.get('extras')) || {})) syms[k] ||= { symbol: k, last_close: null, pct_change: null, last_date: null };
    return syms;
  }

  async search(q) {
    const raw = (q || '').trim();
    q = raw.toUpperCase();
    if (!q || !SYMBOL_RE.test(q.replace(/ /g, ''))) return { results: [], source: 'none', note: '' };
    const local = Object.entries(await this.knownSymbols()).filter(([k]) => k.includes(q)).map(([, v]) => v);
    local.sort((a, b) => (!a.symbol.startsWith(q) - !b.symbol.startsWith(q)) || a.symbol.localeCompare(b.symbol));
    let results = local.slice(0, 10).map((v) => ({ ...v, source: 'local' })), note = '';
    const have = new Set(results.map((r) => r.symbol));
    results = results.concat(this.securities.searchNames(raw).filter((h) => !have.has(h.symbol)).slice(0, 6).map((h) => ({ symbol: h.symbol, name: h.name, last_close: null, pct_change: null, last_date: null, source: 'list' })));
    if (this.nse.available()) {
      try {
        const pending = this.cache.cached('search:' + q, 600, () => this.nse.bh('search_symbols', { query: q }));
        pending.catch(() => {});   // after the deadline the NSE call still finishes and is cached, so the next keystroke or repeat is complete and instant
        const remote = await withDeadline(pending, this.searchDeadlineMs);
        const seen = new Set(results.map((r) => r.symbol));
        results = results.concat((remote.results || []).filter((r) => !seen.has(r.symbol)).slice(0, 12).map((r) => ({ ...r, source: 'nse' })));
      } catch (e) { note = 'NSE search is unavailable right now; showing matches from saved data.'; }
    } else {
      note = 'NSE search is paused' + (this.nse.offline ? ' (offline mode)' : ` (retry in about ${Math.max(1, Math.floor(this.nse.retryInSeconds() / 60))} min)`) + '; showing matches from saved data.';
    }
    return { results, source: note === '' ? 'nse+local' : 'local', note };
  }

  /* ---------- peers: other stocks of the same industry (from the Nifty Total Market list) ---------- */
  /** Members of one industry ordered by last session's traded value (close x volume) from NSE's bulk quote: three calls at most. */
  async rankIndustry(members) {
    const chunks = []; for (let i = 0; i < members.length; i += 50) chunks.push(members.slice(i, i + 50));
    const quotes = (await Promise.all(chunks.map((c) => this.nse.bh('get_bulk_quote', { symbols: c })))).flatMap((r) => r.quotes || []);
    return quotes.filter((q) => q.close && q.volume).sort((a, b) => b.close * b.volume - a.close * a.volume).map((q) => q.symbol);
  }

  async liveRow(sym) {
    const q = ((await this.cache.cached('lq:' + sym, 60, () => this.nse.cm('cm_get_stock_quote', { symbol: sym }))) || {}).stock || {};
    const price = q.lastTradedPrice, prev = q.preClosePrice;
    const chg = q.perChange != null ? q.perChange : price && prev ? analysis.pyRound(((price - prev) / prev) * 100, 2) : null;
    return { price, prev, chg, volume: q.volume, valueCr: q.value, ts: q.latestTimestamp };
  }

  /** The same industry's most-traded stocks with price, change, volume and turnover; NSE's live quotes (the last close when the market is shut).
   * If NSE cannot be reached the names still show, with saved prices where we have them. */
  async peers(sym, limit = 10) {
    const row = this.securities.get(sym);
    if (!row) return { sym, company: null, industry: null, count: 0, peers: [], self: null };
    const members = this.securities.members(row.industry), out = { sym, company: row.company, industry: row.industry, count: members.length, peers: [], self: null, stale: false };
    let ranked;
    try { ranked = await this.cache.cached('peers-rank:' + row.industry, 1800, () => this.rankIndustry(members)); } catch (e) { ranked = [...members].sort(); out.stale = true; }
    const top = ranked.filter((m) => m !== sym).slice(0, limit);
    const saved = Object.fromEntries((((await this.snaps.get('bootstrap')) || {}).stocks || []).map((x) => [x.sym, x]));
    const one = async (s) => {
      let r;
      try { r = await this.liveRow(s); } catch (e) {
        const x = saved[s] || {}; out.stale = true;
        r = { price: x.price ?? null, prev: x.prev ?? null, chg: x.price && x.prev ? analysis.pyRound(((x.price - x.prev) / x.prev) * 100, 2) : null, volume: x.volume ?? null, valueCr: x.valueCr ?? null, ts: x.ts ?? null };
      }
      return { ...r, sym: s, name: (this.securities.get(s) || {}).company || s };
    };
    const rows = await Promise.all([...top, sym].map(one));
    out.peers = rows.slice(0, -1); out.self = rows[rows.length - 1];
    out.rank = ranked.includes(sym) ? ranked.indexOf(sym) + 1 : null;
    return out;
  }

  /* ---------- lean quotes (one NSE call each, coalesced and cached) ---------- */
  static LIVE_TTL = 1;       // seconds a live quote may be reused while the market trades: the feed asks again every second
  static LIVE_BUDGET = 10;   // at most this many NSE stock-quote calls per second in total; with more symbols on screen each is refreshed proportionally less often
  quoteTtl(sym) {
    const t = this.now().getTime();
    if (!inSessionHours(t)) return 900;                                   // the market is shut: nothing changes
    if (sym) this.active.set(sym, t);
    for (const [k, at] of this.active) if (t - at > 5000) this.active.delete(k);
    return Math.max(Market.LIVE_TTL, this.active.size / Market.LIVE_BUDGET);   // a fair rotation within the budget
  }

  /** One quote in the shape the UI needs, with an honest status. `state` is the market clock's verdict (see marketclock.js). */
  async quote(sym, state, fresh = false) {
    const t0 = Date.now();
    if (fresh && Date.now() - (this.freshAt.get(sym) || 0) >= 5000) { this.freshAt.set(sym, Date.now()); this.cache.m.delete('lq:' + sym); }   // 'refresh now', at most once per symbol per 5 s
    const known = this.live.quotes[sym];
    let q = null, fromCache = false, stale = false, error = null;
    try {
      const hit = this.cache.m.get('lq:' + sym);
      fromCache = !!(hit && hit.until > this.now().getTime());
      const pending = this.cache.cached('lq:' + sym, this.quoteTtl(sym), () => this.nse.cm('cm_get_stock_quote', { symbol: sym }));
      pending.catch(() => {});   // if the deadline below wins, the request still finishes in the background and fills the cache for the next caller
      q = (((await withDeadline(pending, this.quoteDeadlineMs)) || {}).stock) || null;
    } catch (e) {
      error = String(e.message || e).slice(0, 120);
      const saved = ((await this.snaps.get('bootstrap')) || { stocks: [] }).stocks.find((x) => x.sym === sym) || known;
      if (saved) { stale = true; q = { lastTradedPrice: saved.price, preClosePrice: saved.prev, volume: saved.volume, latestTimestamp: saved.ts, perChange: saved.prev ? analysis.pyRound(((saved.price - saved.prev) / saved.prev) * 100, 2) : null }; }
    }
    const row = this.securities.get(sym) || {};
    if (!q || !q.lastTradedPrice) return { sym, name: row.company || null, status: 'unavailable', reason: error || 'NSE has no quote for this symbol', exchange: 'NSE', fetchedAt: Date.now() };
    const price = q.lastTradedPrice, prev = q.preClosePrice, abs = prev != null ? analysis.pyRound(price - prev, 2) : null;
    if (!stale && inSessionHours(this.now().getTime())) this.ticks.record(sym, price, q.volume, q.latestTimestamp).catch(() => {});   // builds the intraday candles
    const chg = q.perChange != null ? q.perChange : prev ? analysis.pyRound(((price - prev) / prev) * 100, 2) : null;
    const ts = q.latestTimestamp || null, ageMs = ts ? Math.max(0, this.now().getTime() - Date.parse(ts.replace(' ', 'T') + '+05:30')) : null;
    let status = 'closed';
    if (stale) status = 'stale';
    else if (state && state.live) status = ageMs != null && ageMs > 5 * 60 * 1000 ? 'delayed' : 'live';
    return { sym, name: row.company || null, industry: row.industry || null, exchange: 'NSE', price, prev, abs, chg, open: q.openPrice ?? null, high: q.highPrice ?? null, low: q.lowPrice ?? null, volume: q.volume ?? null, valueCr: q.value ?? null,
      hi52: q.fiftyTwoWeekHigh ?? null, lo52: q.fiftyTwoWeekLow ?? null, ts, ageMs, status, fromCache, fetchedAt: Date.now(), ms: Date.now() - t0, ...(stale ? { reason: error } : {}) };
  }

  /** Many quotes at once for the watchlist: at most 50 distinct valid symbols, fetched in parallel (the client keeps two lanes busy), order kept. */
  async quotes(symbols, state, fresh = false) {
    const seen = new Set(), list = [];
    for (const raw of symbols) { const sym = String(raw || '').trim().toUpperCase(); if (sym && !seen.has(sym)) { seen.add(sym); list.push(sym); } }
    const nowMs = this.now().getTime(); list.slice(0, 50).forEach((sym) => { if (SYMBOL_RE.test(sym)) this.active.set(sym, nowMs); });   // count them all before any is fetched, so the rotation is even
    const out = await Promise.all(list.slice(0, 50).map((sym) => (SYMBOL_RE.test(sym) ? this.quote(sym, state, fresh) : Promise.resolve({ sym, status: 'unavailable', reason: 'not a valid NSE symbol', exchange: 'NSE', fetchedAt: Date.now() }))));
    return { quotes: out, requested: list.length, truncated: list.length > 50, fetchedAt: Date.now() };
  }

  /* ---------- the fast live feed: indices, sector indices and the symbols on screen, answered from a one-second cache ---------- */
  async liveIndices() {
    const ttl = inSessionHours(this.now().getTime()) ? Market.LIVE_TTL : 600;
    const live = await this.cache.cached('live:indices', ttl, () => this.nse.cm('cm_get_live_indices', { group: '', nameFilter: '' })), by = {};
    Object.values(live.indices || {}).forEach((group) => group.forEach((i) => { by[i.indexName.toUpperCase()] = i; }));
    return by;
  }

  /** Everything the screens repaint every second (at most 40 stocks). Failures degrade to what is cached. */
  async liveFeed(symbols) {
    const t = this.now().getTime(), state = marketState(t, this.live.received ? { received: this.live.received, newest: this.live.newest } : {});
    const out = { t, market: state, intervalMs: state.live ? 1000 : 30000, indices: [], sectorIndices: [], quotes: [] };
    try {
      const by = await this.liveIndices(), row = (lv, name) => ({ name: lv.indexName || name, last: lv.last, prev: lv.previousClose, pct: lv.percChange });
      out.indices = HEADLINE_INDICES.filter((n) => n in by).map((n) => row(by[n], n));
      for (const [sec, ix] of SECTOR_INDICES) { const lv = by[ix.toUpperCase()]; if (lv && lv.last) out.sectorIndices.push({ sector: sec, index: lv.indexName || ix, pct: lv.percChange }); }
    } catch (e) { out.indicesError = String(e.message || e).slice(0, 120); }
    const listed = [];
    for (const raw of symbols.slice(0, 40)) { const sym = String(raw || '').trim().toUpperCase(); if (SYMBOL_RE.test(sym) && !listed.includes(sym)) listed.push(sym); }
    if (listed.length) for (const q of (await this.quotes(listed, state)).quotes) out.quotes.push(Object.fromEntries(['sym', 'price', 'prev', 'abs', 'chg', 'open', 'high', 'low', 'volume', 'valueCr', 'ts', 'ageMs', 'status', 'hi52', 'lo52'].map((k) => [k, q[k] ?? null])));
    return out;
  }

  /** One-minute bars recorded from live quotes (see ticks.js). The chart page resamples them to 5m, 15m and 1h. */
  async intraday(sym) {
    await this.ticks.flushAll();
    const bars = await this.ticks.bars(sym);
    return { sym, bars, from: bars.length ? bars[0][0] : null, to: bars.length ? bars[bars.length - 1][0] : null, source: "recorded from live NSE quotes while MarketLens was open; NSE's servers keep daily history only" };
  }

  /* ---------- history for the chart (daily closes; NSE keeps them from 1 Jan 2024) ---------- */
  static RANGE_DAYS = { '1W': 7, '1M': 31, '3M': 92, '6M': 183, '1Y': 366, '5Y': 1830, '10Y': 3660 };

  /** Daily closes for a range. NSE returns at most three months per call and the next call needs the previous one's `next_end_date`, so chunks are
   * fetched one after another and the result saved: later ranges, and the next visit, cost nothing. */
  async history(sym, range) {
    const days = Market.RANGE_DAYS[range];
    if (!days) return { sym, range, available: false, reason: range === '1D' ? 'NSE’s servers provide daily data only, so there is no intraday chart.' : 'unknown range' };
    const key = 'hist:' + sym, cutoff = isoDay(new Date(this.now().getTime() - days * 86400000));
    let rec = await this.snaps.get(key);
    if (rec && (await this.snaps.age(key)) > 12 * 3600) rec = null;                       // older than half a day: start over
    if (rec && rec.points.length && rec.points[0].length < 6) rec = null;                 // saved by an older release without open, high and low: fetch again
    const covers = (r) => r && (r.complete || (r.points.length && r.points[0][0] <= cutoff));
    if (!covers(rec)) {
      const points = rec ? [...rec.points] : [];
      let end = rec ? rec.next || '' : '', next = rec ? rec.next || null : null, complete = false, guard = 0;
      while (!complete && guard++ < 16 && (!points.length || points[0][0] > cutoff)) {
        const h = await this.nse.bh('get_stock_history', { symbol: sym, months: 3, endDate: end });
        const rows = (h.data || []).filter((r) => r.close).map((r) => [r.date, r.close, r.volume ?? null, r.open ?? null, r.high ?? null, r.low ?? null]);
        if (!rows.length) { complete = true; break; }
        points.unshift(...rows);                                                          // older chunks go in front
        next = h.next_end_date || null;
        if (!next) { complete = true; break; }
        end = next;
      }
      rec = { points: dedupe(points), complete, next };
      await this.snaps.put(key, rec);
    }
    const pts = rec.points.filter((p) => p[0] >= cutoff);
    const earliest = rec.points.length ? rec.points[0][0] : null;
    const truncated = !!(earliest && earliest > cutoff && rec.complete);
    return { sym, range, available: pts.length > 0, points: pts, from: pts.length ? pts[0][0] : null, to: pts.length ? pts[pts.length - 1][0] : null, earliest, truncated,
      ...(truncated ? { note: `NSE’s history starts on ${earliest}; showing all of it.` } : {}), ...(pts.length ? {} : { reason: 'no price history returned for this symbol' }) };
  }
}

/** Reject after ms; the underlying promise keeps running. */
const withDeadline = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`NSE did not answer within ${ms / 1000} s`)), ms); p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

const dedupe = (pts) => { const seen = new Set(); return pts.filter((p) => (seen.has(p[0]) ? false : (seen.add(p[0]), true))).sort((a, b) => (a[0] < b[0] ? -1 : 1)); };
