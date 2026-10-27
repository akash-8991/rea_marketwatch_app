/* Dependency-free logic used by the interactive views, kept apart from the DOM code so it can be unit-tested in Node (mobile/tests). */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (q) => q.trim().toLowerCase();
export const MAX_POINTS = 600;

/* ---- watchlist dashboard ---- */
export const SORTS = { symbol: 'Symbol', price: 'Price', abs: 'Change ₹', chg: 'Change %', ts: 'Last updated' };
export const FILTERS = { all: 'All', up: 'Positive', down: 'Negative', flat: 'Unchanged', stale: 'Stale or delayed', unavailable: 'Unavailable' };
export const INTERVALS = [1, 5, 15, 30, 60];
/** Which filter bucket a row belongs to. Unavailable rows have no direction; stale/delayed rows are both "stale" and still have a direction. */
export function matches(row, filter) {
  if (filter === 'all') return true;
  if (filter === 'unavailable') return row.status === 'unavailable';
  if (filter === 'stale') return row.status === 'stale' || row.status === 'delayed';
  if (row.status === 'unavailable' || row.chg == null) return false;
  return filter === 'up' ? row.chg > 0 : filter === 'down' ? row.chg < 0 : row.chg === 0;
}

/** Comparator for a sort key; rows without a value (unavailable) always sort last, in either direction. */
export function compare(key, dir) {
  const val = (r) => (key === 'symbol' ? r.sym : key === 'ts' ? (r.ts || '') : r[key]);
  return (a, b) => {
    const x = val(a), y = val(b), nx = x == null || x === '', ny = y == null || y === '';
    if (nx || ny) return nx === ny ? 0 : nx ? 1 : -1;
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return dir === 'asc' ? c : -c;
  };
}

export function summarize(rows) {
  const ok = rows.filter((r) => r.status !== 'unavailable' && r.chg != null);
  return { total: rows.length, up: ok.filter((r) => r.chg > 0).length, down: ok.filter((r) => r.chg < 0).length, flat: ok.filter((r) => r.chg === 0).length,
    unavailable: rows.filter((r) => r.status === 'unavailable').length };
}

/** Which rows to draw for a scrolled list of fixed-height rows: [first, count, spaceAbove, spaceBelow]. Measured here: 1,000 rows take ~160 ms to lay out, so
 * long lists are windowed (about 40 rows in the DOM at a time) instead of rendered whole. */
export function windowSlice(n, scrollTop, viewport, rowH, overscan = 10) {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const count = Math.min(n - first, Math.ceil(viewport / rowH) + overscan * 2);
  return [first, Math.max(0, count), first * rowH, Math.max(0, (n - first - Math.max(0, count)) * rowH)];
}
export const WINDOW_AT = 300, ROW_H = 52;


/* ---- chart ---- */
/** At most `max` points: keep each bucket's lowest and highest close (in time order) so peaks and troughs survive. */
export function decimate(points, max = MAX_POINTS) {
  if (points.length <= max) return points;
  const size = Math.ceil(points.length / (max / 2)), out = [points[0]];
  for (let i = 1; i < points.length - 1; i += size) {
    const bucket = points.slice(i, Math.min(i + size, points.length - 1));
    if (!bucket.length) continue;
    let lo = bucket[0], hi = bucket[0];
    for (const p of bucket) { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; }
    out.push(...(lo === hi ? [lo] : lo[0] < hi[0] ? [lo, hi] : [hi, lo]));
  }
  out.push(points[points.length - 1]);
  return out;
}

export const stats = (points) => {
  const closes = points.map((p) => p[1]), first = closes[0], last = closes[closes.length - 1];
  return { first, last, abs: last - first, pct: first ? ((last - first) / first) * 100 : 0, hi: Math.max(...closes), lo: Math.min(...closes), n: points.length };
};


/* ---- search palette ---- */
export function highlight(text, q) {
  const t = String(text ?? ''), words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return esc(t);
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return t.split(re).map((part, i) => (i % 2 ? `<mark class="rounded-sm bg-selection px-0.5 text-foreground">${esc(part)}</mark>` : esc(part))).join('');
}

/** Write a feed answer into the shared data. Returns how many values changed (for tests and for deciding whether to repaint). */
export function applyFeed(D, bySym, r) {
  let changed = 0;
  const set = (o, k, v) => { if (v != null && o[k] !== v) { o[k] = v; changed++; } };
  for (const x of r.indices || []) {
    const ix = (D.indices || []).find((i) => i.name.toUpperCase() === String(x.name).toUpperCase());
    if (ix) { set(ix, 'last', x.last); set(ix, 'prev', x.prev); }
  }
  for (const x of r.sectorIndices || []) {
    const t = (D.sectorIdx || []).find((s) => s.sector === x.sector);
    if (t) set(t, 'pct', x.pct);
  }
  for (const q of r.quotes || []) {
    const s = bySym[q.sym]; if (!s || !(q.price > 0) || q.status === 'unavailable') continue;
    set(s, 'price', q.price); set(s, 'prev', q.prev); set(s, 'volume', q.volume); set(s, 'ts', q.ts); set(s, 'hi52', q.hi52); set(s, 'lo52', q.lo52);
  }
  if (r.market) D.market = r.market;
  return changed;
}
