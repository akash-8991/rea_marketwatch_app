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
  }

  /** Prefer the copy saved by a previous refresh. */
  async load() {
    const saved = await this.s.get('securities');
    if (saved && saved.rows && saved.rows.length >= MIN_ROWS) {
      this.rows = new Map(saved.rows.map(([sym, industry, company]) => [sym, { company, industry }]));
      this.meta = { updated: saved.updated, source: saved.source };
    }
  }

  sector(sym) { const r = this.rows.get(sym); return r ? r.industry : 'Other'; }
  get(sym) { return this.rows.get((sym || '').toUpperCase()) || null; }
  members(industry) { return [...this.rows].filter(([, r]) => r.industry === industry).map(([s]) => s); }
  status() { return { count: this.rows.size, industries: new Set([...this.rows.values()].map((r) => r.industry)).size, ...this.meta }; }

  searchNames(q, limit = 8) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || words.reduce((a, w) => a + w.length, 0) < 3) return [];
    const hits = [...this.rows].filter(([, r]) => words.every((w) => r.company.toLowerCase().includes(w)));
    hits.sort(([, a], [, b]) => (b.company.toLowerCase().startsWith(words[0]) - a.company.toLowerCase().startsWith(words[0])) || a.company.localeCompare(b.company));
    return hits.slice(0, limit).map(([symbol, r]) => ({ symbol, name: r.company, industry: r.industry }));
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
