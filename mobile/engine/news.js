/* Live headlines from Yahoo Finance and Google News RSS (headline, source, time and link only). Port of news.py.
 * The RSS reader is a small tag scanner instead of DOMParser so the same code runs in the app and in Node tests.
 * Documents that declare a DOCTYPE or ENTITY are refused (entity-expansion attacks), and only http(s) links are kept. */
import * as analysis from './analysis.js';
import { withTimeout } from './nse.js';

const MAX_BYTES = 3_000_000;
const YAHOO = (s, region, lang) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=${region}&lang=${lang}`;
const GOOGLE = (q, hl, gl, ceid) => `https://news.google.com/rss/search?q=${encodeURIComponent(q).replace(/%20/g, '+')}&hl=${hl}&gl=${gl}&ceid=${encodeURIComponent(ceid)}`;

export const REGIONS = {
  india: { yahoo: [['^NSEI', 'IN', 'en-IN'], ['^BSESN', 'IN', 'en-IN']], google: [['Sensex Nifty stocks', 'en-IN', 'IN', 'IN:en'], ['NSE BSE India stock market', 'en-IN', 'IN', 'IN:en']] },
  global: { yahoo: [['^GSPC,^DJI,^IXIC', 'US', 'en-US'], ['^FTSE,^N225,^HSI', 'US', 'en-US']], google: [['Wall Street stocks', 'en-US', 'US', 'US:en'], ['global stock markets Fed ECB', 'en-US', 'US', 'US:en']] },
};

export class FeedError extends Error {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
});
const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? decode(m[1]).trim() : ''; };

export function safeLink(link) {
  try { const u = new URL((link || '').trim()); return (u.protocol === 'http:' || u.protocol === 'https:') && u.host ? u.href : ''; } catch (e) { return ''; }
}

export function parseRss(text, kind) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new FeedError('feed rejected: contains a DOCTYPE/ENTITY declaration');
  if (!/<rss|<feed|<channel/i.test(text)) throw new FeedError('bad XML: not an RSS document');
  const items = [];
  for (const m of text.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    let title = tag(m[1], 'title');
    const link = safeLink(tag(m[1], 'link'));
    if (!title || !link) continue;
    let source = 'Yahoo Finance';
    if (kind === 'google') {
      source = tag(m[1], 'source') || 'Google News';
      const suffix = ` - ${source}`;
      if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
      else if (title.includes(' - ')) { const i = title.lastIndexOf(' - '); source = title.slice(i + 3); title = title.slice(0, i); }
    }
    const t = Date.parse(tag(m[1], 'pubDate')), ts = Number.isFinite(t) ? t / 1000 : 0;
    items.push({ title, link, source: source.trim() || 'News', provider: kind, ts, published: ts ? new Date(ts * 1000).toISOString().slice(0, 16) + '+00:00' : null });
  }
  return items;
}

const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);

export function merge(lists, limit = 60, minEach = 0) {
  const seen = new Set(), ordered = [];
  [...lists.flat()].sort((a, b) => b.ts - a.ts).forEach((it) => { const k = norm(it.title); if (k && !seen.has(k)) { seen.add(k); ordered.push(it); } });
  const keep = ordered.slice(0, limit);
  if (minEach) {
    const have = new Set(keep);
    for (const provider of new Set(ordered.map((i) => i.provider))) {
      for (const it of ordered.filter((i) => i.provider === provider).slice(0, minEach)) if (!have.has(it)) { keep.push(it); have.add(it); }
    }
    keep.sort((a, b) => b.ts - a.ts);
  }
  return keep;
}

export class News {
  constructor({ cache, snaps, fetchFn = (...a) => fetch(...a), enabled = true, delayMs = 200, now = () => new Date() }) { Object.assign(this, { cache, snaps, fetchFn, enabled, delayMs, now }); }

