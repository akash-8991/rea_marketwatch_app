/* The list of stocks the app knows by name and industry: NSE Indices' "Nifty Total Market" constituents (about 750 stocks).
 * Same policy as the desktop app (src/marketlens/securities.py): start from the list bundled in the app (sectors.js), prefer the copy
 * saved in the app's storage by the last successful refresh, and refresh at most weekly from the official public download. A failed or
 * invalid download changes nothing. Both URLs are plain public files; the request says what it is and no browser is imitated. */
import { SECURITIES } from './sectors.js';
import { readCsv } from './options.js';

// NSE's archive first; Nifty Indices' site second (it sometimes answers with a web page instead of the file, and its copy has differed by a stock).
export const SOURCES = ['https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv', 'https://www.niftyindices.com/IndexConstituent/ind_niftytotalmarket_list.csv'];
export const REFRESH_EVERY_MS = 7 * 24 * 3600 * 1000;
export const MIN_ROWS = 500;
export class ListError extends Error {}

// Every equity listed on NSE (about 2,600, with each one's listing date): NSE's own public download. The Nifty Total Market list covers about 750 stocks and only gains a
// new company when the index is rebalanced, so a fresh listing would otherwise be missing from search and stock pages for months.
export const LISTED_SOURCE = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
export const LISTED_REFRESH_MS = 6 * 3600 * 1000;
export const MIN_LISTED = 1500;
export const UNCLASSIFIED = 'Unclassified';   // listed on NSE but not in the Nifty Total Market list, so NSE Indices gives it no industry
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

/** Parse and validate NSE's EQUITY_L.csv -> Map symbol -> {company, series, listed ('YYYY-MM-DD'), isin, lot}. Throws ListError. */
export function parseListed(text) {
  const rows = readCsv(text.replace(/^\ufeff/, '')).filter((r) => r.some((c) => c.trim()));
  const head = (rows.shift() || []).map((h) => h.trim().toUpperCase()), col = (n) => head.indexOf(n);
  const [si, ni, se, di, ii, li] = ['SYMBOL', 'NAME OF COMPANY', 'SERIES', 'DATE OF LISTING', 'ISIN NUMBER', 'MARKET LOT'].map(col);
  if (si < 0 || ni < 0 || se < 0 || di < 0) throw new ListError('missing columns: expected SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING');
  const out = new Map();
  for (const r of rows) {
    const sym = (r[si] || '').trim(), name = (r[ni] || '').trim(); if (!sym || !name) continue;
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((r[di] || '').trim()), mo = m ? MONTHS[m[2].toUpperCase()] : undefined;
    const listed = m && mo !== undefined ? new Date(Date.UTC(+m[3], mo, +m[1])).toISOString().slice(0, 10) : '';
    out.set(sym, { company: name, series: (r[se] || '').trim(), listed, isin: ii >= 0 ? (r[ii] || '').trim() : '', lot: li >= 0 && /^\d+$/.test((r[li] || '').trim()) ? +r[li] : null });
  }
  if (out.size < MIN_LISTED) throw new ListError(`only ${out.size} stocks; expected at least ${MIN_LISTED}`);
  return out;
}

/** Parse and validate CSV text -> Map symbol -> {company, industry}. Throws ListError. */
export function parseList(text) {
  const rows = readCsv(text.replace(/^﻿/, '')).filter((r) => r.some((c) => c.trim()));
  const head = (rows.shift() || []).map((h) => h.trim()), col = (n) => head.indexOf(n);
  const [ci, ii, si] = [col('Company Name'), col('Industry'), col('Symbol')];
  if (ci < 0 || ii < 0 || si < 0) throw new ListError('missing columns: expected Company Name, Industry, Symbol');
  const out = new Map();
  for (const r of rows) {
    const sym = (r[si] || '').trim(), ind = (r[ii] || '').trim(), name = (r[ci] || '').trim();
    if (sym && ind && name) out.set(sym, { company: name, industry: ind });
  }
  if (out.size < MIN_ROWS) throw new ListError(`only ${out.size} stocks; expected at least ${MIN_ROWS}`);
  return out;
}

export class Securities {
  constructor({ storage, fetchText, now = () => Date.now(), audit = async () => {} }) {
    Object.assign(this, { s: storage, fetchText, now, audit });
    this.rows = new Map(Object.entries(SECURITIES).map(([sym, [industry, company]]) => [sym, { company, industry }]));
    this.meta = { updated: null, source: 'bundled with the app' };
    this.inflight = null;
    this.listed = new Map();   // every NSE-listed equity (downloaded; saved in storage so it works offline afterwards)
    this.listedMeta = { updated: null }; this.listedInflight = null;
  }

  /** Prefer the copy saved by a previous refresh. */
  async load() {
    const saved = await this.s.get('securities');
    if (saved && saved.rows && saved.rows.length >= MIN_ROWS) {
      this.rows = new Map(saved.rows.map(([sym, industry, company]) => [sym, { company, industry }]));
      this.meta = { updated: saved.updated, source: saved.source };
    }
    const l = await this.s.get('listed');
    if (l && l.rows && l.rows.length >= MIN_LISTED) { this.listed = new Map(l.rows.map(([sym, company, series, listed, isin, lot]) => [sym, { company, series, listed, isin, lot }])); this.listedMeta = { updated: l.updated }; }
  }

