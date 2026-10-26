/* Price chart with a range selector (lazy-loaded on the stock page). Daily closes only: NSE's servers have no intraday series, and say so.
 * Requests are cached for five minutes and obsolete ones are aborted; long ranges are drawn from at most ~600 points (min/max kept per bucket, so no
 * spike is lost); the crosshair works with mouse, touch and the arrow keys; the whole chart has a text summary for screen readers. No library: one SVG. */
import { $, $$, esc, money, signed, cls, api, fmtDate, icon, store } from './lib.js';
import { decimate, stats } from './pure.js';
import { tabs, bindTabs, skeletonBlock, alert, buttonClass } from './ui.js';

export const RANGES = [['1D', '1D'], ['1W', '1W'], ['1M', '1M'], ['3M', '3M'], ['6M', '6M'], ['1Y', '1Y'], ['5Y', '5Y'], ['10Y', '10Y']];
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(), inflight = new Map();

function getHistory(sym, range, signal) {
  const key = `${sym}|${range}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.data);
  if (inflight.has(key)) return inflight.get(key);
  const p = api(`/api/history/${encodeURIComponent(sym)}?range=${range}`, { quiet: true, retries: 1, timeoutMs: 45000, signal })
    .then((data) => { cache.set(key, { at: Date.now(), data }); return data; }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function mount(host, { sym, onRange = () => {} }) {
  let range = store.get('ml.range', '3M'), ctl = null, seq = 0, data = null, ro = null, active = -1;
  host.innerHTML = `<section class="card" aria-label="Price chart"><div class="flex flex-wrap items-center justify-between gap-2">${tabs(RANGES, range, { id: 'range-tabs', label: 'Chart range' })}<p id="chart-sum" class="m-0 text-sm text-muted-foreground"></p></div>
    <div id="chart-body" class="mt-3" style="min-height:200px"></div><p id="chart-note" class="m-0 mt-2 text-xs text-muted-foreground"></p></section>`;
  const body = $('#chart-body', host), note = $('#chart-note', host), sum = $('#chart-sum', host);

  async function load(r = range) {
    ctl?.abort(); ctl = new AbortController(); const mine = ++seq;
    body.innerHTML = `<div role="status" aria-label="Loading chart" class="grid gap-2">${skeletonBlock('280px')}</div>`; note.textContent = ''; sum.textContent = '';
    if (['5Y', '10Y'].includes(r)) note.textContent = 'Long ranges load several pieces of history from NSE the first time; later visits are instant.';
    try {
      const d = await getHistory(sym, r, ctl.signal);
      if (mine !== seq) return;
      data = d; draw();
    } catch (e) {
      if (e.name === 'AbortError' || mine !== seq) return;
      body.innerHTML = alert({ variant: 'destructive', title: 'Could not load the chart', text: e.message, actionLabel: 'Retry', actionId: 'chart-retry' });
      $('#chart-retry', host)?.addEventListener('click', () => load());
    }
  }

  function draw() {
    if (!data) return;
    if (!data.available) {
      body.innerHTML = `<div class="grid justify-items-center gap-3 rounded-lg border border-dashed border-border p-8 text-center">${icon('chart-line', 28)}
        <p class="m-0 max-w-md text-sm text-muted-foreground">${esc(data.reason || 'No chart data for this range.')}</p>${data.range === '1D' ? `<button type="button" id="chart-1w" class="${buttonClass({ variant: 'outline' })}">Show 1 week instead</button>` : ''}</div>`;
      $('#chart-1w', host)?.addEventListener('click', () => $('[data-tab="1W"]', host)?.click());
      note.textContent = ''; sum.textContent = ''; return;
    }
    const pts = decimate(data.points), s = stats(data.points), up = s.last >= s.first, colour = up ? 'var(--up)' : 'var(--down)';
    const W = Math.max(240, body.clientWidth || 720), H = Math.round(Math.min(320, Math.max(200, innerHeight * 0.45))), padL = 8, padR = 52, padT = 10, padB = 24;
    const min = Math.min(...pts.map((p) => p[1])), max = Math.max(...pts.map((p) => p[1])), span = max - min || 1;
    const x = (i) => padL + (i / (pts.length - 1 || 1)) * (W - padL - padR), y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);
    const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = min + span * f; return `<line x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${W - padR + 6}" y="${(y(v) + 4).toFixed(1)}" class="ax">${money(v, v < 100 ? 2 : 0)}</text>`; }).join('');
    const xs = [0, Math.floor((pts.length - 1) / 2), pts.length - 1].map((i, k) => `<text x="${x(i).toFixed(1)}" y="${H - 6}" class="ax" text-anchor="${k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}">${esc(fmtDate(pts[i][0]))}</text>`).join('');
    const label = `${sym} daily close, ${data.range}: from ${money(s.first)} on ${fmtDate(data.from)} to ${money(s.last)} on ${fmtDate(data.to)}, ${signed(s.pct)} percent. High ${money(s.hi)}, low ${money(s.lo)}. Use the left and right arrow keys to read individual days.`;
    body.innerHTML = `<div class="relative"><svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" id="chart-svg" role="img" tabindex="0" aria-label="${esc(label)}" style="display:block;touch-action:pan-y">
      ${grid}${xs}<polygon fill="${colour}" opacity=".08" points="${x(0)},${H - padB} ${line} ${x(pts.length - 1)},${H - padB}"/>
      <polyline fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" points="${line}"/>
      <circle cx="${x(pts.length - 1)}" cy="${y(pts[pts.length - 1][1])}" r="3.5" fill="${colour}"/>
      <line id="xh" y1="${padT}" y2="${H - padB}" class="xh" style="display:none"/><circle id="dot" r="4.5" fill="${colour}" style="display:none"/></svg><div id="tip" class="chart-tip" role="status" style="display:none"></div></div>
      <p class="sr-only" aria-live="polite" id="chart-live"></p>`;
    sum.innerHTML = `<span class="${cls(s.pct)}">${signed(s.abs)} (${signed(s.pct)}%)</span> over ${esc(data.range)} · high ${money(s.hi)} · low ${money(s.lo)} · ${s.n} days`;
    note.textContent = data.note || '';
    const svg = $('#chart-svg', host), tip = $('#tip', host), xh = $('#xh', host), dot = $('#dot', host), live = $('#chart-live', host);
    const show = (i) => {
      active = i; const p = pts[i], first = pts[0][1], d = p[1] - first;
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.style.display = ''; dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p[1])); dot.style.display = '';
      const px = (x(i) / W) * svg.clientWidth;
      tip.style.display = ''; tip.style.left = `${Math.min(Math.max(px + 10, 4), svg.clientWidth - 150)}px`;
      tip.innerHTML = `<b>${money(p[1])}</b><br><span class="${cls(d)}">${signed(d)} (${signed((d / first) * 100)}%)</span> since start<br><span class="muted">${esc(fmtDate(p[0]))}</span>`;
      live.textContent = `${fmtDate(p[0])}: ${money(p[1])}`;
    };
    const idxAt = (clientX) => { const r = svg.getBoundingClientRect(), f = ((clientX - r.left) / r.width) * W; return Math.max(0, Math.min(pts.length - 1, Math.round(((f - padL) / (W - padL - padR)) * (pts.length - 1)))); };
    svg.addEventListener('pointermove', (e) => show(idxAt(e.clientX)));
    svg.addEventListener('pointerleave', () => { xh.style.display = dot.style.display = tip.style.display = 'none'; });
    svg.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 10 : 1, to = { ArrowLeft: (active < 0 ? pts.length - 1 : active) - step, ArrowRight: (active < 0 ? 0 : active) + step, Home: 0, End: pts.length - 1 }[e.key];
      if (to !== undefined) { e.preventDefault(); show(Math.max(0, Math.min(pts.length - 1, to))); }
      if (e.key === 'Escape') { xh.style.display = dot.style.display = tip.style.display = 'none'; active = -1; }
    });
  }

  bindTabs($('#range-tabs', host), (r) => { range = r; store.set('ml.range', r); onRange(r); load(r); });
  ro = new ResizeObserver(() => { clearTimeout(ro.t); ro.t = setTimeout(draw, 120); }); ro.observe(body);
  load();
  return () => { ctl?.abort(); ro?.disconnect(); };
}

export { decimate, stats };