  async fetchText(url) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await withTimeout(this.fetchFn(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml' }, signal: ctl.signal }), 15000);
      if (!r.ok) throw new FeedError(`HTTP ${r.status}`);
      const raw = await withTimeout(r.text(), 15000);
      if (raw.length > MAX_BYTES) throw new FeedError('feed too large');
      return raw;
    } catch (e) { throw e instanceof FeedError ? e : new FeedError(e.message || 'network error'); } finally { clearTimeout(timer); }
  }

  async gather(urls) {
    const lists = [], errors = [];
    for (const [url, kind] of urls) {
      try { lists.push(parseRss(await this.fetchText(url), kind)); } catch (e) { errors.push(`${kind}: ${e.message}`); }
      await sleep(this.delayMs);
    }
    return [lists, errors];
  }

  async regionNews(name) {
    if (!REGIONS[name]) throw new Error('unknown region');
    if (!this.enabled) return { region: name, items: [], disabled: true };
    const cfg = REGIONS[name];
    const urls = [...cfg.yahoo.map(([s, r, l]) => [YAHOO(s, r, l), 'yahoo']), ...cfg.google.map(([q, hl, gl, ceid]) => [GOOGLE(q, hl, gl, ceid), 'google'])];
    const build = async () => {
      const [lists, errors] = await this.gather(urls);
      if (!lists.some((l) => l.length)) throw new FeedError(errors.join('; ') || 'no headlines returned');
      const items = merge(lists, 60, 15);
      items.forEach((it) => { it.sentiment = analysis.headlineScore(it.title)[0]; });
      const out = { region: name, items, fetchedAt: this.now().toISOString().slice(0, 19), errors };
      await this.snaps.put('news-' + name, out);
      return out;
    };
    try { return { ...(await this.cache.cached('news:' + name, 300, build)), stale: false }; } catch (e) {
      const snap = await this.snaps.get('news-' + name);
      if (snap) return { ...snap, stale: true, staleReason: String(e.message).slice(0, 160) };
      throw e;
    }
  }

  async stockNews(sym, limit = 12) {
    if (!this.enabled) return { sym, items: [], disabled: true };
    const urls = [[YAHOO(sym + '.NS', 'IN', 'en-IN'), 'yahoo'], [GOOGLE(`"${sym}" NSE share`, 'en-IN', 'IN', 'IN:en'), 'google']];
    return this.cache.cached('snews:' + sym, 1800, async () => {
      const [lists, errors] = await this.gather(urls);
      if (!lists.some((l) => l.length)) throw new FeedError(errors.join('; ') || 'no headlines returned');
      const items = merge(lists, limit);
      return { sym, items, sentiment: analysis.sentiment(items.map((i) => i.title)), fetchedAt: this.now().toISOString().slice(0, 19) };
    });
  }

  /** Screener sentiment: one stock at a time and only while the app is open (a phone does not run in the background). */
  async sentimentStatus(symbols) {
    if (!this.enabled) return { ready: false, disabled: true, data: {} };
    const saved = await this.snaps.get('sentiment'), age = await this.snaps.age('sentiment');
    const fresh = saved && age !== null && age < 3 * 3600;
    if (!fresh && this.job?.state !== 'running' && symbols.length) this.startJob(symbols);
    const j = this.job || { done: 0, total: 0, state: 'idle' };
    return { ready: !!saved, refreshing: j.state === 'running', done: j.done, total: j.total, data: saved || {} };
  }

  startJob(symbols) {
    const job = (this.job = { state: 'running', done: 0, total: symbols.length });
    (async () => {
      const data = {};
      for (const sym of symbols) {
        try {
          const r = await this.stockNews(sym, analysis.RULES.sentMaxHeadlines);
          data[sym] = { ...r.sentiment, top: r.items.slice(0, 3).map((i) => ({ title: i.title, link: i.link, source: i.source })) };
        } catch (e) { data[sym] = { score: null, label: 'No news', n: 0, pos: 0, neg: 0, top: [] }; }
        job.done++;
        await sleep(600);
      }
      if (Object.values(data).some((v) => v.n)) await this.snaps.put('sentiment', data);
      job.state = 'idle';
    })();
  }
}
