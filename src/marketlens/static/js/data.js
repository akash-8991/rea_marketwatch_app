/* MarketLens data layer (ES module): real NSE data via the local server (server.py -> NSE MCP).
 * Loads /api/bootstrap, builds window.MLData, then loads app.js. Sector labels come from a static map in
 * market.py (NSE does not supply them). */
import { api, errorState, skeleton, store } from './lib.js';

const root = document.getElementById('app');
root.innerHTML = skeleton(8);

const D = (window.MLData = {
  stocks: [], bySym: {}, indices: [], valuation: [], sectorIdx: [], sectors: [],
  mood: {}, breadth: {}, asOf: null, fetchedAt: null, stale: false, staleReason: '', retryIn: 0, extrasReady: false, sentiment: {}, sentimentReady: false,
});

function applyBoot(boot) {
  D.asOf = boot.asOf; D.fetchedAt = boot.fetchedAt; D.nseTimestamp = boot.nseTimestamp;
  D.market = boot.market || null; D.refreshing = !!boot.refreshing; D.stale = !!boot.stale; D.staleReason = boot.staleReason || ''; D.retryIn = boot.retryInSeconds || 0;
  D.mood = boot.mood || {}; D.breadth = boot.breadth || {};
  D.valuation = boot.valuation || []; D.sectorIdx = boot.sectorIndices || [];
  D.sectorSource = boot.sectorSource || '';
  D.indices = (boot.indices || []).map((i) => ({ id: i.name.replace(/\W+/g, '_'), name: i.name, last: i.last, prev: i.prev, pe: i.pe, pb: i.pb, divYield: i.divYield }));
  boot.stocks.forEach((b) => {
    let s = D.bySym[b.sym];
    if (!s) { s = D.bySym[b.sym] = { sym: b.sym, name: b.sym, spark: [], div: null, divTtm: null }; D.stocks.push(s); }
    Object.assign(s, {
      sector: b.sector, price: b.price, prevClose: b.prev || b.price, open: b.open, high: b.high, low: b.low,
      volume: b.volume, valueCr: b.valueCr, hi52: b.hi52, lo52: b.lo52, pct30: b.pct30, ts: b.ts, techSnap: b.techSnap || null,
    });
  });
  D.sectors = [...new Set(D.stocks.map((s) => s.sector))].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
}

function applyExtras(ex) {
  Object.entries(ex.data || {}).forEach(([sym, e]) => {
    const s = D.bySym[sym]; if (!s) return;
    if (e.spark && e.spark.length) s.spark = e.spark;
    if (e.divTtm != null && s.price) { s.divTtm = e.divTtm; s.div = +((e.divTtm / s.price) * 100).toFixed(2); }
    if (e.hi52 != null) s.hi52 = e.hi52;
    if (e.lo52 != null) s.lo52 = e.lo52;
    if (e.pct30 != null) s.pct30 = e.pct30;
    s.tech = e.tech || null; s.fund = e.fund || null;
  });
  D.extrasReady = true;
}

D.refresh = () => api('/api/bootstrap').then((b) => { applyBoot(b); return b; });

/** Poll a background job until it is ready, backing off while it runs (no tight loops). */
const poll = (path, onData, onDone) => {
  let delay = 4000;
  const tick = () => api(path, { quiet: true, retries: 0 }).then((r) => {
    const finished = onData(r);
    if (finished) onDone && onDone(); else { delay = Math.min(delay * 1.5, 30000); setTimeout(tick, delay); }
  }).catch(() => setTimeout(tick, 30000));
  tick();
};
D.loadExtras = (onReady) => poll('/api/extras', (ex) => { if (ex.ready) { applyExtras(ex); onReady && onReady(); } return ex.ready && !ex.refreshing; });
D.loadSentiment = (onUpdate) => poll('/api/sentiment', (r) => {
  if (r.data && Object.keys(r.data).length) { D.sentiment = r.data; D.sentimentReady = true; onUpdate && onUpdate(); }
  return !!r.disabled || (r.ready && !r.refreshing);
});

async function start() {
  const status = await api('/api/auth/status', { retries: 1 });
  if (status.loginRequired) {
    if (!status.signedIn) { (await import('./auth.js')).mountAuth(root, status); return; }
    window.MLUser = (await api('/api/auth/me')).user;
    store.user = `u${window.MLUser.uid}`;   // the permanent account number, so renaming your user ID keeps your watchlist and saved screens
  }
  applyBoot(await api('/api/bootstrap'));
  await import('./app.js');
}
start().catch((err) => {
  root.innerHTML = errorState('Data unavailable', `${err.message}. The NSE source could not be reached and there is no saved snapshot yet.`, 'retry-load');
  document.getElementById('retry-load')?.addEventListener('click', () => location.reload());
});
