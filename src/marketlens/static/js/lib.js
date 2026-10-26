/* MarketLens shared helpers (ES module): formatting, storage, API client, small UI components. No state of its own except
 * the connection tracker. Imported by app.js and by lazily loaded view modules such as screener.js. */

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- formatting ---------- */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n, d = 2) => (n == null || Number.isNaN(n) ? '—' : Number(n).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
export const signed = (n, d = 2) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${money(Math.abs(n), d)}`);
export const cls = (n) => (n >= 0 ? 'up' : 'down');
export const arrow = (n) => (n >= 0 ? '▲' : '▼');
export const chgPct = (s) => (s.prevClose ? ((s.price - s.prevClose) / s.prevClose) * 100 : 0);
export const pos52 = (s) => (s.hi52 > s.lo52 ? Math.min(100, Math.max(0, ((s.price - s.lo52) / (s.hi52 - s.lo52)) * 100)) : null);
export const idxChange = (ix) => (ix.prev ? ((ix.last - ix.prev) / ix.prev) * 100 : 0);
export const fmtDate = (d) => { try { return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return d; } };
export const compact = (n) => (n == null ? '—' : Math.abs(n) >= 1e7 ? `${(n / 1e7).toFixed(2)} Cr` : Math.abs(n) >= 1e5 ? `${(n / 1e5).toFixed(2)} L` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)} K` : String(Math.round(n)));
export const symLink = (s) => `<a href="#/quote/${encodeURIComponent(s.sym)}">${esc(s.sym)}</a>`;
export const secTag = (s) => (s.sector && s.sector !== 'Other' ? `<span class="muted sec">${esc(s.sector)}</span>` : '');
/** 'up' / 'down' / '' by sign (zero stays neutral). cls() above treats zero as up and is kept for existing callers. */
export const sgn = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
/** Escape text and colour what it says about movement: signed numbers (+1.2%, −87.65) and "gains/rose/up 0.4%" vs "slips/fell/down 0.4%". */
export const tint = (text) => esc(text)
  .replace(/\b(gains|gained|rises|rose|climbs|jumps|advances|surges|up|higher)\s+([\d,.]+%)/gi, '<span class="up">$1 $2</span>')
  .replace(/\b(slips|slipped|falls|fell|drops|declines|sheds|dips|down|lower)\s+([\d,.]+%)/gi, '<span class="down">$1 $2</span>')
  .replace(/(^|[\s(])([+−])(\d[\d,]*(?:\.\d+)?%?)/g, (m, pre, sign, num) => `${pre}<span class="${sign === '+' ? 'up' : 'down'}">${sign}${num}</span>`);
export const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '#');

