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
export async function api(path, { method = 'GET', headers, body, timeoutMs = 10000, retries, quiet = false } = {}) {
  const maxRetries = method === 'GET' ? (retries ?? 2) : 0;
  if (!quiet) setConn({ updating: conn.updating + 1 });
  try {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
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

/* ---------- icons: one family, 16px, 1.75 stroke, currentColor ---------- */
const ICONS = {
  star: 'M8 1.8l1.9 4 4.3.5-3.2 2.9.9 4.3L8 11.3 4.1 13.5l.9-4.3L1.8 6.3l4.3-.5z',
  chevron: 'M4 6l4 4 4-4',
  filter: 'M2 3h12l-4.5 5.5V13l-3 1.5V8.5z',
  columns: 'M2 3h12v10H2zM6 3v10M10 3v10',
  download: 'M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11',
  x: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  search: 'M7 12.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11zM11 11l3.5 3.5',
  bookmark: 'M4 2h8v12l-4-3-4 3z',
  sort: 'M5 6l3-3 3 3M5 10l3 3 3-3',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  refresh: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.5',
};
export const icon = (name, size = 16) => `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${ICONS[name] || ''}"/></svg>`;

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
