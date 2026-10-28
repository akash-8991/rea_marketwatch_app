/* "New on NSE": equities that listed recently (and the ones about to list), from NSE's own list of every listed equity (/api/listings), with live prices.
 * The Nifty Total Market list behind sectors and peers only gains a company when the index is rebalanced; this card does not wait for that. */
import { $, $$, esc, money, signed, cls, arrow, api, fmtDate, symLink } from './lib.js';

const DAY = 86400000;
const when = (listed, today) => { const d = Math.round((Date.parse(listed) - Date.parse(today)) / DAY); return d > 0 ? `Lists ${d === 1 ? 'tomorrow' : `in ${d} days`}` : d === 0 ? 'Listed today' : `${-d} day${d === -1 ? '' : 's'} ago`; };

export function mount(host) {
  let alive = true, off = () => {}, unwatch = () => {};
  host.innerHTML = '<h2>New on NSE</h2><p class="muted">Loading recent listings…</p>';
  (async () => {
    let r; try { r = await api('/api/listings?days=45', { quiet: true, retries: 1, timeoutMs: 15000 }); } catch (e) { if (alive) host.innerHTML = `<h2>New on NSE</h2><p class="muted">Could not load the list of new listings (${esc(e.message)}).</p>`; return; }
    if (!alive) return;
    const rows = r.recent || [], today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    if (!rows.length) { host.innerHTML = `<h2>New on NSE</h2><p class="muted">No equity listed in the last 45 days (NSE lists ${esc(String(r.total || 0))} in all).</p>`; return; }
    const shown = rows.slice(0, 12);
    host.innerHTML = `<h2>New on NSE</h2><p class="muted" style="margin:.1rem 0 .5rem">Listed in the last 45 days or listing this week, from NSE's list of all ${esc(String(r.total))} equities. These stocks are not in the sector lists until NSE Indices adds them.</p>
      <div class="scroll"><table class="tbl"><thead><tr><th>Stock</th><th>Company</th><th>Listing</th><th class="num">Price</th><th class="num">Change</th></tr></thead><tbody>${shown.map((x) => `<tr><td><a href="#/quote/${encodeURIComponent(x.symbol)}">${esc(x.symbol)}</a>${x.series && x.series !== 'EQ' ? ` <span class="muted">${esc(x.series)}</span>` : ''}</td><td>${esc(x.company)}</td><td>${esc(fmtDate(x.listed))} · <span class="muted">${esc(when(x.listed, today))}</span></td><td class="num" data-nl-px="${esc(x.symbol)}">${x.upcoming ? '—' : ''}</td><td class="num" data-nl-chg="${esc(x.symbol)}">${x.upcoming ? '—' : ''}</td></tr>`).join('')}</tbody></table></div>`;
    const syms = shown.filter((x) => !x.upcoming).map((x) => x.symbol), paint = (q) => {
      const px = $(`[data-nl-px="${q.sym}"]`, host), ch = $(`[data-nl-chg="${q.sym}"]`, host); if (!px || !(q.price > 0)) return;
      px.textContent = money(q.price); const c = q.chg; ch.textContent = c == null ? '—' : `${arrow(c)} ${Math.abs(c).toFixed(2)}%`; ch.className = `num ${c == null ? '' : cls(c)}`;
    };
    if (!syms.length) return;
    try { (await api(`/api/quotes?symbols=${encodeURIComponent(syms.join(','))}`, { quiet: true, retries: 0, timeoutMs: 20000 })).quotes.forEach((q) => { if (alive && q.status !== 'unavailable') paint(q); }); } catch (e) { /* prices arrive with the live feed instead */ }
    if (window.MLLive) { unwatch = window.MLLive.watch(syms); off = window.MLLive.onFeed((f) => { if (alive) (f.quotes || []).forEach((q) => { if (syms.includes(q.sym) && q.status !== 'unavailable') paint(q); }); }); }
  })();
  return () => { alive = false; off(); unwatch(); };
}