  sector(sym) { const r = this.rows.get(sym); return r ? r.industry : 'Other'; }
  /** The stock's name and industry: from the Nifty Total Market list, or, for any other NSE-listed equity (a new listing, say), from NSE's full list with the industry Unclassified. */
  get(sym) {
    const s = (sym || '').toUpperCase(), r = this.rows.get(s); if (r) return r;
    const x = this.listed.get(s); return x ? { company: x.company, industry: UNCLASSIFIED, series: x.series, isin: x.isin, listed: x.listed, inIndex: false } : null;
  }
  members(industry) { return [...this.rows].filter(([, r]) => r.industry === industry).map(([s]) => s); }
  status() { return { count: this.rows.size, industries: new Set([...this.rows.values()].map((r) => r.industry)).size, ...this.meta }; }

  searchNames(q, limit = 8) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || words.reduce((a, w) => a + w.length, 0) < 3) return [];
    const hits = [...this.rows].filter(([, r]) => words.every((w) => r.company.toLowerCase().includes(w)));
    for (const [s, r] of this.listed) if (!this.rows.has(s) && words.every((w) => r.company.toLowerCase().includes(w))) hits.push([s, { company: r.company, industry: UNCLASSIFIED }]);
    hits.sort(([, a], [, b]) => (b.company.toLowerCase().startsWith(words[0]) - a.company.toLowerCase().startsWith(words[0])) || a.company.localeCompare(b.company));
    return hits.slice(0, limit).map(([symbol, r]) => ({ symbol, name: r.company, industry: r.industry }));
  }

  /** Listed symbols that contain q (any NSE-listed equity, including ones too new for NSE's end-of-day search). */
  searchSymbols(q, limit = 10) {
    q = String(q || '').toUpperCase().replace(/ /g, ''); if (q.length < 2) return [];
    return [...this.listed.keys()].filter((s) => s.includes(q)).sort((a, b) => (!a.startsWith(q) - !b.startsWith(q)) || a.length - b.length || a.localeCompare(b)).slice(0, limit).map((symbol) => ({ symbol, name: this.listed.get(symbol).company }));
  }

  /** Equities that listed in the last `days` days (newest first), plus ones that list in the next week. */
  newListings(days = 60, today = new Date(this.now())) {
    const day = (d) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + d)).toISOString().slice(0, 10), lo = day(-days), hi = day(7), t = day(0);
    return [...this.listed].filter(([, r]) => r.listed && r.listed >= lo && r.listed <= hi).sort(([sa, a], [sb, b]) => (a.listed < b.listed ? 1 : a.listed > b.listed ? -1 : sa < sb ? 1 : -1))
      .map(([symbol, r]) => ({ symbol, company: r.company, listed: r.listed, series: r.series, upcoming: r.listed > t, inIndex: this.rows.has(symbol) }));
  }

  dueListed() { return !this.listedMeta.updated || this.now() - this.listedMeta.updated >= LISTED_REFRESH_MS; }

  /** Download NSE's list of all listed equities if it is due. Single flight, never throws; a bad download changes nothing. */
  refreshListed({ force = false } = {}) {
    if (this.listedInflight) return this.listedInflight;
    if (!force && !this.dueListed()) return Promise.resolve({ skipped: 'checked within the last 6 hours' });
    this.listedInflight = (async () => {
      try {
        const rows = parseListed(await this.fetchText(LISTED_SOURCE)), added = [...rows.keys()].filter((s) => !this.listed.has(s));
        this.listed = rows; this.listedMeta = { updated: this.now() };
        await this.s.set('listed', { updated: this.now(), rows: [...rows].map(([s, r]) => [s, r.company, r.series, r.listed, r.isin, r.lot]) });
        await this.audit('securities_updated', `${rows.size} listed equities from nsearchives.nseindia.com: +${added.length} new`, 'ok');
        return { changed: added.length > 0, added, count: rows.size };
      } catch (e) {
        this.listedMeta = { updated: this.now() };   // remember that we tried; the next try is in 6 hours
        await this.audit('securities_update_failed', `listed equities: kept the saved list (${String(e.message || e).slice(0, 100)})`, 'error');
        return { skipped: `download failed (${String(e.message || e).slice(0, 100)})` };
      } finally { this.listedInflight = null; }
    })();
    return this.listedInflight;
  }

  due() { return !this.meta.updated || this.now() - this.meta.updated >= REFRESH_EVERY_MS; }

  /** Download the official list if it is due. Single flight, never throws. */
  refresh({ force = false } = {}) {
    if (this.inflight) return this.inflight;
    if (!force && !this.due()) return Promise.resolve({ skipped: 'checked within the last 7 days' });
    this.inflight = (async () => {
      let last = null;
      try {
        for (const url of SOURCES) {
          const host = new URL(url).host;
          try {
            const rows = parseList(await this.fetchText(url));
            const added = [...rows.keys()].filter((s) => !this.rows.has(s)), removed = [...this.rows.keys()].filter((s) => !rows.has(s));
            const moved = [...rows].filter(([s, r]) => this.rows.has(s) && this.rows.get(s).industry !== r.industry).map(([s]) => s);
            this.rows = rows; this.meta = { updated: this.now(), source: host };
            await this.s.set('securities', { updated: this.now(), source: host, rows: [...rows].map(([s, r]) => [s, r.industry, r.company]) });
            await this.audit('securities_updated', `${rows.size} stocks from ${host}: +${added.length} -${removed.length} industry changes ${moved.length}`, 'ok');
            return { changed: !!(added.length || removed.length || moved.length), added, removed, moved, source: host };
          } catch (e) { last = `${host}: ${String(e.message || e).slice(0, 100)}`; }
        }
        this.meta = { ...this.meta, updated: this.now() };   // remember that we tried, so a dead link is retried next week, not on every start
        await this.s.set('securities', { updated: this.now(), source: this.meta.source, rows: [...this.rows].map(([s, r]) => [s, r.industry, r.company]) });
        await this.audit('securities_update_failed', `kept the saved list: ${last}`, 'error');
        return { skipped: `download failed (${last})` };
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }
}