/* ---------- storage (every access guarded: it can be blocked or full) ---------- */
const GLOBAL_KEYS = new Set(['ml.theme', 'ml.dataVersion']);   // everything else belongs to the signed-in user
const scoped = (k) => (store.user && k.startsWith('ml.') && !GLOBAL_KEYS.has(k) ? `${k}@${store.user}` : k);
export const store = {
  user: null,   // set once after sign-in so each account keeps its own watchlist, saved screens and filters in this browser
  get(k, d) { try { return JSON.parse(localStorage.getItem(scoped(k))) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(scoped(k), JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
};

/* ---------- API client: timeout, bounded retries with backoff + jitter (GET only), connection tracking ---------- */
export const conn = { state: 'ok', updating: 0, lastOkAt: Date.now(), lastError: '' };
const listeners = new Set();
export const onConn = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const setConn = (patch) => { Object.assign(conn, patch); listeners.forEach((fn) => fn(conn)); };
window.addEventListener('offline', () => setConn({ state: 'offline', lastError: 'Your device is offline' }));
window.addEventListener('online', () => setConn({ state: 'ok', lastError: '' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

/** api('/api/x', {method, headers, body, timeoutMs = 10000, retries}) -> parsed JSON. POST is never retried (not idempotent). */
export async function api(path, { method = 'GET', headers, body, timeoutMs = 10000, retries, quiet = false, signal } = {}) {
  const maxRetries = method === 'GET' ? (retries ?? 2) : 0;
  if (!quiet) setConn({ updating: conn.updating + 1 });
  try {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
      if (signal) { if (signal.aborted) { clearTimeout(timer); throw new DOMException('aborted', 'AbortError'); } signal.addEventListener('abort', () => ctl.abort(), { once: true }); }
      try {
        const r = await fetch(path, { method, headers, body, signal: ctl.signal });
        const data = await r.json().catch(() => ({}));
        if (r.ok) { setConn({ state: 'ok', lastOkAt: Date.now(), lastError: '' }); return data; }
        if (r.status === 401 && !path.startsWith('/api/auth/') && !window.__signedOut) {   // session ended (signed out elsewhere, or the 15-day limit): show sign-in
          window.__signedOut = true; location.replace(location.pathname + location.search);
        }
        const transient = [429, 502, 503, 504].includes(r.status);
        if (transient && attempt < maxRetries) {
          const wait = Number(r.headers.get('Retry-After')) * 1000 || 0;
          await sleep(Math.max(wait, 400 * 2 ** attempt) + Math.random() * 250);   // exponential backoff + jitter
          continue;
        }
        setConn({ state: 'ok' });   // the server answered: the connection itself is fine
        throw new ApiError(data.error || `HTTP ${r.status}`, r.status, data);
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');   // the caller cancelled (an obsolete search): not an error, no retry, no banner
        const reason = e.name === 'AbortError' ? `no answer within ${timeoutMs / 1000} s` : 'cannot reach the local MarketLens server';
        if (attempt < maxRetries) { await sleep(400 * 2 ** attempt + Math.random() * 250); continue; }
        setConn({ state: 'offline', lastError: reason });
        throw new ApiError(reason, 0);
      } finally { clearTimeout(timer); }
    }
  } finally { if (!quiet) setConn({ updating: Math.max(0, conn.updating - 1) }); }
}

/* ---------- debounce / throttle ---------- */
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------- icons: Lucide (see icons.js), one family, currentColor ---------- */
import { lucide } from './icons.js';
const OLD = { chevron: 'chevron-down', filter: 'list-filter', columns: 'columns-3', sort: 'arrow-up-down', refresh: 'refresh-cw' };   // names used by older templates
export const icon = (name, size = 16, cls = '') => lucide(OLD[name] || name, size, cls);
/** Replace <span data-icon="name"> placeholders (used in static HTML) with the Lucide SVG. */
export function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon, +el.dataset.size || 18); el.removeAttribute('data-icon'); }); }

/* ---------- components ---------- */
export const badge = (label, title, kind) => `<span class="badge ${kind}" title="${esc(title || '')}">${esc(label)}</span>`;
export const toneKind = (l) => (/^(Bullish|Positive|Income-oriented)$/.test(l) ? 'up' : /^(Bearish|Negative|Little or no dividend income)$/.test(l) ? 'down' : 'flat');
export const skeleton = (rows = 6) => `<div class="skeleton" role="status" aria-label="Loading">${Array.from({ length: rows }, (_, i) => `<div class="sk-row" style="--w:${88 - (i % 3) * 12}%"></div>`).join('')}</div>`;
export const emptyState = (title, body, action = '') => `<div class="empty"><h2>${esc(title)}</h2><p>${esc(body)}</p>${action}</div>`;
export const errorState = (title, detail, retryId = '') => `<div class="empty error" role="alert"><h2>${esc(title)}</h2><p>${esc(detail)}</p>${retryId ? `<button class="btn" id="${retryId}">${icon('refresh')} Try again</button>` : ''}</div>`;

export function sparkline(vals, w = 120, h = 32) {
  if (!vals || vals.length < 2) return '<span class="muted">—</span>';
  const min = Math.min(...vals), max = Math.max(...vals), rng = max - min || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * w},${h - ((v - min) / rng) * (h - 4) - 2}`).join(' ');
  const c = vals[vals.length - 1] >= vals[0] ? 'var(--up)' : 'var(--down)';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="1-month price trend"><polyline fill="none" stroke="${c}" stroke-width="1.6" points="${pts}"/></svg>`;
}

/* ---------- web vitals (TTFB, FCP, LCP, CLS, INP): measured in the page, sent once when it is hidden ---------- */
export function startVitals() {
  const v = {}, worst = [];
  const watch = (type, fn, extra = {}) => { try { new PerformanceObserver((l) => fn(l.getEntries())).observe({ type, buffered: true, ...extra }); } catch (e) { /* not supported in this browser */ } };
  try { const nav = performance.getEntriesByType('navigation')[0]; if (nav) v.ttfb = nav.responseStart; } catch (e) { /* ignore */ }
  watch('paint', (es) => es.forEach((e) => { if (e.name === 'first-contentful-paint') v.fcp = e.startTime; }));
  watch('largest-contentful-paint', (es) => { v.lcp = es[es.length - 1].startTime; });
  let cls = 0;
  watch('layout-shift', (es) => { es.forEach((e) => { if (!e.hadRecentInput) cls += e.value; }); v.cls = +cls.toFixed(4); });
  watch('event', (es) => { es.forEach((e) => { if (e.interactionId) { worst.push(e.duration); worst.sort((a, b) => b - a); worst.length = Math.min(worst.length, 50); } }); if (worst.length) v.inp = worst[Math.min(worst.length - 1, Math.floor(worst.length / 50))]; }, { durationThreshold: 40 });
  window.MLVitals = { snapshot: () => ({ ...v }) };
  let sent = false;
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' || sent || !Object.keys(v).length) return;
    sent = true;
    fetch('/api/vitals', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain', 'X-Requested-With': 'MarketLens' }, body: JSON.stringify(v) }).catch(() => {});
  });
}

/** Tables never wrap their text (see .tbl in style.css), so each one lives in a horizontally scrolling box. Wrapping is done once, here,
 * for every table that appears under `root` (including ones rendered later by async views), instead of in every template. */
export function autoScrollTables(root) {
  const wrap = (t) => {
    if (t.parentElement && !t.parentElement.classList.contains('scroll')) {
      const box = document.createElement('div'); box.className = 'scroll';
      t.parentElement.insertBefore(box, t); box.appendChild(t);
    }
  };
  const sweep = () => root.querySelectorAll('table.tbl').forEach(wrap);
  sweep();
  new MutationObserver(sweep).observe(root, { childList: true, subtree: true });
}
