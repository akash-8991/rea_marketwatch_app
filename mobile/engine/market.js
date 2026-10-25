/* NSE market data assembly: universe snapshot, per-stock detail, background extras, symbol search. Port of market.py. */
import * as analysis from './analysis.js';
import { SECTOR_INDICES } from './sectors.js';
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
        const remote = await this.cache.cached('search:' + q, 600, () => this.nse.bh('search_symbols', { query: q }));
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
}
