/* NSE market data assembly: universe snapshot, per-stock detail, background extras, symbol search. Port of market.py. */
import * as analysis from './analysis.js';
import { SECTOR_MAP, SECTOR_INDICES } from './sectors.js';

export { SECTOR_MAP };
export const HEADLINE_INDICES = ['NIFTY 50', 'NIFTY BANK', 'NIFTY NEXT 50', 'NIFTY MIDCAP 100'];
export const SYMBOL_RE = /^[A-Za-z0-9&_-]{1,24}$/;
const DIV_RE = /(?:Rs\.?|Re\.?|INR)\s*([0-9]+(?:\.[0-9]+)?)/i;
const isoDay = (d) => d.toISOString().slice(0, 10);
const opt = async (p, dflt) => { try { return await p; } catch (e) { return dflt; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ttmDividend(actions, today = new Date()) {
  const cutoff = isoDay(new Date(today.getTime() - 365 * 86400000));
  let total = 0;
  for (const a of actions || []) {
    if (a.actionType === 'DIVIDEND' && (a.exDate || '') >= cutoff) { const m = DIV_RE.exec(a.purpose || ''); if (m) total += parseFloat(m[1]); }
  }
  return analysis.pyRound(total, 2);
}

export class Market {
  constructor({ nse, snaps, cache, settings = {}, now = () => new Date() }) {
    Object.assign(this, { nse, snaps, cache, now });
    this.universeSize = settings.universeSize || 60;
    this.extrasJob = { state: 'idle', done: 0, total: 0 };
  }

  async corpActions(sym, years = 2) {
    const today = this.now(), frm = isoDay(new Date(today.getTime() - 365 * years * 86400000));
    return ((await this.nse.bh('get_corporate_actions', { symbol: sym, fromDate: frm, toDate: isoDay(today) })).actions) || [];
  }

  async buildBootstrap() {
    const n = this.nse;
    const pLive = n.cm('cm_get_live_indices', { group: '', nameFilter: '' }), pSnap = n.bh('get_index_snapshot', { date: '', filter: '' });
    const pMood = n.bh('get_market_mood', { date: '' }), pBreadth = n.bh('get_market_breadth', { date: '' });
    const pTop = n.bh('get_top_by_volume', { date: '', n: this.universeSize + 60, sortBy: 'value' });
    [pLive, pSnap, pMood, pBreadth].forEach((p) => p.catch(() => {}));
    const top = await pTop;   // required: defines the stock universe
    const syms = (top.stocks || []).filter((s) => s.series === 'EQ').slice(0, this.universeSize).map((s) => s.symbol);
    const qs = syms.map((s) => opt(n.cm('cm_get_stock_quote', { symbol: s }), {}));
    const [live, snap, mood, breadth] = [await opt(pLive, {}), await opt(pSnap, {}), await opt(pMood, {}), await opt(pBreadth, {})];
    const quotes = Object.fromEntries(syms.map((s, i) => [s, null]));
    (await Promise.all(qs)).forEach((q, i) => { quotes[syms[i]] = (q && q.stock) || {}; });

    const liveIdx = {};
    Object.values(live.indices || {}).forEach((group) => group.forEach((i) => { liveIdx[i.indexName.toUpperCase()] = i; }));
    const snapIdx = Object.fromEntries((snap.indices || []).map((i) => [i.indexName.toUpperCase(), i]));

    const stocks = [];
    for (const sym of syms) {
      const q = quotes[sym];
      if (!q.lastTradedPrice) continue;
      stocks.push({ sym, sector: SECTOR_MAP[sym] || 'Other', price: q.lastTradedPrice, prev: q.preClosePrice, open: q.openPrice, high: q.highPrice, low: q.lowPrice,
        volume: q.volume, valueCr: q.value, hi52: q.fiftyTwoWeekHigh, lo52: q.fiftyTwoWeekLow, pct30: q.perChange30d, ts: q.latestTimestamp });
    }
    if (!stocks.length) throw new Error('no quotes returned from NSE MCP');

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
      sectorIndices: sectorIdx, mood, breadth, stocks, sectorSource: 'static classification (not provided by NSE)',
    };
    await this.snaps.put('bootstrap', boot);
    return boot;
  }

  /* extras: price history and corporate actions for every tracked stock. Runs only while the app is open. */
  startExtras(syms) {
    if (!syms.length || !this.nse.available() || this.extrasJob.state === 'running') return Promise.resolve(false);
    return this.snaps.age('extras').then((age) => {
      if (age !== null && age < 6 * 3600) return false;
      const job = (this.extrasJob = { state: 'running', done: 0, total: syms.length });
      (async () => {
        const data = {};
        for (const sym of syms) {   // sequential: the NSE client already caps concurrency, and a phone should stay polite
          const out = { spark: [], closes: [], actions: null };
          try {
            const h = await this.nse.bh('get_stock_history', { symbol: sym, months: 3, endDate: '' });
            const closes = (h.data || []).filter((r) => r.close).map((r) => r.close);
            out.closes = closes.slice(-70); out.spark = closes.slice(-22);
          } catch (e) { /* leave empty */ }
          try { out.actions = await this.corpActions(sym, 3); } catch (e) { /* leave null */ }
          data[sym] = out; job.done++;
          if (!this.nse.available()) break;
        }
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
      out[sym] = { spark: e.spark || [], divTtm: div, tech, fund };
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
    const boot = (await this.snaps.get('bootstrap')) || {}, ctx = analysis.valuationContext(boot), sector = SECTOR_MAP[d.sym];
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
    q = (q || '').trim().toUpperCase();
    if (!q || !SYMBOL_RE.test(q.replace(/ /g, ''))) return { results: [], source: 'none', note: '' };
    const local = Object.entries(await this.knownSymbols()).filter(([k]) => k.includes(q)).map(([, v]) => v);
    local.sort((a, b) => (!a.symbol.startsWith(q) - !b.symbol.startsWith(q)) || a.symbol.localeCompare(b.symbol));
    let results = local.slice(0, 10).map((v) => ({ ...v, source: 'local' })), note = '';
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
}
