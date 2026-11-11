/* Signals page: the five agents (technical, news, fundamental, derivatives, regime) run over a list of stocks, their proposals are fused with versioned weights, and a
 * candidate can become a trade intent that goes through the risk engine (Orders page). The agents are deterministic code reading data the app already has; none of them
 * can place an order. Every run, weight change and intent is written to the audit log. */
import { $, $$, esc, money, signed, api, store } from './lib.js';
import { toast, buttonClass } from './ui.js';
import { dailyCandles, indicators, analyse, atr as atrFn } from './ta.js';
import * as C from './desk-core.js';
import * as desk from './desk.js';
import { kpi, stateBadge, meter } from './desk-ui.js';

const AG = ['technical', 'news', 'fundamental', 'derivatives', 'regime'];
const LABEL = { technical: 'Technical', news: 'News', fundamental: 'Fundamental', derivatives: 'Derivatives', regime: 'Regime' };
const sc = (x) => (x == null ? '<span class="muted">—</span>' : `<span class="${x > 0.05 ? 'up' : x < -0.05 ? 'down' : ''}">${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}</span>`);

export function mount(root, { D, bySym, sym: focus }) {
  let alive = true; const S = { rows: [], running: false, uni: store.get('ml.sig.uni', 'top'), custom: store.get('ml.sig.custom', ''), open: null };
  const universe = () => {
    if (S.uni === 'watchlist') return store.get('ml.watchlist', []).slice(0, 30);
    if (S.uni === 'custom') return S.custom.toUpperCase().split(/[\s,]+/).filter((x) => /^[A-Z0-9&_-]{1,24}$/.test(x)).slice(0, 30);
    return [...D.stocks].sort((a, b) => (b.valueCr || 0) - (a.valueCr || 0)).slice(0, 20).map((s) => s.sym);
  };
  root.innerHTML = `<div class="grid gap-3"><div><h1 class="m-0">Signals</h1><p class="m-0 mt-1 text-sm text-muted-foreground">Five agents read the market and propose; a weighted fusion combines them; a candidate becomes a trade intent that the risk engine must approve. Agents never place orders.</p></div>
    <section class="card"><h2>Run the agents</h2><div class="desk-form"><label>Universe<select id="sg-uni"><option value="top">Top 20 most traded</option><option value="watchlist">My watchlist</option><option value="custom">Symbols I type</option></select></label>
      <label id="sg-custom-l">Symbols<input id="sg-custom" placeholder="INFY, TCS, RELIANCE" maxlength="300"></label><div><button type="button" id="sg-run" class="${buttonClass({})}">Run agents</button></div></div>
      <div id="sg-status" class="note mt-2" role="status"></div></section>
    <section class="card"><h2>Fusion weights <span class="muted" id="sg-ver"></span></h2><div class="desk-form" id="sg-weights"></div>
      <div class="desk-form mt-2"><label>Minimum score<input id="sg-min" type="number" step="0.05" min="0.05" max="0.9"></label><label>Minimum confidence<input id="sg-conf" type="number" step="0.05" min="0.1" max="0.95"></label><label>Conflict penalty<input id="sg-pen" type="number" step="0.05" min="0" max="0.9"></label><div><button type="button" id="sg-save" class="${buttonClass({ variant: 'outline' })}">Save as a new version</button></div></div>
      <p class="note mt-2">Missing optional agents are listed and the remaining weights renormalised; a missing technical agent rejects the signal; strong disagreement between agents cuts the score and confidence by the conflict penalty. Weights are versioned and every change is audited.</p></section>
    <section class="card"><h2>Proposals</h2><div id="sg-kpis"></div><div class="scroll"><table class="tbl"><caption class="sr-only">Fused signals</caption><thead><tr><th>Stock</th>${AG.map((a) => `<th class="num">${LABEL[a]}</th>`).join('')}<th>Fused</th><th class="num">Conf.</th><th>Decision</th><th></th></tr></thead><tbody id="sg-body"><tr><td colspan="10" class="muted">Run the agents to see proposals.</td></tr></tbody></table></div></section></div>`;
  const dk = () => desk.load();
  const paintCfg = () => { const d = dk(); $('#sg-ver', root).textContent = `(${d.fusion.version})`; $('#sg-weights', root).innerHTML = AG.map((a) => `<label>${LABEL[a]} weight<input data-w="${a}" type="number" step="0.05" min="0" max="1" value="${d.fusion.weights[a]}"></label>`).join('');
    $('#sg-min', root).value = d.fusion.minScore; $('#sg-conf', root).value = d.fusion.minConfidence; $('#sg-pen', root).value = d.fusion.conflictPenalty; $('#sg-uni', root).value = S.uni; $('#sg-custom', root).value = S.custom; $('#sg-custom-l', root).hidden = S.uni !== 'custom'; };
  paintCfg();
  $('#sg-uni', root).addEventListener('change', (e) => { S.uni = e.target.value; store.set('ml.sig.uni', S.uni); $('#sg-custom-l', root).hidden = S.uni !== 'custom'; });
  $('#sg-custom', root).addEventListener('change', (e) => { S.custom = e.target.value; store.set('ml.sig.custom', S.custom); });
  $('#sg-save', root).addEventListener('click', async () => {
    const d = dk(), w = {}; $$('[data-w]', root).forEach((i) => { w[i.dataset.w] = Math.max(0, Math.min(1, +i.value || 0)); });
    const sum = Object.values(w).reduce((a, b) => a + b, 0); if (sum <= 0) { toast.error('Weights', 'At least one weight must be above zero.'); return; }
    const n = +(String(d.fusion.version).match(/(\d+)$/) || [0, 0])[1] + 1; d.fusion = { ...d.fusion, version: `fusion-${n}`, weights: w, minScore: +$('#sg-min', root).value || d.fusion.minScore, minConfidence: +$('#sg-conf', root).value || d.fusion.minConfidence, conflictPenalty: Math.max(0, Math.min(0.9, +$('#sg-pen', root).value)) };
    desk.save(d); await desk.log('fusion_config', { version: d.fusion.version, weights: w, minScore: d.fusion.minScore, minConfidence: d.fusion.minConfidence, conflictPenalty: d.fusion.conflictPenalty }); toast.success('Saved', `Fusion weights ${d.fusion.version}`); paintCfg();
  });

  async function agentsFor(symbol, now) {
    const out = [], st = bySym[symbol], regime = C.regimeAgent(symbol, { breadth: D.breadth, mood: D.mood }, { now }); let price = st && st.price, atr = null, sector = (st && st.sector) || 'Other';
    try { // technical: the chart read on daily candles
      const h = await api(`/api/history/${encodeURIComponent(symbol)}?range=5Y`, { quiet: true, retries: 0, timeoutMs: 40000 });
      if (h.available) { const cs = dailyCandles(h.points); if (cs.length > 30) { const ind = indicators(cs), an = analyse(cs, ind, '1D'); out.push(C.technicalAgent(symbol, an, { now })); atr = ind.atr[ind.atr.length - 1]; price = price || cs[cs.length - 1].c; } }
    } catch (e) { /* the technical agent is missing: fusion says so */ }
    let sent = D.sentiment && D.sentiment[symbol];
    if (!sent) { try { sent = (await api(`/api/news/stock/${encodeURIComponent(symbol)}`, { quiet: true, retries: 0, timeoutMs: 15000 })).sentiment; } catch (e) { sent = null; } }
    out.push(C.newsAgent(symbol, sent, { now })); out.push(C.fundamentalAgent(symbol, st, { now }));
    try { const o = await api(`/api/options?symbol=${encodeURIComponent(symbol)}`, { quiet: true, retries: 0, timeoutMs: 8000 }); if (o && o.available) out.push(C.derivativesAgent(symbol, { pcr: o.summary && o.summary.pcr, maxPain: o.summary && o.summary.maxPain, spot: o.spot }, { now })); } catch (e) { /* no option chain for this stock */ }
    out.push(regime);
    return { proposals: out.filter(Boolean), price, atr, sector };
  }

  async function run() {
    if (S.running) return; const syms = universe(); if (!syms.length) { toast.error('No symbols', 'Choose a universe or type symbols.'); return; }
    S.running = true; $('#sg-run', root).disabled = true; S.rows = []; const d = dk(), status = $('#sg-status', root), now = Date.now(); let done = 0, i = 0;
    await desk.log('signal_run', { universe: S.uni, symbols: syms, fusion: d.fusion.version });
    const worker = async () => { while (alive && i < syms.length) { const s = syms[i++]; const r = await agentsFor(s, now); const f = C.fuse(r.proposals, d.fusion, now); S.rows.push({ sym: s, ...r, fused: f }); done++; status.textContent = `Running agents… ${done} of ${syms.length}`; paintRows(); } };
    await Promise.all([worker(), worker(), worker()]); S.running = false; if (!alive) return; $('#sg-run', root).disabled = false; status.textContent = `Done: ${S.rows.length} stocks at ${new Date().toLocaleTimeString('en-IN')}.`;
    await desk.log('signals', { rows: S.rows.map((r) => ({ sym: r.sym, direction: r.fused.direction, score: r.fused.score, confidence: r.fused.confidence, status: r.fused.status, components: r.fused.components })) });
  }
  $('#sg-run', root).addEventListener('click', run);

  function paintRows() {
    const rows = [...S.rows].sort((a, b) => Math.abs(b.fused.score) - Math.abs(a.fused.score)), by = (x) => (r) => r.fused.components[x] ? r.fused.components[x].score : null;
    const cand = rows.filter((r) => r.fused.status === 'candidate');
    $('#sg-kpis', root).innerHTML = `<div class="desk-kpis">${kpi('Stocks scanned', rows.length)}${kpi('Candidates', cand.length, 'above the score and confidence minimums')}${kpi('Buy', cand.filter((r) => r.fused.direction === 'BUY').length, '', 'up')}${kpi('Sell', cand.filter((r) => r.fused.direction === 'SELL').length, '', 'down')}${kpi('Rejected', rows.filter((r) => r.fused.status === 'rejected').length, 'missing technical data, low confidence or expired')}</div>`;
    $('#sg-body', root).innerHTML = rows.map((r) => { const f = r.fused; return `<tr data-sym="${esc(r.sym)}"><td><a href="#/chart/${encodeURIComponent(r.sym)}">${esc(r.sym)}</a><div class="note">${r.price ? money(r.price) : ''}</div></td>${AG.map((a) => `<td class="num">${sc(by(a)(r))}</td>`).join('')}<td>${meter(f.score)} ${sc(f.score)}</td><td class="num">${f.confidence ? Math.round(f.confidence * 100) + '%' : '—'}</td>
      <td>${stateBadge(f.status)} <b class="${f.direction === 'BUY' ? 'up' : f.direction === 'SELL' ? 'down' : ''}">${f.direction}</b>${f.conflict ? ' <span class="state wait">conflict</span>' : ''}</td><td class="num"><button type="button" class="btn small" data-why="${esc(r.sym)}">Why</button> <button type="button" class="btn small on" data-intent="${esc(r.sym)}" ${f.status === 'candidate' ? '' : 'disabled'}>Intent</button></td></tr>${S.open === r.sym ? `<tr><td colspan="10" class="note">${why(r)}</td></tr>` : ''}`; }).join('') || '<tr><td colspan="10" class="muted">Nothing yet.</td></tr>';
    $$('[data-why]', root).forEach((b) => b.addEventListener('click', () => { S.open = S.open === b.dataset.why ? null : b.dataset.why; paintRows(); }));
    $$('[data-intent]', root).forEach((b) => b.addEventListener('click', () => intent(b.dataset.intent, b)));
  }
  const why = (r) => { const f = r.fused; return `<b>Weights used</b> ${Object.entries(f.weights_used || {}).map(([a, w]) => `${LABEL[a]} ${Math.round(w * 100)}%`).join(' · ') || '—'}<br><b>Reasons</b> ${esc((f.reason_codes || []).join(', ') || '—')}<br><b>Missing agents</b> ${esc(f.missing.join(', ') || 'none')}${f.invalid.length ? ` (${esc(f.invalid.map((x) => `${x.agent}: ${x.problems.join('/')}`).join('; '))})` : ''}<br>${Object.entries(r.proposals.reduce((m, p) => ({ ...m, [p.agent_type]: p }), {})).map(([a, p]) => `<b>${LABEL[a]}</b> ${esc(p.direction)} ${p.score.toFixed(2)} (confidence ${Math.round(p.confidence * 100)}%): ${esc(p.reason_codes.join(', '))}`).join('<br>')}`; };

  async function intent(symbol, btn) {
    const r = S.rows.find((x) => x.sym === symbol); if (!r) return; btn.disabled = true;
    try {
      const d = dk(), prices = Object.fromEntries(S.rows.map((x) => [x.sym, x.price])), quote = await desk.quoteFor(symbol); if (quote.price > 0) prices[symbol] = quote.price;
      const ac = desk.accountContext(prices, (s) => (bySym[s] && bySym[s].sector) || 'Other'), it = C.buildIntent({ fused: r.fused, sym: symbol, price: quote.price || r.price, atr: r.atr, equity: ac.account.equity, limits: d.limits, strategyId: 'fusion', sector: r.sector });
      if (it.quantity < 1) { toast.error('Too small', 'The risk budget buys less than one share at this price.'); btn.disabled = false; return; }
      const bs = await desk.brokerStatus(), res = await desk.submit(it, { quote, prices, sectorOf: (s) => (bySym[s] && bySym[s].sector) || 'Other', brokerStatus: bs });
      const dec = res.decision; if (dec.decision === 'REJECT') toast.error(`${symbol}: risk engine rejected`, dec.failures.slice(0, 3).map((f) => f.code).join(', ')); else if (res.queued) toast.success(`${symbol}: waiting for your approval`, 'See Orders & risk'); else if (res.order) toast.success(`${symbol}: ${res.order.status.toLowerCase()}`, `${res.order.side} ${res.order.quantity}`); else toast.info(`${symbol}: approved`, res.note || '');
    } catch (e) { toast.error('Could not create the intent', e.message); }
    btn.disabled = false;
  }
  if (focus) { S.uni = 'custom'; S.custom = decodeURIComponent(focus).toUpperCase(); paintCfg(); run(); }
  return () => { alive = false; };
}
