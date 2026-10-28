/* Interactive watchlist dashboard (lazy-loaded). One batch request keeps every row fresh; rows are patched individually; sorting and filtering work on
 * data already in memory; auto-refresh pauses while the tab is hidden; adds and removes are optimistic with rollback. Prices come from NSE, which itself
 * updates about once a minute, so a short refresh interval re-reads the app's own cache (cheap) and never multiplies NSE traffic.
 * Pure helpers (compare, matches, summarize) are exported for tests. */
import { $, $$, esc, money, signed, cls, arrow, compact, api, icon, store, debounce } from './lib.js';
import { SORTS, FILTERS, INTERVALS, matches, compare, summarize, windowSlice, WINDOW_AT, ROW_H } from './pure.js';
import { badge, buttonClass, statusBadge, skeletonRows, alert, emptyCard, toast, confirmDialog, ago, cn } from './ui.js';


const VALID = /^[A-Za-z0-9&_-]{1,24}$/;
const LIMIT = 50;

export function mount(root, ctx) {
  const user = { ...{ sort: 'symbol', dir: 'asc', filter: 'all', auto: true, interval: 1, text: '' }, ...store.get('ml.dash', {}) };
  if (!user.v) { user.v = 2; user.interval = 1; }   // the old default was 15 s: everyone moves to the one-second refresh once
  const saveUser = () => store.set('ml.dash', user);
  const st = { rows: new Map(), loading: false, error: null, refreshedAt: null, timer: 0, tickId: 0, seq: 0, ctl: null, source: 'NSE', marketLabel: '' };
  const wl = () => store.get('ml.watchlist', []);
  let unwatch = () => {}, offFeed = () => {};
  const rewatch = () => { unwatch(); unwatch = window.MLLive ? window.MLLive.watch(wl()) : () => {}; };   // the live feed (live.js) asks for every watchlist symbol
  const setWl = (list) => { store.set('ml.watchlist', list); rewatch(); };

  /* ---------- data ---------- */
  const CHUNK = 10;   // small chunks so the first rows appear as soon as NSE answers for them, not after the slowest symbol
  async function fetchBatch(symbols, { fresh = false, quiet = true, onChunk = null } = {}) {
    const out = [];
    st.ctl?.abort(); st.ctl = new AbortController();
    const chunks = []; for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));
    await Promise.all(chunks.map(async (chunk) => {
      const r = await api(`/api/quotes?symbols=${encodeURIComponent(chunk.join(','))}${fresh ? '&fresh=1' : ''}`, { quiet, retries: 1, timeoutMs: 15000, signal: st.ctl.signal });
      out.push(...r.quotes); if (onChunk) onChunk(r.quotes);
    }));
    return out;
  }
  /** What was on screen last time, painted at once while the fresh numbers load (clearly marked as saved). */
  const SAVED_KEY = 'ml.dashq';
  const remember = () => store.set(SAVED_KEY, Object.fromEntries([...st.rows].filter(([, q]) => q.price != null && q.status !== 'unavailable').slice(0, 200).map(([k, q]) => [k, { sym: q.sym, name: q.name, price: q.price, prev: q.prev, abs: q.abs, chg: q.chg, volume: q.volume, ts: q.ts, exchange: 'NSE' }])));
  function loadSaved() { const saved = store.get(SAVED_KEY, {}); wl().forEach((sym) => { if (saved[sym] && !st.rows.has(sym)) st.rows.set(sym, { ...saved[sym], status: 'cached', reason: 'Saved from your last visit; refreshing now.' }); }); }

  async function refreshAll({ manual = false } = {}) {
    const list = wl(); if (!list.length) { paint(); return; }
    const mine = ++st.seq; st.loading = true; paintToolbar();
    if (manual) toast.info('Refreshing', `${list.length} symbol${list.length > 1 ? 's' : ''}`, { duration: 1800 });
    try {
      const quotes = await fetchBatch(list, { fresh: manual, quiet: true, onChunk: (qs) => { if (mine === st.seq) { qs.forEach((q) => st.rows.set(q.sym, q)); st.refreshedAt = Date.now(); paintTable(); } } });
      if (mine !== st.seq) return;
      quotes.forEach((q) => st.rows.set(q.sym, q)); remember();
      st.error = null; st.refreshedAt = Date.now();
      const bad = quotes.filter((q) => q.status === 'unavailable').length, stale = quotes.some((q) => q.status === 'stale');
      if (manual) { if (bad === quotes.length) toast.error('Refresh failed', 'No data came back for any symbol.'); else toast.success('Refreshed', bad ? `${bad} symbol${bad > 1 ? 's' : ''} unavailable` : 'All symbols up to date', { duration: 2200 }); }
      if (stale) toast.warn('Showing saved data', 'NSE could not be reached; stale rows are marked.', { dedupeMs: 60000 });
    } catch (e) {
      if (e.name === 'AbortError') return;
      st.error = e.message || 'request failed';
      if (manual || !st.rows.size) toast.error('Refresh failed', st.error);
      else toast.warn('Data source unavailable', 'Showing the last values; will retry.', { dedupeMs: 60000 });
    } finally { if (mine === st.seq) { st.loading = false; paint(); schedule(); } }
  }

  async function refreshOne(sym) {
    const btn = $(`[data-refresh="${CSS.escape(sym)}"]`, root); if (btn) btn.disabled = true;
    try { const [q] = await fetchBatch([sym], { fresh: true }); st.rows.set(sym, q); st.refreshedAt = Date.now(); toast.success(`${sym} refreshed`, q.status === 'unavailable' ? q.reason : '', { duration: 1800 }); }
    catch (e) { if (e.name !== 'AbortError') toast.error(`Could not refresh ${sym}`, e.message); }
    paintRow(sym); paintToolbar();
  }

  /* ---------- watchlist edits: optimistic, with rollback ---------- */
  async function addSymbol(raw) {
    const sym = String(raw || '').trim().toUpperCase();
    if (!VALID.test(sym)) { toast.error('Invalid symbol', 'Use an NSE symbol such as INFY or M&M.'); return false; }
    if (wl().includes(sym)) { toast.info(`${sym} is already in your watchlist`); return false; }
    const before = wl(); setWl([...before, sym]);
    st.rows.set(sym, { sym, status: 'cached', loading: true, exchange: 'NSE' }); paint();
    try {
      const [q] = await fetchBatch([sym]);
      if (q.status === 'unavailable' && /not a valid|no quote/i.test(q.reason || '')) throw new Error(q.reason || 'no quote for this symbol');
      st.rows.set(sym, q); toast.success(`${sym} added`, q.name || ''); paint(); return true;
    } catch (e) {
      setWl(before); st.rows.delete(sym); paint();                          // rollback
      toast.error('Could not add ' + sym, e.message); return false;
    }
  }
  function removeSymbol(sym) {
    const before = wl(), row = st.rows.get(sym); setWl(before.filter((x) => x !== sym)); st.rows.delete(sym); paint();
    toast({ title: `${sym} removed`, actionLabel: 'Undo', onAction: () => { setWl(before); if (row) st.rows.set(sym, row); paint(); refreshAll(); }, duration: 6000 });
  }

  /* ---------- auto refresh: only while visible ---------- */
  function schedule() {
    clearTimeout(st.timer);
    if (!user.auto || document.hidden || !document.body.contains(root) || !wl().length) return;
    st.timer = setTimeout(() => refreshAll(), user.interval * 1000);
  }
  const onVisibility = () => { if (document.hidden) clearTimeout(st.timer); else if (document.body.contains(root)) refreshAll(); };
  document.addEventListener('visibilitychange', onVisibility);
  const ticker = setInterval(() => { if (!document.body.contains(root)) { cleanup(); } else paintStamp(); }, 1000);
  /* the live feed (100 ms) updates the rows in place; only a row whose numbers changed is repainted */
  rewatch();
  offFeed = window.MLLive ? window.MLLive.onFeed((f) => {
    for (const q of f.quotes || []) {
      const r = st.rows.get(q.sym); if (!r || r.loading || !(q.price > 0) || q.status === 'unavailable') continue;
      if (r.price === q.price && r.volume === q.volume && r.ts === q.ts) continue;
      Object.assign(r, { price: q.price, prev: q.prev ?? r.prev, abs: q.abs ?? r.abs, chg: q.chg ?? r.chg, volume: q.volume ?? r.volume, ts: q.ts ?? r.ts, ageMs: q.ageMs ?? r.ageMs, status: q.status || r.status });
      st.refreshedAt = Date.now(); paintRow(q.sym);
    }
  }) : () => {};
  function cleanup() { unwatch(); offFeed(); clearTimeout(st.timer); clearInterval(ticker); st.ctl?.abort(); document.removeEventListener('visibilitychange', onVisibility); }

  /* ---------- rendering ---------- */
  const visibleRows = () => wl().map((s) => st.rows.get(s)).filter(Boolean).filter((r) => matches(r, user.filter)
    && (!user.text || r.sym.toLowerCase().includes(user.text.toLowerCase()) || (r.name || '').toLowerCase().includes(user.text.toLowerCase()))).sort(compare(user.sort, user.dir));

  const rowHtml = (r) => {
    const un = r.status === 'unavailable', c = r.chg;
    const sign = c == null ? '' : c > 0 ? 'up' : c < 0 ? 'down' : 'flat';
    const arrowIc = c == null ? '' : c > 0 ? icon('trending-up', 14) : c < 0 ? icon('trending-down', 14) : icon('minus', 14);
    return `<tr data-sym="${esc(r.sym)}" class="${r.loading ? 'opacity-60' : ''}">
      <th scope="row" class="sym-cell"><a href="#/quote/${encodeURIComponent(r.sym)}" class="font-semibold">${esc(r.sym)}</a><span class="co muted" title="${esc(r.name || '')}">${esc(r.name || (r.loading ? 'Loading…' : ''))}</span></th>
      <td class="num">${un || r.price == null ? '—' : money(r.price)}</td>
      <td class="num ${sign === 'flat' ? 'flat' : sign}">${un || r.abs == null ? '—' : signed(r.abs)}</td>
      <td class="num ${sign === 'flat' ? 'flat' : sign}"><span class="inline-flex items-center gap-1">${arrowIc}${un || c == null ? '—' : `${signed(c)}%`}</span></td>
      <td class="num">${r.volume == null ? '—' : compact(r.volume)}</td>
      <td class="num" title="${esc(r.ts || '')}">${r.ts ? esc(r.ts.slice(11, 16)) : '—'}<span class="block text-xs text-muted-foreground">${r.ageMs != null ? ago(r.ageMs) : ''}</span></td>
      <td>${statusBadge(r.loading ? 'cached' : r.status, r.reason || '')}</td>
      <td class="num"><span class="inline-flex gap-1"><button type="button" data-refresh="${esc(r.sym)}" class="${buttonClass({ variant: 'ghost', size: 'icon' })}" aria-label="Refresh ${esc(r.sym)}">${icon('refresh-cw', 14)}</button>
        <button type="button" data-remove="${esc(r.sym)}" class="${buttonClass({ variant: 'ghost', size: 'icon' })}" aria-label="Remove ${esc(r.sym)} from watchlist">${icon('trash-2', 14)}</button></span></td></tr>`;
  };

  const sortHeader = (key, label, num = true) => {
    const on = user.sort === key;
    return `<th scope="col" class="${num ? 'num' : ''}" aria-sort="${on ? (user.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" data-sort="${key}" class="th-btn inline-flex items-center gap-1">${esc(label)}${on ? icon(user.dir === 'asc' ? 'arrow-up' : 'arrow-down', 12) : icon('arrow-up-down', 12)}</button></th>`;
  };

  function paintToolbar() {
    const t = $('#dash-tools', root); if (!t) return;
    const sum = summarize([...st.rows.values()]);
    t.innerHTML = `<div class="flex flex-wrap items-end gap-3">
      <form id="dash-add" class="flex items-end gap-2" autocomplete="off"><label class="grid gap-1 text-xs">Add symbol<input id="dash-add-in" list="dash-sugg" maxlength="24" placeholder="e.g. INFY" class="h-9 w-40 rounded-md border border-input bg-card px-3 text-sm" aria-label="Add a symbol to the watchlist"></label>
        <datalist id="dash-sugg"></datalist><button type="submit" class="${buttonClass()}">${icon('plus', 16)}Add</button></form>
      <label class="grid gap-1 text-xs">Filter<select id="dash-filter" class="h-9 rounded-md border border-input bg-card px-2 text-sm">${Object.entries(FILTERS).map(([k, l]) => `<option value="${k}" ${k === user.filter ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="grid gap-1 text-xs">Sort by<select id="dash-sort" class="h-9 rounded-md border border-input bg-card px-2 text-sm">${Object.entries(SORTS).map(([k, l]) => `<option value="${k}" ${k === user.sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <button type="button" id="dash-dir" class="${buttonClass({ variant: 'outline', size: 'icon' })}" aria-label="Sort ${user.dir === 'asc' ? 'ascending' : 'descending'}; activate to reverse">${icon(user.dir === 'asc' ? 'arrow-up' : 'arrow-down', 16)}</button>
      <label class="grid gap-1 text-xs">Search list<input id="dash-text" value="${esc(user.text)}" placeholder="symbol or name" class="h-9 w-40 rounded-md border border-input bg-card px-3 text-sm"></label>
      <div class="ml-auto flex flex-wrap items-end gap-3">
        <label class="inline-flex items-center gap-2 text-sm"><input id="dash-auto" type="checkbox" role="switch" ${user.auto ? 'checked' : ''}>Auto-refresh</label>
        <label class="grid gap-1 text-xs">Every<select id="dash-int" class="h-9 rounded-md border border-input bg-card px-2 text-sm" ${user.auto ? '' : 'disabled'}>${INTERVALS.map((s) => `<option value="${s}" ${s === user.interval ? 'selected' : ''}>${s} s</option>`).join('')}</select></label>
        <button type="button" id="dash-refresh" class="${buttonClass({ variant: 'outline' })}" ${st.loading ? 'disabled aria-busy="true"' : ''}>${icon('refresh-cw', 16, st.loading ? 'animate-spin' : '')}Refresh all</button>
      </div></div>
      <p class="m-0 mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"><span id="dash-stamp"></span><span>Source: ${esc(st.source)} (refreshed every second while the market trades, within a fixed budget of NSE requests)</span>
        ${st.marketLabel ? `<span>${esc(st.marketLabel)}</span>` : ''}<span>${sum.total} symbols · <span class="up">${sum.up} up</span> · <span class="down">${sum.down} down</span> · ${sum.flat} unchanged${sum.unavailable ? ` · ${sum.unavailable} unavailable` : ''}</span>${document.hidden ? '<span>Paused while this tab is hidden</span>' : ''}</p>`;
    paintStamp(); wireToolbar();
  }
  function paintStamp() { const el = $('#dash-stamp', root); if (el) el.textContent = st.refreshedAt ? `Last refreshed ${new Date(st.refreshedAt).toLocaleTimeString('en-IN')} (${ago(Date.now() - st.refreshedAt)})` : 'Not refreshed yet'; }

  function paintRow(sym) {
    const tr = $(`tr[data-sym="${CSS.escape(sym)}"]`, root), r = st.rows.get(sym);
    if (st.windowed) { drawWindow(); return; }
    if (tr && r && matches(r, user.filter)) { const tmp = document.createElement('tbody'); tmp.innerHTML = rowHtml(r); tr.replaceWith(tmp.firstElementChild); } else paintTable();
  }

  function paintTable() {
    const box = $('#dash-table', root); if (!box) return;
    const list = wl();
    if (!list.length) {
      const starters = (ctx.stocks || []).slice(0, 6).map((s) => `<button type="button" data-starter="${esc(s.sym)}" class="${buttonClass({ variant: 'outline', size: 'sm' })}">${icon('plus', 14)}${esc(s.sym)}</button>`).join('');
      box.innerHTML = emptyCard({ iconName: 'star', title: 'Your watchlist is empty', text: 'Add stocks to follow their price, change and data status in one place. Search with Ctrl K, or start with the most traded stocks:',
        action: `<div class="flex flex-wrap justify-center gap-2">${starters}<button type="button" id="dash-open-search" class="${buttonClass()}">${icon('search', 16)}Search stocks</button></div>` });
      $$('[data-starter]', box).forEach((b) => b.addEventListener('click', () => addSymbol(b.dataset.starter)));
      $('#dash-open-search', box)?.addEventListener('click', () => import('./palette.js').then((m) => m.open()));
      return;
    }
    if (!st.rows.size && st.loading) { box.innerHTML = skeletonRows(Math.min(list.length, 8)); return; }
    if (st.error && !st.rows.size) { box.innerHTML = alert({ variant: 'destructive', title: 'Could not load quotes', text: st.error, actionLabel: 'Retry', actionId: 'dash-retry' }); $('#dash-retry', box)?.addEventListener('click', () => refreshAll({ manual: true })); return; }
    const rows = visibleRows(); st.windowed = rows.length > WINDOW_AT; st.shown = rows;
    box.innerHTML = rows.length ? `<div class="scroll ${st.windowed ? 'vwin' : ''}"><table class="tbl dash-table"><caption class="sr-only">Watchlist quotes</caption><thead><tr>${sortHeader('symbol', 'Symbol', false)}${sortHeader('price', 'Price')}${sortHeader('abs', 'Change ₹')}${sortHeader('chg', 'Change %')}
      <th scope="col" class="num">Volume</th>${sortHeader('ts', 'Updated')}<th scope="col">Status</th><th scope="col" class="num"><span class="sr-only">Actions</span></th></tr></thead><tbody>${st.windowed ? '' : rows.map(rowHtml).join('')}</tbody></table></div>`
      : emptyCard({ iconName: 'list-filter', title: 'No symbols match this filter', text: 'Change the filter or clear the search to see your whole watchlist.', action: `<button type="button" id="dash-clear" class="${buttonClass({ variant: 'outline' })}">Clear filters</button>` });
    $('#dash-clear', box)?.addEventListener('click', () => { user.filter = 'all'; user.text = ''; saveUser(); paint(); });
    if (st.windowed) { const sc = $('.vwin', box); sc.addEventListener('scroll', () => { if (!st.raf) st.raf = requestAnimationFrame(() => { st.raf = 0; drawWindow(); }); }); drawWindow(); }
  }
  function drawWindow() {
    const sc = $('.vwin', root); if (!sc || !st.shown) return;
    const [first, count, above, below] = windowSlice(st.shown.length, sc.scrollTop, sc.clientHeight || 600, ROW_H);
    const tb = sc.querySelector('tbody'), spacer = (h) => (h ? `<tr aria-hidden="true" style="height:${h}px"><td colspan="8" style="padding:0;border:0"></td></tr>` : '');
    tb.innerHTML = spacer(above) + st.shown.slice(first, first + count).map(rowHtml).join('') + spacer(below);
  }

  function paint() { paintToolbar(); paintTable(); }

  function wireToolbar() {
    const on = (sel, ev, fn) => $(sel, root)?.addEventListener(ev, fn);
    on('#dash-add', 'submit', async (e) => { e.preventDefault(); const inp = $('#dash-add-in', root); const ok = await addSymbol(inp.value); if (ok) { inp.value = ''; } $('#dash-add-in', root)?.focus(); });
    on('#dash-add-in', 'input', debounce(async (e) => {
      const q = e.target.value.trim(); if (q.length < 2) return;
      try { const r = await api(`/api/search?q=${encodeURIComponent(q)}`, { quiet: true, retries: 0 }); const dl = $('#dash-sugg', root); if (dl) dl.innerHTML = r.results.slice(0, 8).map((x) => `<option value="${esc(x.symbol)}">${esc(x.name || '')}</option>`).join(''); } catch (err) { /* suggestions are optional */ }
    }, 200));
    on('#dash-filter', 'change', (e) => { user.filter = e.target.value; saveUser(); paintTable(); });
    on('#dash-sort', 'change', (e) => { user.sort = e.target.value; saveUser(); paintTable(); });
    on('#dash-dir', 'click', () => { user.dir = user.dir === 'asc' ? 'desc' : 'asc'; saveUser(); paint(); });
    on('#dash-text', 'input', debounce((e) => { user.text = e.target.value; saveUser(); paintTable(); }, 120));
    on('#dash-auto', 'change', (e) => { user.auto = e.target.checked; saveUser(); paintToolbar(); schedule(); toast.info(user.auto ? `Auto-refresh every ${user.interval} s` : 'Auto-refresh off', '', { duration: 1800 }); });
    on('#dash-int', 'change', (e) => { user.interval = +e.target.value; saveUser(); schedule(); });
    on('#dash-refresh', 'click', () => refreshAll({ manual: true }));
  }

  root.innerHTML = `<div class="grid gap-3"><div><h1 class="m-0">Watchlist</h1></div><section class="card" aria-label="Watchlist controls"><div id="dash-tools"></div></section><section class="card" aria-live="off"><div id="dash-table"></div></section></div>`;
  root.addEventListener('click', (e) => {
    const sort = e.target.closest('[data-sort]'); if (sort) { const k = sort.dataset.sort; user.dir = user.sort === k && user.dir === 'asc' ? 'desc' : 'asc'; user.sort = k; saveUser(); paint(); return; }
    const rf = e.target.closest('[data-refresh]'); if (rf) { refreshOne(rf.dataset.refresh); return; }
    const rm = e.target.closest('[data-remove]'); if (rm) removeSymbol(rm.dataset.remove);
  });
  loadSaved();
  paint();
  if (wl().length) { st.loading = true; refreshAll(); } else paintToolbar();
  return cleanup;
}

export { SORTS, FILTERS, INTERVALS, matches, compare, summarize, windowSlice };
