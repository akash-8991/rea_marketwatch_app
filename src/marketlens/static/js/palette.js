/* Command palette (the shadcn/ui "Command" pattern: a modal combobox with a listbox of results), loaded on first use.
 * Search is debounced, obsolete requests are aborted, results are cached for ten minutes, recent searches are remembered per user, matches are highlighted,
 * and everything works from the keyboard (↑ ↓ Home End Enter Esc). Ctrl/Cmd+K or "/" opens it from anywhere. */
import { esc, store, api, money, signed, cls, icon } from './lib.js';
import { highlight } from './pure.js';

const CACHE_MS = 10 * 60 * 1000, DEBOUNCE_MS = 150, MAX_RECENT = 8;
const cache = new Map();                                   // normalised query -> {at, data}
let dlg = null, input = null, list = null, state = { items: [], active: -1, seq: 0, ctl: null, timer: 0 };

const norm = (q) => q.trim().toLowerCase();
const recents = () => store.get('ml.recent', []);
const remember = (sym) => store.set('ml.recent', [sym, ...recents().filter((x) => x !== sym)].slice(0, MAX_RECENT));

const ACTIONS = [
  ['go:#/', 'Home', 'layout-dashboard'], ['go:#/markets', 'Markets', 'chart-line'], ['go:#/screener', 'Screener', 'list-filter'], ['go:#/options', 'Option chain', 'layers'],
  ['go:#/watchlist', 'Watchlist', 'star'], ['go:#/chart', 'Chart analysis', 'chart-candlestick'], ['go:#/paper', 'Paper trading', 'flask-conical'], ['act:theme', 'Toggle light / dark', 'moon'],
];

function render(q) {
  const items = [];
  const row = (id, ic, main, sub, right, kind) => { items.push({ id, kind }); return `<li id="pal-${items.length - 1}" role="option" aria-selected="false" data-i="${items.length - 1}" class="pal-opt flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm">${icon(ic, 16)}<span class="min-w-0 flex-1"><span class="block truncate font-medium">${main}</span>${sub ? `<span class="block truncate text-xs text-muted-foreground">${sub}</span>` : ''}</span>${right || ''}</li>`; };
  let html = '';
  const group = (label, rows) => (rows.length ? `<li role="presentation" class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">${label}</li>${rows.join('')}` : '');
  if (!q.trim()) {
    const rec = recents().map((s) => row('sym:' + s, 'history', esc(s), '', '', 'sym'));
    html = group('Recent searches', rec) + group('Go to', ACTIONS.map(([id, label, ic]) => row(id, ic, esc(label), '', '', 'act')));
    if (!rec.length) html = `<li role="presentation" class="px-3 py-2 text-sm text-muted-foreground">Type a symbol (INFY) or a company name (Infosys).</li>` + html;
  } else {
    const data = (cache.get(norm(q)) || {}).data;
    if (!data) html = `<li role="presentation" class="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</li>`;
    else if (data.error) html = `<li role="presentation" class="px-3 py-6 text-center text-sm text-down">Search is unavailable right now (${esc(data.error)}). You can still open a symbol directly: press Enter.</li>` + (/^[A-Za-z0-9&_-]{1,24}$/.test(q.trim()) ? row('sym:' + q.trim().toUpperCase(), 'arrow-up', `Open ${esc(q.trim().toUpperCase())}`, '', '', 'sym') : '');
    else {
      const rows = data.results.map((r) => row('sym:' + r.symbol, 'building-2', highlight(r.symbol, q), r.name ? highlight(r.name, q) : '',
        r.last_close != null ? `<span class="text-right text-xs tabular-nums">${money(r.last_close)}${r.pct_change != null ? ` <span class="${cls(r.pct_change)}">${signed(r.pct_change)}%</span>` : ''}</span>` : '', 'sym'));
      html = group('Stocks', rows);
      if (!rows.length) html = `<li role="presentation" class="px-3 py-8 text-center text-sm text-muted-foreground">No stocks match “${esc(q.trim())}”.${/^[A-Za-z0-9&_-]{1,24}$/.test(q.trim()) ? ' Press Enter to try the symbol anyway.' : ''}</li>`
        + (/^[A-Za-z0-9&_-]{1,24}$/.test(q.trim()) ? row('sym:' + q.trim().toUpperCase(), 'arrow-up', `Open ${esc(q.trim().toUpperCase())}`, 'Try this exact symbol', '', 'sym') : '');
      if (data.note) html += `<li role="presentation" class="px-3 py-2 text-xs text-muted-foreground">${esc(data.note)}</li>`;
    }
  }
  state.items = items; list.innerHTML = html; setActive(items.length ? 0 : -1);
}

