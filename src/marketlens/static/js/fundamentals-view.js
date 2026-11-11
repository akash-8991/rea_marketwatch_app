/* Fundamentals page: screens and a scorecard built from the data NSE's feeds provide (dividend yield and consistency, 52-week range, 30-day move, traded value, sector valuation).
 * The rules are in fund-screens.js (unit-tested). What NSE does not publish (earnings, margins, debt, cash flow) is listed at the bottom instead of being faked. */
import { $, $$, esc, money, signed, store, cls, arrow } from './lib.js';
import { SCREENS, UNAVAILABLE, runScreen, scorecard, sectorValuation, pos52 } from './fund-screens.js';
import { stateBadge } from './desk-ui.js';

export function mount(root, { D }) {
  const S = { key: store.get('ml.fund.screen', 'scorecard') };
  const bench = (D.valuation || []).find((v) => /^nifty 50$/i.test(v.name)), ctx = { benchYield: bench && bench.divYield };
  const ready = () => D.stocks.some((s) => s.fund);
  root.innerHTML = `<div class="grid gap-3"><div><h1 class="m-0">Fundamentals</h1><p class="m-0 mt-1 text-sm text-muted-foreground">Screens and a scorecard from the dividend, price-range and valuation data NSE publishes. Open a stock's Analysis tab for its own detail.</p></div>
    <section class="card"><h2>Screen</h2><div class="desk-form"><label>Screen<select id="fu-key">${Object.entries(SCREENS).map(([k, s]) => `<option value="${k}" ${k === S.key ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label></div><div id="fu-info" class="note mt-2"></div>
      <div class="scroll mt-2"><table class="tbl"><caption class="sr-only">Screen results</caption><thead><tr><th class="num">#</th><th>Stock</th><th>Sector</th><th class="num">Price</th><th class="num">30d</th><th class="num">Yield</th><th class="num">52w pos.</th><th>Why it passes</th></tr></thead><tbody id="fu-body"></tbody></table></div></section>
    <section class="card"><h2>Sector valuation (index P/E, P/B, yield)</h2><div class="scroll"><table class="tbl"><thead><tr><th>Index</th><th class="num">P/E</th><th class="num">vs Nifty 50</th><th class="num">P/B</th><th class="num">Yield</th></tr></thead><tbody id="fu-sec"></tbody></table></div></section>
    <section class="card"><h2>What these feeds cannot support</h2><p class="note">NSE's tools publish prices, volumes, dividends, corporate actions and index valuation, but no financial statements. These classic strategies need them, so they are not offered rather than approximated:</p><ul class="m-0 mt-2" style="padding-left:1.2rem">${UNAVAILABLE.map(([n, why]) => `<li><b>${esc(n)}</b> <span class="note">: ${esc(why)}</span></li>`).join('')}</ul></section></div>`;
  function paint() {
    const sc = SCREENS[S.key]; $('#fu-info', root).innerHTML = `<b>${esc(sc.name)}.</b> ${esc(sc.idea)} <span class="muted">Basis: ${esc(sc.basis)}</span>${ready() ? '' : ' <span class="state wait">dividend data is still loading in the background</span>'}`;
    const rows = runScreen(S.key, D.stocks, ctx).slice(0, 60);
    $('#fu-body', root).innerHTML = rows.map((r, i) => { const s = r.stock, p = pos52(s), c = s.pct30; return `<tr><td class="num">${i + 1}</td><td><a href="#/quote/${encodeURIComponent(s.sym)}">${esc(s.sym)}</a></td><td class="note">${esc(s.sector || '')}</td><td class="num" data-px="${esc(s.sym)}">${money(s.price)}</td><td class="num ${c == null ? '' : cls(c)}">${c == null ? '—' : `${arrow(c)} ${Math.abs(c).toFixed(1)}%`}</td><td class="num">${s.div != null ? `${s.div.toFixed(2)}%` : '—'}</td><td class="num">${p == null ? '—' : `${p.toFixed(0)}%`}</td><td class="note">${esc(r.why)}</td></tr>`; }).join('') || `<tr><td colspan="8" class="muted">${ready() ? 'No stock passes this screen right now.' : 'Waiting for dividend data…'}</td></tr>`;
    $('#fu-sec', root).innerHTML = sectorValuation(D.valuation || []).slice(0, 40).map((v) => `<tr><td>${esc(v.name)}</td><td class="num">${v.pe.toFixed(1)}</td><td class="num ${v.peVsBench == null ? '' : v.peVsBench > 0 ? 'down' : 'up'}">${v.peVsBench == null ? '—' : `${v.peVsBench > 0 ? '+' : '−'}${Math.abs(v.peVsBench).toFixed(0)}%`}</td><td class="num">${v.pb.toFixed(2)}</td><td class="num">${v.yield != null ? `${v.yield.toFixed(2)}%` : '—'}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Index valuation is not loaded yet.</td></tr>';
  }
  $('#fu-key', root).addEventListener('change', (e) => { S.key = e.target.value; store.set('ml.fund.screen', S.key); paint(); });
  paint(); const t = setInterval(() => { if (!document.body.contains(root)) clearInterval(t); else if (!ready()) paint(); }, 4000);
  return () => clearInterval(t);
}
