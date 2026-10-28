/* The live feed. While the market trades, this asks the server for the headline indices, the sector tiles and every stock visible on the page every 100 milliseconds
 * (/api/live), writes the answers into the shared data (window.MLData) and repaints. It never overlaps requests (the next one is scheduled after the last
 * finishes), pauses while the tab is hidden, slows to every 30 seconds when the market is shut, and backs off when the server or NSE is struggling.
 * The server answers locally; it reuses an NSE quote for up to a second and has a fixed budget of NSE calls per second, so a long list refreshes each row a little less often rather than
 * sending more requests. Other screens can add symbols with MLLive.watch([...]). */
import { api } from './lib.js';
import { applyFeed } from './pure.js';
export { applyFeed };

const MAX_SYMBOLS = 40, FAST_MS = 100, SLOW_MS = 30000;
const watched = new Set(), listeners = new Set();

/** Symbols whose price is on screen right now (rows scrolled far out of view are left out), plus anything registered with watch(). */
let scan = { at: 0, hash: '', list: [] };
export function visibleSymbols(doc = document, h = (typeof innerHeight === 'number' ? innerHeight : 800)) {
  const now = Date.now(), hash = typeof location !== 'undefined' ? location.hash : '';
  if (now - scan.at < 500 && scan.hash === hash && scan.wsz === watched.size) return scan.list;   // the DOM scan is the costly part: at most twice a second
  const out = new Set(watched);
  doc.querySelectorAll('[data-px],[data-chg]').forEach((el) => {
    const r = el.getBoundingClientRect(); if (r.height === 0 && r.width === 0) return;
    if (r.bottom > -150 && r.top < h + 150) out.add(el.dataset.px || el.dataset.chg);
  });
  const list = [...out].filter(Boolean).slice(0, MAX_SYMBOLS); scan = { at: now, hash, list, wsz: watched.size };
  return list;
}

export function start({ D, bySym, repaint }) {
  const st = { timer: 0, running: false, fails: 0, last: 0, ok: 0 };
  window.MLLive = { onFeed(fn) { listeners.add(fn); return () => listeners.delete(fn); }, watch(list) { const a = [...list]; a.forEach((s) => watched.add(s)); return () => a.forEach((s) => watched.delete(s)); }, state: st };
  const next = (ms) => { clearTimeout(st.timer); st.timer = setTimeout(tick, Math.max(0, ms)); };
  async function tick() {
    if (document.hidden || document.body.classList.contains('unauth')) return next(2000);
    const t0 = Date.now(); let wait = FAST_MS;
    try {
      const syms = visibleSymbols();
      const r = await api(`/api/live?symbols=${encodeURIComponent(syms.join(','))}`, { quiet: true, retries: 0, timeoutMs: 8000 });
      st.fails = 0; st.last = Date.now(); st.ok++;
      D.liveAt = st.last; const changed = applyFeed(D, bySym, r); if (changed || !st.painted) { repaint(r); st.painted = true; } listeners.forEach((fn) => { try { fn(r); } catch (e) { /* a view's listener must not stop the feed */ } });
      wait = (r.intervalMs || FAST_MS) - (Date.now() - t0);
    } catch (e) { st.fails++; wait = Math.min(15000, 500 * 2 ** Math.min(st.fails, 5)); }
    next(wait);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) next(0); });
  next(1500);
  return () => clearTimeout(st.timer);
}