function setActive(i) {
  state.active = i;
  list.querySelectorAll('.pal-opt').forEach((el, k) => { const on = k === i; el.setAttribute('aria-selected', on); el.classList.toggle('bg-muted', on); });
  input.setAttribute('aria-activedescendant', i >= 0 ? `pal-${i}` : '');
  if (i >= 0) list.querySelector(`#pal-${i}`)?.scrollIntoView({ block: 'nearest' });
}

function choose(i) {
  const it = state.items[i]; if (!it) return;
  close();
  if (it.id.startsWith('sym:')) { const sym = it.id.slice(4); remember(sym); location.hash = `#/quote/${encodeURIComponent(sym)}`; }
  else if (it.id.startsWith('go:')) location.hash = it.id.slice(3);
  else if (it.id === 'act:theme') document.getElementById('theme')?.click();
}

function search(q) {
  clearTimeout(state.timer);
  if (!q.trim()) { render(q); return; }
  const key = norm(q), hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) { render(q); return; }       // cached: instant, no request
  render(q);                                                              // shows "Searching…" while we wait
  state.timer = setTimeout(async () => {
    state.ctl?.abort(); state.ctl = new AbortController();                // obsolete request cancelled
    const mine = ++state.seq;
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q.trim())}`, { quiet: true, retries: 0, timeoutMs: 8000, signal: state.ctl.signal });
      cache.set(key, { at: Date.now(), data }); if (cache.size > 100) cache.delete(cache.keys().next().value);
      if (mine === state.seq && input.value === q) render(q);
    } catch (e) {
      if (e.name === 'AbortError' || (e.message || '').includes('abort')) return;
      if (mine === state.seq) { cache.set(key, { at: Date.now() - CACHE_MS + 5000, data: { error: e.message } }); render(q); }
    }
  }, DEBOUNCE_MS);
}

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'pal rounded-xl border border-border bg-popover p-0 text-foreground shadow-2xl backdrop:bg-black/50';
  dlg.setAttribute('aria-label', 'Search stocks and navigate');
  dlg.innerHTML = `<div class="grid w-[min(36rem,94vw)]"><div class="flex items-center gap-2 border-b border-border px-3">${icon('search', 16)}
    <input id="pal-input" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search stocks by symbol or company…" class="h-12 w-full border-0 bg-transparent text-base outline-none" style="border:0;box-shadow:none"></div>
    <ul id="pal-list" role="listbox" aria-label="Results" class="m-0 max-h-[min(24rem,60vh)] list-none overflow-y-auto p-1"></ul>
    <p class="m-0 flex flex-wrap gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground"><span><kbd class="kbd-inline">↑</kbd> <kbd class="kbd-inline">↓</kbd> move</span><span><kbd class="kbd-inline">Enter</kbd> open</span><span><kbd class="kbd-inline">Esc</kbd> close</span></p></div>`;
  document.body.appendChild(dlg);
  input = dlg.querySelector('#pal-input'); list = dlg.querySelector('#pal-list');
  input.addEventListener('input', () => search(input.value));
  input.addEventListener('keydown', (e) => {
    const n = state.items.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) setActive((state.active + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) setActive((state.active - 1 + n) % n); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); } else if (e.key === 'End') { e.preventDefault(); setActive(n - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (state.active >= 0) choose(state.active); }
  });
  list.addEventListener('click', (e) => { const li = e.target.closest('.pal-opt'); if (li) choose(+li.dataset.i); });
  list.addEventListener('mousemove', (e) => { const li = e.target.closest('.pal-opt'); if (li && +li.dataset.i !== state.active) setActive(+li.dataset.i); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });            // click on the backdrop
  dlg.addEventListener('close', () => { state.ctl?.abort(); clearTimeout(state.timer); document.getElementById('q')?.blur(); });
}

export function open(prefill = '') {
  if (!dlg) build();
  if (dlg.open) return;
  dlg.showModal(); input.value = prefill; search(prefill); input.focus();
}
export function close() { if (dlg && dlg.open) dlg.close(); }
