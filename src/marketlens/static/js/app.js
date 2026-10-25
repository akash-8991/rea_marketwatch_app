/* MarketLens app (ES module): hash-routed single page. Data: NSE via the local server. See data.js, lib.js, screener.js. */
import { startVitals, $, $$, esc, money, signed, cls, arrow, chgPct, pos52, idxChange, fmtDate, symLink, secTag, store, api, conn, onConn, badge, toneKind, sparkline, skeleton, emptyState, errorState, safeUrl, icon } from './lib.js';

const D = window.MLData;
const { stocks, bySym } = D;
startVitals();

  /* ---------- live paint (refresh every 60 s from the local server) ---------- */
  function paintBanner() {
    const el = $('#banner'); if (!el) return;
    const fetched = D.fetchedAt ? new Date(D.fetchedAt) : null, ageMin = fetched ? (Date.now() - fetched.getTime()) / 60000 : null;
    const asOf = D.asOf ? fmtDate(D.asOf) : '—', at = fetched ? fetched.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
    let state = 'live', msg;
    if (conn.state === 'offline') { state = 'off'; msg = `Disconnected: ${conn.lastError || 'cannot reach the local server'}. Showing the last data received; retrying.`; }
    else if (D.stale) { state = 'stale'; msg = `Saved NSE snapshot (last session ${asOf}). The live feed is unavailable${D.retryIn ? `; next live attempt in about ${Math.ceil(D.retryIn / 60)} min` : ''}.`; }
    else if (ageMin != null && ageMin > 10) { state = 'delayed'; msg = `Delayed: data was fetched ${Math.round(ageMin)} min ago (NSE session ${asOf}).`; }
    else msg = `Live · NSE session ${asOf} · fetched ${at}.`;
    if (conn.updating && state !== 'off') msg += ' Updating…';
    el.className = `banner ${state}`;
    el.innerHTML = `<span class="dot ${state}" aria-hidden="true"></span><span><span class="state-name">${{ live: 'Live', stale: 'Stale', delayed: 'Delayed', off: 'Disconnected' }[state]}</span> ${esc(msg)} <span class="muted">Informational only, not investment advice.</span></span>`;
  }
  function paintLive() {
    $$('[data-px]').forEach((el) => { const s = bySym[el.dataset.px]; if (s) el.textContent = money(s.price); });
    $$('[data-chg]').forEach((el) => {
      const s = bySym[el.dataset.chg]; if (!s) return;
      const c = chgPct(s);
      el.textContent = `${arrow(c)} ${Math.abs(c).toFixed(2)}%`;
      el.className = `${el.dataset.base || ''} ${cls(c)}`.trim();
    });
    $$('[data-idx]').forEach((el) => { const ix = D.indices.find((i) => i.id === el.dataset.idx); if (ix) el.textContent = money(ix.last); });
    $$('[data-idxchg]').forEach((el) => {
      const ix = D.indices.find((i) => i.id === el.dataset.idxchg); if (!ix) return;
      const c = idxChange(ix);
      el.textContent = `${arrow(c)} ${money(Math.abs(ix.last - ix.prev))} (${Math.abs(c).toFixed(2)}%)`;
      el.className = cls(c);
    });
    paintBanner();
  }

  /* ---------- small components ---------- */
  function ticker() {
    return `<div class="ticker">${D.indices.map((ix) => `
      <a class="tick" href="#/markets"><span class="tname">${esc(ix.name)}</span>
        <span class="tval" data-idx="${ix.id}">${money(ix.last)}</span><span data-idxchg="${ix.id}"></span></a>`).join('')}</div>`;
  }
  function stockRows(list) {
    return list.map((s) => `<tr><td>${symLink(s)}${secTag(s)}</td>
      <td class="num" data-px="${s.sym}">${money(s.price)}</td><td class="num" data-chg="${s.sym}"></td></tr>`).join('');
  }
  const bySort = (f) => [...stocks].sort(f);

  /* ---------- market updates: generated from the NSE figures (not editorial news) ---------- */
  function buildUpdates() {
    const items = [], pct = (n) => `${Math.abs(n).toFixed(2)}%`;
    const asOf = D.asOf ? fmtDate(D.asOf) : 'the last session';
    const ix = D.indices[0];
    const add = (cat, title, sum, body, related = []) => items.push({ id: items.length + 1, cat, title, sum, body, related });
    if (ix) {
      const c = idxChange(ix);
      const others = D.indices.slice(1).map((i) => `${i.name} ${idxChange(i) >= 0 ? 'rose' : 'fell'} ${pct(idxChange(i))} to ${money(i.last)}`).join('; ');
      add('markets', `${ix.name} ${c >= 0 ? 'gains' : 'slips'} ${pct(c)} to ${money(ix.last)} in the ${asOf} session`,
        `Previous close ${money(ix.prev)}; change ${signed(ix.last - ix.prev)} points.`,
        [`${ix.name} closed at ${money(ix.last)}, ${c >= 0 ? 'up' : 'down'} ${pct(c)} (${signed(ix.last - ix.prev)} points) from ${money(ix.prev)}.`, others ? `Other benchmarks: ${others}.` : '']);
    }
    const b = D.breadth;
    if (b && b.total_stocks) {
      add('markets', `${b.advances.toLocaleString('en-IN')} advances vs ${b.declines.toLocaleString('en-IN')} declines on the exchange`,
        `Across ${b.total_stocks.toLocaleString('en-IN')} stocks; advance/decline ratio ${b.ad_ratio}.`,
        [`Of ${b.total_stocks.toLocaleString('en-IN')} stocks traded, ${b.advances.toLocaleString('en-IN')} advanced, ${b.declines.toLocaleString('en-IN')} declined and ${b.unchanged} were unchanged.`,
          `Total traded volume was ${(b.total_volume / 1e7).toFixed(1)} crore shares.`]);
    }
    const vix = D.mood && D.mood.india_vix;
    if (vix) {
      add('trends', `India VIX at ${vix.level}, ${vix.change_1d_pct >= 0 ? 'up' : 'down'} ${pct(vix.change_1d_pct)} on the day`,
        'The volatility index measures expected near-term market swings.',
        [`India VIX closed at ${vix.level} (${signed(vix.change_1d_pct)}% on the day).`, vix.vs_1w_ago ? `Versus a week earlier (${vix.vs_1w_ago.base_date}, ${vix.vs_1w_ago.base_level}) it moved ${signed(vix.vs_1w_ago.change_pct)}%.` : '']);
    }
    const g = bySort((a, b2) => chgPct(b2) - chgPct(a));
    if (g.length) {
      add('stocks', `Top gainers among the most-traded stocks: ${g.slice(0, 3).map((s) => s.sym).join(', ')}`, `${g[0].sym} led with ${signed(chgPct(g[0]))}%.`,
        g.slice(0, 5).map((s) => `${s.sym}: ${money(s.price)} (${signed(chgPct(s))}%), turnover ₹${money(s.valueCr, 0)} cr.`), g.slice(0, 5).map((s) => s.sym));
      const l = g.slice(-5).reverse();
      add('stocks', `Top losers among the most-traded stocks: ${l.slice(0, 3).map((s) => s.sym).join(', ')}`, `${l[0].sym} fell ${pct(chgPct(l[0]))}.`,
        l.map((s) => `${s.sym}: ${money(s.price)} (${signed(chgPct(s))}%), turnover ₹${money(s.valueCr, 0)} cr.`), l.map((s) => s.sym));
      const a = bySort((x, y) => y.valueCr - x.valueCr).slice(0, 5);
      add('stocks', `Most active by turnover: ${a.slice(0, 3).map((s) => s.sym).join(', ')}`, `${a[0].sym} traded ₹${money(a[0].valueCr, 0)} crore.`,
        a.map((s) => `${s.sym}: ₹${money(s.valueCr, 0)} cr turnover, volume ${s.volume.toLocaleString('en-IN')}.`), a.map((s) => s.sym));
      const nearHi = stocks.filter((s) => pos52(s) != null && pos52(s) >= 90), nearLo = stocks.filter((s) => pos52(s) != null && pos52(s) <= 10);
      add('trends', `${nearHi.length} stocks near 52-week highs, ${nearLo.length} near lows (of ${stocks.length} most traded)`,
        '“Near” means within the top or bottom 10% of the 52-week range.',
        [nearHi.length ? `Near highs: ${nearHi.map((s) => s.sym).join(', ')}.` : 'None near 52-week highs.', nearLo.length ? `Near lows: ${nearLo.map((s) => s.sym).join(', ')}.` : 'None near 52-week lows.'], [...nearHi, ...nearLo].map((s) => s.sym));
    }
    if (D.sectorIdx.length) {
      const sec = [...D.sectorIdx].sort((a, b2) => b2.pct - a.pct);
      add('markets', `Sector indices: ${sec[0].sector} strongest (${signed(sec[0].pct)}%), ${sec[sec.length - 1].sector} weakest (${signed(sec[sec.length - 1].pct)}%)`,
        'Based on NSE sector index changes for the session.', sec.map((s) => `${s.index}: ${signed(s.pct)}%.`));
    }
    if (ix && ix.pe) {
      add('economy', `${ix.name} valuation: P/E ${ix.pe}, P/B ${ix.pb}, dividend yield ${ix.divYield}%`, 'Index-level valuation published by NSE.',
        D.valuation.slice(0, 6).map((v) => `${v.name}: P/E ${v.pe}, P/B ${v.pb}, dividend yield ${v.divYield}%.`));
    }
    return items;
  }
  let updates = buildUpdates();

  /* ---------- views ---------- */
  const views = {};

  views.home = () => {
    const sorted = bySort((a, b) => chgPct(b) - chgPct(a));
    const lead = updates[0];
    return {
      html: `${ticker()}
      <div class="grid3">
        <section class="card lead">
          ${lead ? `<p class="muted">Market wrap · generated from NSE data</p><h1><a href="#/updates/${lead.id}">${esc(lead.title)}</a></h1><p>${esc(lead.sum)}</p>` : ''}
          <ul class="list">${updates.slice(1, 5).map((n) => `<li><a href="#/updates/${n.id}">${esc(n.title)}</a></li>`).join('')}</ul>
        </section>
        <section class="card"><h2>In focus</h2>
          <ul class="list">${updates.slice(5, 9).map((n) => `<li><a href="#/updates/${n.id}">${esc(n.title)}</a></li>`).join('') || '<li class="muted">No further updates.</li>'}</ul>
          <a class="more" href="#/updates">All updates »</a></section>
        <aside class="card"><h2>Sector indices</h2>
          <div class="heat">${D.sectorIdx.map((s) => `<div class="tile ${cls(s.pct)}-bg" title="${esc(s.index)}"><b>${esc(s.sector)}</b><span>${signed(s.pct)}%</span></div>`).join('') || '<p class="muted">Unavailable.</p>'}</div>
        </aside>
      </div>
      <div class="grid2">
        <section class="card"><h2>Today's action <span class="muted">· ${stocks.length} most-traded stocks</span></h2>
          <div class="tabs" data-tabs><button class="on" data-t="g">Top gainers</button><button data-t="l">Top losers</button></div>
          <table class="tbl" data-pane="g"><thead><tr><th>Stock</th><th class="num">Price</th><th class="num">Change</th></tr></thead><tbody>${stockRows(sorted.slice(0, 6))}</tbody></table>
          <table class="tbl hide" data-pane="l"><thead><tr><th>Stock</th><th class="num">Price</th><th class="num">Change</th></tr></thead><tbody>${stockRows(sorted.slice(-6).reverse())}</tbody></table>
          <a class="more" href="#/markets">More statistics »</a></section>
        <section class="card"><h2>Most active</h2>
          <table class="tbl"><thead><tr><th>Stock</th><th class="num">Price</th><th class="num">Change</th><th>1M</th></tr></thead>
          <tbody>${bySort((a, b) => b.valueCr - a.valueCr).slice(0, 6).map((s) => `<tr><td>${symLink(s)}</td><td class="num" data-px="${s.sym}"></td><td class="num" data-chg="${s.sym}"></td><td>${sparkline(s.spark)}</td></tr>`).join('')}</tbody></table>
          ${D.extrasReady ? '' : '<p class="muted">1-month sparklines load in the background.</p>'}</section>
      </div>`,
      after() { wireTabs(); },
    };
  };

  views.markets = () => {
    const sort = store.get('ml.mktsort', 'chg');
    const cmp = { chg: (a, b) => chgPct(b) - chgPct(a), p30: (a, b) => (b.pct30 ?? -1e9) - (a.pct30 ?? -1e9), val: (a, b) => b.valueCr - a.valueCr, pos: (a, b) => (pos52(b) ?? -1) - (pos52(a) ?? -1), div: (a, b) => (b.div ?? -1) - (a.div ?? -1) }[sort];
    const br = D.breadth || {};
    const hi = bySort((a, b) => (pos52(b) ?? -1) - (pos52(a) ?? -1)).slice(0, 5), lo = bySort((a, b) => (pos52(a) ?? 101) - (pos52(b) ?? 101)).slice(0, 5);
    return {
      html: `${ticker()}<h1>Market statistics</h1>
      <p class="muted">${br.total_stocks ? `Whole exchange, ${fmtDate(br.date)}: ${br.advances.toLocaleString('en-IN')} advances · ${br.declines.toLocaleString('en-IN')} declines · ${br.unchanged} unchanged (${br.total_stocks.toLocaleString('en-IN')} stocks).` : 'Breadth unavailable.'}</p>
      <section class="card"><h2>Index valuation (NSE)</h2>
        <div class="scroll"><table class="tbl"><thead><tr><th>Index</th><th class="num">Close</th><th class="num">P/E</th><th class="num">P/B</th><th class="num">Div yield %</th></tr></thead><tbody>
        ${D.valuation.slice(0, 12).map((v) => `<tr><td>${esc(v.name)}</td><td class="num">${money(v.last)}</td><td class="num">${v.pe ?? '—'}</td><td class="num">${v.pb ?? '—'}</td><td class="num">${v.divYield ?? '—'}</td></tr>`).join('')}</tbody></table></div></section>
      <div class="grid2">
        <section class="card"><h2>Closest to 52-week high</h2><table class="tbl"><tbody>${hi.map((s) => `<tr><td>${symLink(s)}</td><td class="num">${money(s.hi52)}</td><td class="num">${pos52(s)?.toFixed(0)}%</td></tr>`).join('')}</tbody></table></section>
        <section class="card"><h2>Closest to 52-week low</h2><table class="tbl"><tbody>${lo.map((s) => `<tr><td>${symLink(s)}</td><td class="num">${money(s.lo52)}</td><td class="num">${pos52(s)?.toFixed(0)}%</td></tr>`).join('')}</tbody></table></section>
      </div>
      <section class="card"><h2>${stocks.length} most-traded stocks</h2>
        <div class="toolbar"><label>Sort by <select id="mkt-sort">${[['chg', '% change'], ['p30', '30-day %'], ['val', 'Turnover'], ['pos', '52-week position'], ['div', 'Dividend yield']].map(([v, l]) => `<option value="${v}" ${v === sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label>Sector <select id="mkt-sec"><option value="">All</option>${D.sectors.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label></div>
        <div class="scroll"><table class="tbl" id="mkt-table"><thead><tr><th>Stock</th><th class="num">Price</th><th class="num">Change</th><th class="num">30d %</th><th class="num">52w pos</th><th class="num">Turnover ₹cr</th><th class="num">Div %</th></tr></thead>
        <tbody>${[...stocks].sort(cmp).map((s) => `<tr data-sector="${esc(s.sector)}"><td>${symLink(s)}${secTag(s)}</td><td class="num" data-px="${s.sym}"></td><td class="num" data-chg="${s.sym}"></td>
          <td class="num ${cls(s.pct30 ?? 0)}">${s.pct30 == null ? '—' : signed(s.pct30)}</td><td class="num">${pos52(s) == null ? '—' : pos52(s).toFixed(0) + '%'}</td>
          <td class="num">${money(s.valueCr, 0)}</td><td class="num">${s.div == null ? '—' : s.div}</td></tr>`).join('')}</tbody></table></div>
        <p class="muted">Sectors are a static classification maintained in this demo (NSE does not supply them); “Other” means unclassified. Dividend yield = trailing-12-month dividends ÷ price${D.extrasReady ? '' : ' (still loading)'}.</p>
      </section>`,
      after() {
        $('#mkt-sort').addEventListener('change', (e) => { store.set('ml.mktsort', e.target.value); route(); });
        $('#mkt-sec').addEventListener('change', (e) => $$('#mkt-table tbody tr').forEach((tr) => { tr.style.display = !e.target.value || tr.dataset.sector === e.target.value ? '' : 'none'; }));
      },
    };
  };

  /* ---------- live news (Yahoo Finance + Google News), India vs global ---------- */
  const timeAgo = (ts) => { if (!ts) return ''; const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60)); return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  function newsList(items) {
    return `<ul class="list big">${items.map((n) => `<li><a href="${esc(safeUrl(n.link))}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>
      <p class="muted">${esc(n.source)} · via ${n.provider === 'yahoo' ? 'Yahoo Finance' : 'Google News'}${n.ts ? ' · ' + timeAgo(n.ts) : ''} ${n.sentiment > 0.05 ? '<span class="up" title="positive wording">●</span>' : n.sentiment < -0.05 ? '<span class="down" title="negative wording">●</span>' : ''}</p></li>`).join('')}</ul>`;
  }
  function tone(items) {
    const s = items.map((n) => n.sentiment || 0), pos = s.filter((v) => v > 0.05).length, neg = s.filter((v) => v < -0.05).length;
    return items.length ? `Headline wording: ${pos} positive, ${neg} negative, ${items.length - pos - neg} neutral (keyword-based, approximate).` : '';
  }
  views.news = () => {
    const region = store.get('ml.newsregion', 'india');
    return {
      html: `<h1>Market news</h1><p class="muted">Live headlines from Yahoo Finance and Google News (the public feed behind Google Finance’s news). Headlines open the publisher’s site.</p>
        <div class="tabs" id="news-region">${[['india', 'India stocks'], ['global', 'Global stocks']].map(([k, l]) => `<button data-r="${k}" class="${k === region ? 'on' : ''}">${l}</button>`).join('')}</div>
        <section class="card" id="news-body"><p class="muted">Loading headlines…</p></section>`,
      after() {
        const load = (r) => {
          $('#news-body').innerHTML = '<p class="muted">Loading headlines…</p>';
          api(`/api/news/${r}`).then((d) => {
            if (location.hash !== '#/news') return;
            if (d.error) throw new Error(d.error);
            if (d.disabled) { $('#news-body').innerHTML = '<p>News is turned off (started with --no-news).</p>'; return; }
            $('#news-body').innerHTML = `<p class="muted">${esc(tone(d.items))} Fetched ${esc((d.fetchedAt || '').replace('T', ' '))}.${d.stale ? ' <span class="down">Saved copy: live feeds were unreachable.</span>' : ''}</p>${d.items.length ? newsList(d.items) : '<p>No headlines returned.</p>'}`;
          }).catch((e) => { $('#news-body').innerHTML = errorState('Could not load headlines', e.message, 'news-retry'); $('#news-retry')?.addEventListener('click', () => load(r)); });
        };
        $$('#news-region button').forEach((b) => b.addEventListener('click', () => { store.set('ml.newsregion', b.dataset.r); $$('#news-region button').forEach((x) => x.classList.toggle('on', x === b)); load(b.dataset.r); }));
        load(region);
      },
    };
  };

  /* ---------- option chain: saved snapshots (CSV you downloaded, or an official endpoint) ---------- */
  const ageText = (iso) => { if (!iso) return ''; const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
  let ocTimer = null;
  const durText = (s) => (s < 90 ? `${Math.round(s)} s` : `${+(s / 60).toFixed(1)} min`);
  views.options = () => {
    const sym = store.get('ml.ocsym', 'NIFTY');
    return {
      html: `<h1>Option chain</h1>
        <form id="oc-form" class="card pfform"><label>Underlying <select name="sym"><option>${esc(sym)}</option></select></label>
          <label>Expiry <select name="expiry"><option value="">Latest saved</option></select></label><button class="btn on" type="submit">Load</button><span id="oc-refresh" class="muted"></span></form>
        <section class="card"><h2>Import an NSE CSV</h2>
          <p class="muted">Download the CSV yourself from NSE’s option-chain page, then choose it here or drop it into the inbox folder <code id="oc-inbox">…</code>, which is checked every <span id="oc-int">…</span>. MarketLens never downloads anything from NSE’s website.</p>
          <form id="oc-upload" class="pfform"><label>CSV file <input type="file" name="file" accept=".csv,text/csv" required></label>
            <label>Symbol <input name="symbol" placeholder="from file name" maxlength="24"></label><label>Expiry <input name="expiry" placeholder="27-Oct-2026" maxlength="12"></label>
            <label>Spot (optional) <input name="spot" type="number" step="0.01" min="0"></label><button class="btn on" type="submit">Import</button><span id="oc-msg" class="muted" role="status"></span></form></section>
        <div id="oc-body"><p class="muted pad">Loading…</p></div>`,
      after() {
        const form = $('#oc-form'), msg = $('#oc-msg');
        const n = (v, dp = 0) => (v == null ? '—' : money(v, dp));
        const loadMeta = () => api('/api/options/meta').then((m) => {
          const s = m.scheduler || {};
          $('#oc-inbox').textContent = s.inbox || '';
          $('#oc-int').textContent = s.intervalSeconds ? durText(s.intervalSeconds) : 'never (disabled)';
          const have = [...new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', ...(m.symbols || [])])], cur = form.elements.sym.value || store.get('ml.ocsym', 'NIFTY');
          form.elements.sym.innerHTML = have.map((x) => `<option ${x === cur ? 'selected' : ''}>${esc(x)}</option>`).join('');
          $('#oc-refresh').textContent = s.lastRun ? `Last scan ${ageText(new Date(s.lastRun * 1000).toISOString())}; next in about ${durText(Math.max(0, (s.nextRun || 0) - Date.now() / 1000))}.` : '';
        }).catch(() => {});
        const loadChain = (quiet) => {
          const s = form.elements.sym.value || store.get('ml.ocsym', 'NIFTY'), e = form.elements.expiry.value;
          store.set('ml.ocsym', s);
          if (!quiet) $('#oc-body').innerHTML = '<p class="muted pad">Loading option chain…</p>';
          api(`/api/options?symbol=${encodeURIComponent(s)}&expiry=${encodeURIComponent(e)}`).then((d) => {
            if (!location.hash.startsWith('#/options')) return;
            if (d.error) throw new Error(d.error);
            if (!d.available) { $('#oc-body').innerHTML = `<section class="card"><h2>No option-chain data yet</h2><p>${esc(d.reason)}</p><p class="muted">No option data is shown unless it comes from a real source.</p></section>`; return; }
            const sel = form.elements.expiry;
            if (d.expiries.length) sel.innerHTML = '<option value="">Latest saved</option>' + d.expiries.map((x) => `<option ${x === (e || d.expiry) ? 'selected' : ''}>${esc(x)}</option>`).join('');
            const S = d.summary, maxOi = Math.max(1, ...d.rows.map((r) => Math.max(r.ce?.oi || 0, r.pe?.oi || 0)));
            const bar = (v, c) => `style="background:linear-gradient(to ${c === 'ce' ? 'left' : 'right'},var(--${c === 'ce' ? 'down' : 'up'}-bg) ${((v || 0) / maxOi) * 100}%,transparent 0)"`;
            const m = d.meta || {};
            $('#oc-body').innerHTML = `<p class="muted">${esc(d.symbol || s)} · expiry ${esc(d.expiry || '—')} · source: ${esc(m.source || d.tool || '—')}${m.filename ? ` (${esc(m.filename)})` : ''}${m.capturedAt ? ` · captured ${esc(ageText(m.capturedAt))}` : ''}${d.warning ? ` · <span class="down">${esc(d.warning)}</span>` : ''}</p>
              <div class="stats"><div class="stat"><span class="muted">Spot${d.spotEstimated ? ' (estimated from put-call parity)' : ''}</span><b>${n(d.spot, 2)}</b></div><div class="stat"><span class="muted">PCR (put/call OI)</span><b>${S.pcr ?? '—'}</b></div>
              <div class="stat"><span class="muted">Max pain</span><b>${n(S.maxPain)}</b></div><div class="stat"><span class="muted">Call OI · Put OI</span><b>${n(S.ceOi)} · ${n(S.peOi)}</b></div></div>
              <section class="card"><div class="scroll"><table class="tbl oc"><thead><tr><th colspan="5" class="num">CALLS</th><th class="num">Strike</th><th colspan="5">PUTS</th></tr>
              <tr><th class="num">OI</th><th class="num">Chg OI</th><th class="num">Vol</th><th class="num">IV</th><th class="num">LTP</th><th></th><th class="num">LTP</th><th class="num">IV</th><th class="num">Vol</th><th class="num">Chg OI</th><th class="num">OI</th></tr></thead><tbody>
              ${d.rows.map((r) => { const c = r.ce || {}, p = r.pe || {}; return `<tr class="${r.strike === S.atm ? 'atm' : ''}"><td class="num" ${bar(c.oi, 'ce')}>${n(c.oi)}</td><td class="num">${n(c.chgOi)}</td><td class="num">${n(c.vol)}</td><td class="num">${n(c.iv, 1)}</td><td class="num">${n(c.ltp, 2)}</td>
                <td class="num strike">${n(r.strike)}</td><td class="num">${n(p.ltp, 2)}</td><td class="num">${n(p.iv, 1)}</td><td class="num">${n(p.vol)}</td><td class="num">${n(p.chgOi)}</td><td class="num" ${bar(p.oi, 'pe')}>${n(p.oi)}</td></tr>`; }).join('')}</tbody></table></div></section>`;
          }).catch((err) => { $('#oc-body').innerHTML = `<section class="card"><p>Could not load the option chain.</p><p class="muted">${esc(err.message)}</p></section>`; });
        };
        form.addEventListener('submit', (ev) => { ev.preventDefault(); loadChain(); });
        form.elements.sym.addEventListener('change', () => { form.elements.expiry.innerHTML = '<option value="">Latest saved</option>'; loadChain(); });
        form.elements.expiry.addEventListener('change', () => loadChain());
        $('#oc-upload').addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const f = ev.target, file = f.elements.file.files[0];
          if (!file) return;
          if (file.size > 2000000) { msg.textContent = 'File is larger than 2 MB.'; return; }
          const q = new URLSearchParams({ filename: file.name });
          ['symbol', 'expiry', 'spot'].forEach((k) => { if (f.elements[k].value.trim()) q.set(k, f.elements[k].value.trim()); });
          msg.textContent = 'Importing…';
          const btn = f.querySelector('button[type=submit]'); btn.disabled = true;   // no double submission
          try {
            const d = await api(`/api/options/import?${q}`, { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-Requested-With': 'MarketLens' }, body: await file.text(), timeoutMs: 20000 });
            msg.textContent = d.status === 'duplicate' ? `Already imported (snapshot #${d.id}).` : `Imported as snapshot #${d.id}.`;
            f.reset(); loadMeta().then(() => loadChain(true));
          } catch (err) { msg.textContent = `Import failed: ${err.message}`; } finally { btn.disabled = false; }
        });
        clearInterval(ocTimer);
        ocTimer = setInterval(() => { if (location.hash.startsWith('#/options')) { loadMeta(); loadChain(true); } else { clearInterval(ocTimer); } }, 150000);
        loadMeta().then(() => loadChain());
      },
    };
  };

  views.updates = ([id]) => {
    if (id) {
      const n = updates.find((x) => x.id === +id);
      if (!n) return views.notfound();
      return { html: `<article class="card article"><p class="muted">${esc(n.cat)} · generated from NSE data, ${D.asOf ? fmtDate(D.asOf) : ''}</p><h1>${esc(n.title)}</h1>
        ${n.body.filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('')}
        ${n.related.length ? `<h3>Related stocks</h3><ul class="list">${n.related.filter((r) => bySym[r]).map((r) => `<li>${symLink(bySym[r])}</li>`).join('')}</ul>` : ''}
        <p class="muted">These items are produced automatically from NSE figures. They are not editorial news.</p><a class="more" href="#/updates">« All updates</a></article>` };
    }
    const cat = store.get('ml.newscat', 'all');
    const cats = ['all', ...new Set(updates.map((n) => n.cat))];
    return {
      html: `<h1>Market updates</h1><p class="muted">Generated from NSE data for the ${D.asOf ? fmtDate(D.asOf) : 'last'} session. NSE’s data feeds do not include news articles.</p>
        <div class="tabs" id="news-cats">${cats.map((c) => `<button data-c="${c}" class="${c === cat ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
        <section class="card"><ul class="list big">${updates.filter((n) => cat === 'all' || n.cat === cat).map((n) => `<li><a href="#/updates/${n.id}">${esc(n.title)}</a><p class="muted">${esc(n.sum)}</p></li>`).join('')}</ul></section>`,
      after() { $$('#news-cats button').forEach((b) => b.addEventListener('click', () => { store.set('ml.newscat', b.dataset.c); route(); })); },
    };
  };

  /* ----- quote page ----- */
  const detailCache = new Map();
  const loadDetail = (sym) => {
    if (!detailCache.has(sym)) {
      detailCache.set(sym, api(`/api/stock/${encodeURIComponent(sym)}`).catch((e) => { detailCache.delete(sym); throw e; }));
    }
    return detailCache.get(sym);
  };
  let quote = null, quoteRange = 'all';
  function rangeRows(h) {
    const n = quoteRange === 'w' ? 5 : quoteRange === 'm' ? 22 : h.length;
    return h.slice(-n);
  }
  function drawQuoteChart() {
    const host = $('#chart'); if (!host || !quote || !quote.history.length) return;
    const rows = rangeRows(quote.history), vals = rows.map((r) => r[4]);
    if (vals.length < 2) { host.innerHTML = '<p class="muted pad">Not enough history for this range.</p>'; return; }
    const W = host.clientWidth || 720, H = 300, pad = 8;
    const min = Math.min(...vals), max = Math.max(...vals), rng = max - min || 1;
    const x = (i) => pad + (i / (vals.length - 1)) * (W - pad * 2 - 44), y = (v) => pad + (1 - (v - min) / rng) * (H - pad * 2);
    const line = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const c = vals[vals.length - 1] >= vals[0] ? 'var(--up)' : 'var(--down)';
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = min + rng * f; return `<line x1="${pad}" x2="${W - 44}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${W - 40}" y="${y(v) + 4}" class="ax">${money(v, 0)}</text>`; }).join('');
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" id="chart-svg">${grid}<polygon fill="${c}" opacity=".08" points="${x(0)},${H - pad} ${line} ${x(vals.length - 1)},${H - pad}"/>
      <polyline fill="none" stroke="${c}" stroke-width="2" points="${line}"/><line id="xh" y1="${pad}" y2="${H - pad}" class="xh" style="display:none"/><circle id="dot" r="4" fill="${c}" style="display:none"/></svg><div id="tip" class="tip" style="display:none"></div>`;
    const svg = $('#chart-svg'), tip = $('#tip'), xh = $('#xh'), dot = $('#dot');
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(vals.length - 1, Math.round(((e.clientX - r.left - pad) / (r.width - pad * 2 - 44)) * (vals.length - 1))));
      xh.setAttribute('x1', x(i)); xh.setAttribute('x2', x(i)); xh.style.display = '';
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(vals[i])); dot.style.display = '';
      tip.style.display = ''; tip.style.left = `${Math.min(x(i) + 12, W - 170)}px`; tip.textContent = `${fmtDate(rows[i][0])} · ${money(vals[i])}`;
    });
    svg.addEventListener('mouseleave', () => { xh.style.display = dot.style.display = tip.style.display = 'none'; });
  }
  const smaN = (a, n) => (a.length >= n ? a.slice(-n).reduce((p, q) => p + q, 0) / n : null);
  function rsi(a, n = 14) {
    if (a.length <= n) return null;
    let g = 0, l = 0;
    for (let i = a.length - n; i < a.length; i++) { const d = a[i] - a[i - 1]; d >= 0 ? (g += d) : (l -= d); }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  views.quote = ([rawSym, tab]) => {
    const sym = decodeURIComponent(rawSym || '').toUpperCase();
    tab = tab || 'overview';
    return {
      html: `${ticker()}<div id="qwrap"><p class="muted pad">Loading ${esc(sym)} from NSE…</p></div>`,
      after() {
        loadDetail(sym).then((d) => {
          if (location.hash.split('/')[2] && decodeURIComponent(location.hash.split('/')[2]).toUpperCase() !== sym) return;
          quote = d; renderQuote(d, tab);
        }).catch((e) => {
          $('#qwrap').innerHTML = `<section class="card"><h1>${esc(sym)}</h1><p>Could not load this symbol from NSE right now.</p><p class="muted">${esc(e.message)}</p><a class="more" href="#/markets">« Markets</a></section>`;
        });
      },
    };
  };

  function loadStockNews(sym) {
    api(`/api/news/stock/${encodeURIComponent(sym)}`).then((d) => {
      const box = $('#qnews'); if (!box) return;
      if (d.error) throw new Error(d.error);
      if (d.disabled) { box.innerHTML = '<h2>News and sentiment</h2><p>News is turned off (started with --no-news).</p>'; return; }
      const s = d.sentiment || {};
      box.innerHTML = `<h2>News and sentiment</h2>${s.n ? `<p>${badge(s.label, '', toneKind(s.label))} <span class="muted">${s.n} headlines · ${s.pos} positive · ${s.neg} negative · keyword-based, approximate</span></p>` : '<p class="muted">No recent headlines found for this symbol.</p>'}${d.items.length ? newsList(d.items) : ''}
        <p class="muted">Matches are by symbol and can include unrelated stories.</p>`;
    }).catch((e) => { const box = $('#qnews'); if (box) box.innerHTML = `<h2>News and sentiment</h2><p>Could not load headlines right now.</p><p class="muted">${esc(e.message)}</p>`; });
  }

  function renderQuote(d, tab) {
    const q = d.quote, sym = d.sym, u = bySym[sym];
    const price = q.lastTradedPrice, c = q.perChange ?? (q.preClosePrice ? ((price - q.preClosePrice) / q.preClosePrice) * 100 : 0);
    const wl = store.get('ml.watchlist', []), inWl = wl.includes(sym);
    const h = d.history || [], closes = h.map((r) => r[4]);
    const r52 = d.range52 || {};
    const tabs = ['overview', 'analysis', 'news', 'actions'];
    const tabName = { overview: 'overview', analysis: 'analysis', news: 'news & sentiment', actions: 'corporate actions' };
    const yld = d.divTtm && price ? ((d.divTtm / price) * 100).toFixed(2) : null;
    let body = '';
    if (tab === 'overview') {
      const rows = [['Last price', money(price)], ['Previous close', money(q.preClosePrice)], ['Open', money(q.openPrice)], ['Day high', money(q.highPrice)], ['Day low', money(q.lowPrice)],
        ['Volume', q.volume?.toLocaleString('en-IN')], ['Turnover', q.value != null ? `₹${money(q.value, 0)} cr` : '—'], ['30-day change', q.perChange30d == null ? '—' : `${signed(q.perChange30d)}%`],
        ['52-week high', `${money(q.fiftyTwoWeekHigh)}${r52['52w_high_date'] ? ` (${fmtDate(r52['52w_high_date'])})` : ''}`], ['52-week low', `${money(q.fiftyTwoWeekLow)}${r52['52w_low_date'] ? ` (${fmtDate(r52['52w_low_date'])})` : ''}`],
        ['Position in 52w range', r52.position_in_range_pct != null ? `${r52.position_in_range_pct}%` : '—'], ['Dividends, last 12 months', d.divTtm ? `₹${money(d.divTtm)}${yld ? ` (${yld}% yield)` : ''}` : 'None found']];
      const peers = stocks.filter((p) => p.sector === (u && u.sector) && p.sym !== sym && p.sector !== 'Other').slice(0, 5);
      body = `<div class="grid2"><section class="card"><h2>Key statistics</h2><table class="tbl kv"><tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${v ?? '—'}</td></tr>`).join('')}</tbody></table>
        <p class="muted">NSE does not provide P/E, market cap or financial statements, so they are not shown.</p></section>
        <section class="card"><h2>${peers.length ? `Peers · ${esc(u.sector)}` : 'Peers'}</h2><table class="tbl"><tbody>${peers.map((p) => `<tr><td>${symLink(p)}</td><td class="num" data-px="${p.sym}"></td><td class="num" data-chg="${p.sym}"></td></tr>`).join('') || '<tr><td class="muted">No classified peers among the most-traded stocks.</td></tr>'}</tbody></table></section></div>`;
    } else if (tab === 'actions') {
      const acts = [...((d.actions && d.actions.actions) || [])].sort((a, b) => b.exDate.localeCompare(a.exDate));
      body = `<section class="card"><h2>Corporate actions (last 3 years)</h2>${acts.length ? `<table class="tbl"><thead><tr><th>Ex-date</th><th>Type</th><th>Details</th></tr></thead><tbody>
        ${acts.map((a) => `<tr><td>${fmtDate(a.exDate)}</td><td>${esc(a.actionType)}</td><td>${esc(a.purpose)}</td></tr>`).join('')}</tbody></table>` : '<p>No corporate actions found in this period.</p>'}</section>`;
    } else if (tab === 'news') {
      body = `<section class="card" id="qnews"><h2>News and sentiment</h2><p class="muted">Loading headlines for ${esc(sym)}…</p></section>`;
    } else {
      const A = d.analysis || {}, T = A.tech, F = A.fund;
      const sigRows = (arr) => (arr || []).map((g) => `<tr><td>${esc(g.name)}</td><td class="num ${g.value > 0 ? 'up' : g.value < 0 ? 'down' : ''}">${g.value > 0 ? 'Positive' : g.value < 0 ? 'Negative' : 'Neutral'}</td><td class="muted">${esc(g.note)}</td></tr>`).join('');
      body = `<div class="grid2"><section class="card"><h2>Technical analysis</h2>${T ? `<p>${badge(T.label, '', toneKind(T.label))} <span class="muted">score ${T.score} · ${esc(T.basis)}</span></p>
        <table class="tbl"><tbody>${sigRows(T.signals)}</tbody></table>
        <table class="tbl kv"><tbody><tr><td>RSI (14)</td><td class="num">${T.rsi ?? '—'}</td></tr><tr><td>SMA 20 / SMA 50</td><td class="num">${T.sma20 != null ? money(T.sma20) : '—'} / ${T.sma50 != null ? money(T.sma50) : '—'}</td></tr><tr><td>MACD histogram</td><td class="num">${T.macdHist ?? '—'}</td></tr></tbody></table>` : '<p class="muted">Not enough data.</p>'}
        <p class="muted">Rule-based trend and momentum indicators. Not a prediction.</p></section>
        <section class="card"><h2>Fundamental view (limited)</h2>${F && F.score != null ? `<p>${badge(F.label, '', toneKind(F.label))} <span class="muted">score ${F.score}</span></p><table class="tbl"><tbody>${sigRows(F.signals)}</tbody></table>
        <table class="tbl kv"><tbody><tr><td>Dividend yield (TTM)</td><td class="num">${F.yield != null ? F.yield + '%' : '—'}</td></tr><tr><td>Sector index P/E · P/B</td><td class="num">${F.sectorPE ?? '—'} · ${F.sectorPB ?? '—'}</td></tr><tr><td>Sector index dividend yield</td><td class="num">${F.sectorYield != null ? F.sectorYield + '%' : '—'}</td></tr></tbody></table>` : '<p class="muted">Corporate-action data is not available yet.</p>'}
        <p class="muted">${esc((F && F.basis) || 'Based on NSE dividends and corporate actions.')}. NSE does not publish this stock’s P/E, earnings, debt or growth, so this is not a full fundamental analysis.</p></section></div>`;
    }
    $('#qwrap').innerHTML = `<header class="qhead"><div><h1>${esc(sym)} <small class="muted">${u && u.sector !== 'Other' ? esc(u.sector) : 'NSE'}${q.series ? ` · ${esc(q.series)}` : ''}</small></h1>
        <div class="qprice"><span class="big">${money(price)}</span><span class="${cls(c)}">${arrow(c)} ${signed(q.change)} (${Math.abs(c).toFixed(2)}%)</span></div>
        <p class="muted">${esc(q.latestTimestamp || '')}${d.stale ? ' · saved snapshot' : ''}</p></div>
        <button id="wl-btn" class="btn ${inWl ? 'on' : ''}">${inWl ? '★ In watchlist' : '☆ Add to watchlist'}</button></header>
      <section class="card"><div class="tabs" id="range">${[['w', '1W'], ['m', '1M'], ['all', `${h.length}D`]].map(([k, l]) => `<button data-r="${k}" class="${k === quoteRange ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div id="chart" class="chart"></div>${h.length ? '' : '<p class="muted">No daily history returned for this symbol.</p>'}</section>
      <nav class="subtabs">${tabs.map((t) => `<a href="#/quote/${encodeURIComponent(sym)}/${t}" class="${t === tab ? 'on' : ''}">${tabName[t]}</a>`).join('')}</nav>${body}`;
    drawQuoteChart(); paintLive();
    if (tab === 'news') loadStockNews(sym);
    $$('#range button').forEach((b) => b.addEventListener('click', () => { quoteRange = b.dataset.r; $$('#range button').forEach((x) => x.classList.toggle('on', x === b)); drawQuoteChart(); }));
    $('#wl-btn').addEventListener('click', () => {
      const cur = store.get('ml.watchlist', []);
      store.set('ml.watchlist', cur.includes(sym) ? cur.filter((x) => x !== sym) : [...cur, sym]); renderQuote(d, tab);
    });
  }

  views.watchlist = () => {
    const wl = store.get('ml.watchlist', []);
    return {
      html: `<h1>Watchlist</h1>${wl.length ? `<section class="card"><table class="tbl"><thead><tr><th>Stock</th><th class="num">Price</th><th class="num">Change</th><th></th></tr></thead><tbody>
        ${wl.map((x) => { const s = bySym[x]; return `<tr><td><a href="#/quote/${encodeURIComponent(x)}">${esc(x)}</a></td>${s ? `<td class="num" data-px="${x}"></td><td class="num" data-chg="${x}"></td>` : '<td class="num muted" colspan="2">open to view</td>'}<td><button class="link" data-rm="${esc(x)}">Remove</button></td></tr>`; }).join('')}</tbody></table></section>`
        : '<section class="card"><p>Your watchlist is empty. Open any stock page and use “Add to watchlist”. It is stored only in this browser.</p></section>'}`,
      after() { $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { store.set('ml.watchlist', store.get('ml.watchlist', []).filter((x) => x !== b.dataset.rm)); route(); })); },
    };
  };

  /* ---------- screener: lazy-loaded module (js/screener.js) ---------- */
  let unmountScreener = null;
  views.screener = () => ({
    html: '<div id="screener-host"></div>',
    after() {
      const host = $('#screener-host');
      import('./screener.js').then((m) => m.mount(host, { D, paintLive })).then((un) => { unmountScreener = un; })
        .catch((e) => { host.innerHTML = errorState('Could not load the screener', e.message, 'sc-retry'); $('#sc-retry')?.addEventListener('click', () => route()); });
    },
  });

  views.notfound = () => ({ html: '<section class="card"><h1>Not found</h1><p><a href="#/">Back to home</a></p></section>' });

  /* ---------- shell, search, router ---------- */
  function wireTabs() {
    $$('[data-tabs]').forEach((t) => $$('button', t).forEach((b) => b.addEventListener('click', () => {
      $$('button', t).forEach((x) => x.classList.toggle('on', x === b));
      $$('[data-pane]', t.parentElement).forEach((p) => p.classList.toggle('hide', p.dataset.pane !== b.dataset.t));
    })));
  }
  function wireSearch() {
    const input = $('#q'), box = $('#suggest'); let timer = null, seq = 0;
    const show = (html) => { box.innerHTML = html; box.classList.remove('hide'); };
    const item = (x) => `<a href="#/quote/${encodeURIComponent(x.symbol)}"><b>${esc(x.symbol)}</b> <span class="muted">${x.last_close != null ? money(x.last_close) : ''}${x.pct_change != null ? ` · ${signed(x.pct_change)}%` : ''}${x.source === 'nse' ? ' · NSE' : ''}</span></a>`;
    const goto = (sym) => { location.hash = `#/quote/${encodeURIComponent(sym)}`; input.value = ''; box.classList.add('hide'); };
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = input.value.trim().toUpperCase();
      if (/^[A-Z0-9&_-]{1,24}$/.test(v)) goto(v);
    });
    input.addEventListener('input', () => {
      const v = input.value.trim().toUpperCase();
      clearTimeout(timer);
      if (!v) { box.classList.add('hide'); return; }
      const local = stocks.filter((s) => s.sym.includes(v)).sort((a, b) => (!a.sym.startsWith(v)) - (!b.sym.startsWith(v)) || a.sym.localeCompare(b.sym)).slice(0, 6)
        .map((s) => ({ symbol: s.sym, last_close: s.price, pct_change: +chgPct(s).toFixed(2), source: 'local' }));
      show(local.map(item).join('') + '<span class="muted pad">Searching all NSE symbols… (Enter opens “' + esc(v) + '”)</span>');
      const my = ++seq;
      timer = setTimeout(() => {
        api(`/api/search?q=${encodeURIComponent(v)}`, { retries: 0, quiet: true }).then((r) => {
          if (my !== seq) return;
          if (r.error) throw new Error(r.error);
          const seen = new Set(), all = [...local, ...(r.results || [])].filter((x) => !seen.has(x.symbol) && seen.add(x.symbol)).slice(0, 12);
          show((all.length ? all.map(item).join('') : '<span class="muted pad">No matches. Press Enter to try “' + esc(v) + '” directly.</span>') + (r.note ? `<span class="muted pad note">${esc(r.note)}</span>` : ''));
        }).catch(() => { if (my === seq) show(local.map(item).join('') + '<span class="muted pad note">Search service unavailable; showing local matches. Press Enter to open “' + esc(v) + '” directly.</span>'); });
      }, 300);
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.classList.add('hide'); });
    box.addEventListener('click', () => { input.value = ''; box.classList.add('hide'); });
    $('#theme').addEventListener('click', () => {
      const dark = document.documentElement.dataset.theme !== 'dark';
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'; store.set('ml.theme', dark ? 'dark' : 'light');
    });
  }
  function closeMenu() { const n = $('#nav'); if (n) { n.dataset.open = 'false'; $('#menu')?.setAttribute('aria-expanded', 'false'); } }
  function route() {
    if (unmountScreener) { unmountScreener(); unmountScreener = null; }
    closeMenu();
    const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
    const name = parts[0] || 'home';
    const v = (views[name] || views.notfound)(parts.slice(1));
    $('#app').classList.toggle('container--wide', ['screener', 'options', 'markets'].includes(name));   // data-heavy pages use more of a wide screen
    $('#app').innerHTML = v.html;
    $$('nav.main a').forEach((a) => a.classList.toggle('on', a.dataset.r === name || (name === 'quote' && a.dataset.r === 'markets')));
    if (v.after) v.after();
    paintLive();
    window.scrollTo(0, 0);
    $('#app').focus({ preventScroll: true });
    document.title = `${name === 'home' ? 'Home' : name[0].toUpperCase() + name.slice(1)} · MarketLens`;
  }

  // The earlier synthetic version saved fictional symbols in this origin; drop them once.
  if (store.get('ml.dataVersion', null) !== 'nse2') {
    ['ml.watchlist', 'ml.holdings', 'ml.screen', 'ml.mktsort', 'ml.pfgroup', 'ml.newscat'].forEach((k) => { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
    store.set('ml.dataVersion', 'nse2');
  }
  document.documentElement.dataset.theme = store.get('ml.theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  wireSearch();
  $('#menu').addEventListener('click', () => { const open = $('#nav').dataset.open !== 'true'; $('#nav').dataset.open = open; $('#menu').setAttribute('aria-expanded', open); });
  if (window.MLUser) {
    $('#whoami').textContent = window.MLUser.name; $('#whoami').classList.remove('hide'); $('#logout').classList.remove('hide');
    $('#logout').addEventListener('click', async () => { $('#logout').disabled = true; try { await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MarketLens' }, body: '{}' }); } finally { location.hash = '#/'; location.reload(); } });
  }
  onConn(() => paintBanner());
  setInterval(paintBanner, 30000);
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', drawQuoteChart);
  route();
  // refresh quotes every minute (the server caches and falls back to a saved snapshot)
  setInterval(() => D.refresh().then(() => { updates = buildUpdates(); paintLive(); }).catch(() => {}), 60000);
  // dividend yields and sparklines arrive in the background
  D.loadExtras(() => { paintLive(); D.onAnalysis && D.onAnalysis(); const h = location.hash; if ((h === '' || h === '#/' || h === '#/markets') && (!document.activeElement || document.activeElement === document.body)) route(); });
  D.loadSentiment(() => { D.onAnalysis && D.onAnalysis(); });

