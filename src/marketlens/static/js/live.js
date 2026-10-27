/* The one-second feed. While the market trades, this asks the server for the headline indices, the sector tiles and every stock visible on the page once a second
 * (/api/live), writes the answers into the shared data (window.MLData) and repaints. It never overlaps requests (the next one is scheduled after the last
 * finishes), pauses while the tab is hidden, slows to every 30 seconds when the market is shut, and backs off when the server or NSE is struggling.
 * The server answers from a one-second cache with a fixed budget of NSE calls per second, so a long list refreshes each row a little less often rather than
 * sending more requests. Other screens can add symbols with MLLive.watch([...]). */
import { api } from './lib.js';
import { applyFeed } from './pure.js';
export { applyFeed };

const MAX_SYMBOLS = 40;
const watched = new Set(), listeners = new Set();

/** Symbols whose price is on screen right now (rows scrolled far out of view are left out), plus anything registered with watch(). */
export function visibleSymbols(doc = document, h = (typeof innerHeight === 'number' ? innerHeight : 800)) {
  const out = new Set(watched);
  doc.querySelectorAll('[data-px],[data-chg]').forEach((el) => {
    const r = el.getBoundingClientRect(); if (r.height === 0 && r.width === 0) return;
    if (r.bottom > -150 && r.top < h + 150) out.add(el.dataset.px || el.dataset.chg);
  });
  return [...out].filter(Boolean).slice(0, MAX_SYMBOLS);
}

export function start({ D, bySym, repaint }) {
  const st = { timer: 0, running: false, fails: 0, last: 0, ok: 0 };
  window.MLLive = { onFeed(fn) { listeners.add(fn); return () => listeners.delete(fn); }, watch(list) { const a = [...list]; a.forEach((s) => watched.add(s)); return () => a.forEach((s) => watched.delete(s)); }, state: st };
  const next = (ms) => { clearTimeout(st.timer); st.timer = setTimeout(tick, Math.max(0, ms)); };
  async function tick() {
    if (document.hidden || document.body.classList.contains('unauth')) return next(2000);
    const t0 = Date.now(); let wait = 1000;
    try {
      const syms = visibleSymbols();
      const r = await api(`/api/live?symbols=${encodeURIComponent(syms.join(','))}`, { quiet: true, retries: 0, timeoutMs: 8000 });
      st.fails = 0; st.last = Date.now(); st.ok++;
      D.liveAt = st.last; applyFeed(D, bySym, r); repaint(r); listeners.forEach((fn) => { try { fn(r); } catch (e) { /* a view's listener must not stop the feed */ } });
      wait = (r.intervalMs || 1000) - (Date.now() - t0);
    } catch (e) { st.fails++; wait = Math.min(15000, 1000 * 2 ** Math.min(st.fails, 4)); }
    next(wait);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) next(0); });
  next(1500);
  return () => clearTimeout(st.timer);
}
