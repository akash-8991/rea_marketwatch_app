/* Operator page: data and feed health, the kill switches, the trading mode, incidents, the audit log (verifiable and exportable) and the pre-live checklist.
 * The kill switch halts new orders inside the app at once (the risk engine rejects with KILL_SWITCH) and is mirrored to the server, whose broker gate refuses live orders independently. */
import { $, $$, esc, money, api, store } from './lib.js';
import { toast, buttonClass, confirmDialog } from './ui.js';
import * as C from './desk-core.js';
import * as desk from './desk.js';
import { kpi, stateBadge, when, viewTabs, bindViewTabs } from './desk-ui.js';

export const CHECKLIST = [
  ['static_ip', 'A static IP is whitelisted for my Kite Connect app (Zerodha allows up to two) and this machine sends orders from it.'],
  ['algo_registration', 'I have checked the current SEBI / NSE / Zerodha rules for API (algo) orders, including tagging and any registration that applies to my account type.'],
  ['kite_app', 'My Kite Connect app, redirect URL and API credentials are set up, and I signed in today (the token expires about 06:00 IST).'],
  ['paper_run', 'I have run this strategy in paper or shadow mode for long enough to trust it, and read the order blotter and the audit log.'],
  ['limits', 'The risk limits on the Orders page are set to amounts I can afford to lose, and the Zerodha gate cap is low for the first orders.'],
  ['kill_tested', 'I have tested the kill switch and know how to stop everything.'],
  ['tiny_first', 'My first live orders will be tiny, with the mode on Manual approval so I confirm each one.'],
  ['retention', 'I keep order, trade and audit records for as long as the rules require (export the audit log regularly).'],
];

export function mount(root, { D }) {
  let alive = true; const S = { tab: store.get('ml.ops.tab', 'health'), verify: null };
  root.innerHTML = `<div class="grid gap-3"><div><h1 class="m-0">Operator</h1><p class="m-0 mt-1 text-sm text-muted-foreground">Health, the kill switch, the trading mode, incidents, the audit trail and the pre-live checklist.</p></div><div id="op-top"></div>
    ${viewTabs('op-tabs', [['health', 'Health'], ['mode', 'Mode and kill switch'], ['audit', 'Audit log'], ['check', 'Pre-live checklist'], ['inc', 'Incidents']], S.tab, 'Operator sections')}<div id="op-body"></div></div>`;
  bindViewTabs(root, 'op-tabs', (t) => { S.tab = t; store.set('ml.ops.tab', t); paint(); });
  const live = () => (window.MLLive && window.MLLive.state) || {}, brokerP = () => desk.brokerStatus();

  function top() {
    const d = desk.load(); $('#op-top', root).innerHTML = `<div class="desk-kpis">${kpi('Mode', esc(C.MODES.find((m) => m[0] === d.mode)[1]))}${kpi('Kill switch', d.kill.global ? '<span class="down">ON</span>' : 'off', esc(d.kill.reason || ''))}${kpi('Market', D.market ? esc(D.market.label) : '—')}${kpi('Audit entries', desk.audit.load().entries.length)}${kpi('Incidents', d.incidents.length)}</div>`;
    $('#op-top', root).insertAdjacentHTML('beforeend', `<div class="mt-2"><button type="button" class="kill ${d.kill.global ? '' : 'armed'}" id="op-kill">${d.kill.global ? 'Kill switch ON: resume trading' : 'KILL SWITCH: stop all new orders'}</button></div>`);
    $('#op-kill', root).addEventListener('click', async () => { if (d.kill.global) { if (!(await confirmDialog({ title: 'Resume trading?', text: 'New orders will be allowed again (subject to the risk engine).', confirmLabel: 'Resume' }))) return; await desk.setKill(false); } else await desk.setKill(true, 'operator pressed the kill switch'); paint(); });
  }
  async function health() {
    const st = live(), bs = await brokerP(), d = desk.load(), age = st.last ? (Date.now() - st.last) / 1000 : null, lagOk = age != null && age < 5;
    return `<section class="card"><h2>Feed and data health</h2><div class="desk-kpis">${kpi('Live feed', D.market && D.market.live ? (lagOk ? '<span class="up">streaming</span>' : '<span class="down">stale</span>') : 'market closed', age != null ? `last answer ${age.toFixed(1)} s ago` : 'no answer yet')}${kpi('Round trip', st.latency != null ? `${st.latency} ms` : '—', 'page to server')}${kpi('Server clock skew', st.skew != null ? `${st.skew > 0 ? '+' : ''}${(st.skew / 1000).toFixed(2)} s` : '—', Math.abs(st.skew || 0) > 2000 ? 'check this machine\'s clock' : 'within 2 s')}${kpi('Gaps (answers > 2.5 s apart)', st.gaps || 0)}${kpi('Reconnects', st.reconnects || 0)}${kpi('Polls ok', st.ok || 0, `${st.fails || 0} failing in a row`)}${kpi('Reconciliation breaks', d.reconBreaks, 'in a row')}</div>
      <p class="note">A feed is called stale when no answer has arrived for 5 s while the market is open; the risk engine also rejects any order whose own quote is older than ${d.limits.staleSeconds} s (STALE_DATA).</p></section>
      <section class="card"><h2>Broker</h2>${bs ? `<div class="desk-kpis">${kpi('Zerodha', bs.connected ? '<span class="up">connected</span>' : bs.configured ? 'not signed in today' : 'not set up', bs.user ? esc(bs.user.id || '') : '')}${kpi('Live orders', bs.liveOrdersEnabled ? '<span class="down">enabled</span>' : 'off', bs.liveOrdersEnabled ? 'started with --enable-live-orders' : 'default')}${kpi('Server kill switch', bs.killSwitch ? '<span class="down">ON</span>' : 'off')}${kpi('Gate caps', `${money(bs.maxOrderValue, 0)} / order`, `${bs.maxOps} orders per second`)}</div>` : '<p class="muted">The broker connection is part of the desktop app (it needs a static IP). Paper and shadow trading work everywhere.</p>'}</section>`;
  }
  function mode() {
    const d = desk.load();
    return `<section class="card"><h2>Trading mode</h2><div class="grid gap-2">${C.MODES.map(([k, l, t]) => `<label class="flex items-start gap-2"><input type="radio" name="mode" value="${k}" ${d.mode === k ? 'checked' : ''}><span><b>${esc(l)}</b><br><span class="note">${esc(t)}</span></span></label>`).join('')}</div>
      <div class="desk-form mt-2"><label>Broker for manual approval<select id="md-broker"><option value="paper">Paper account</option><option value="zerodha" ${d.broker === 'zerodha' ? 'selected' : ''}>Zerodha (real orders; needs the live flag)</option></select></label><label>Strategy status<select id="md-strat"><option value="active">Active</option><option value="paused" ${d.strategyStatus === 'paused' ? 'selected' : ''}>Paused</option></select></label></div>
      <p class="note mt-2">Changing the mode asks for confirmation and is audited. Live mode also needs the server started with <code>--enable-live-orders</code>, a connected broker and every item of the pre-live checklist ticked.</p></section>
      <section class="card"><h2>Kill switches by strategy and stock</h2><div class="desk-form"><label>Block a stock<input id="ks-sym" placeholder="RELIANCE" maxlength="24"></label><div><button type="button" class="btn" id="ks-add">Block</button></div></div>
      <div class="mt-2">${Object.keys(d.kill.instruments).filter((s) => d.kill.instruments[s]).map((s) => `<span class="state bad">${esc(s)} <button type="button" class="btn small" data-unblock="${esc(s)}">×</button></span> `).join('') || '<span class="muted">No stock is blocked.</span>'}</div></section>`;
  }
  function auditView() {
    const log = desk.audit.load();
    return `<section class="card"><h2>Audit log</h2><p class="note">Append-only and hash-chained: every entry carries the SHA-256 of the one before it, so any edit shows up when you verify. It records signal runs, weight changes, intents, risk decisions with their reasons, approvals, orders and their states, reconciliation, mode changes and the kill switch.</p>
      <div class="flex gap-2"><button type="button" class="btn on" id="au-verify">Verify the chain</button><button type="button" class="btn" id="au-export">Export CSV</button><span id="au-res" class="note self-center">${S.verify ? (S.verify.ok ? `<span class="state ok">chain intact</span> (${S.verify.entries} entries)` : `<span class="state bad">broken at entry ${S.verify.brokenAt}</span>`) : ''}</span></div>
      <div class="scroll mt-2"><table class="tbl"><thead><tr><th class="num">#</th><th>Time (IST)</th><th>Event</th><th>Detail</th><th>Hash</th></tr></thead><tbody>${[...log.entries].reverse().slice(0, 150).map((e) => `<tr><td class="num">${e.seq}</td><td>${when(e.at)}</td><td>${esc(e.type)}</td><td class="note">${esc(JSON.stringify(e.data).slice(0, 160))}</td><td><code>${e.hash.slice(0, 10)}</code></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing recorded yet.</td></tr>'}</tbody></table></div></section>`;
  }
  function check() {
    const d = desk.load(), done = CHECKLIST.filter(([k]) => d.checklist[k]).length;
    return `<section class="card"><h2>Pre-live checklist (${done} of ${CHECKLIST.length})</h2><p class="note">Do not assume a technical design makes you compliant. Tick each item only when it is true; live mode stays locked until all are ticked. Check the latest circulars from SEBI, NSE and Zerodha yourself.</p>
      <div class="grid gap-2">${CHECKLIST.map(([k, t]) => `<label class="flex items-start gap-2"><input type="checkbox" data-ck="${k}" ${d.checklist[k] ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('')}</div></section>`;
  }
  function incidents() {
    const d = desk.load();
    return `<section class="card"><h2>Incidents</h2><div class="scroll"><table class="tbl"><thead><tr><th>Time (IST)</th><th>Kind</th><th>Detail</th></tr></thead><tbody>${d.incidents.map((i) => `<tr><td>${when(i.at)}</td><td>${stateBadge(i.kind)}</td><td class="note">${esc(i.detail)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No incidents. A kill switch, an unknown order or a reconciliation pause creates one with the reason and time.</td></tr>'}</tbody></table></div></section>`;
  }
  async function paint() {
    top(); const b = $('#op-body', root); b.innerHTML = '<p class="muted pad">Loading…</p>';
    b.innerHTML = await ({ health, mode: async () => mode(), audit: async () => auditView(), check: async () => check(), inc: async () => incidents() }[S.tab])(); if (!alive) return;
    $$('[name=mode]', b).forEach((r) => r.addEventListener('change', async () => {
      const d = desk.load(), to = r.value, from = d.mode; if (to === from) return;
      if (to === 'live') { const bs = await brokerP(); const all = CHECKLIST.every(([k]) => d.checklist[k]); if (!bs || !bs.liveOrdersEnabled || !bs.connected || !all) { toast.error('Live mode is locked', !bs ? 'The broker connection is part of the desktop app.' : !bs.liveOrdersEnabled ? 'Start the server with --enable-live-orders.' : !bs.connected ? 'Connect Zerodha in Settings.' : 'Tick every item of the pre-live checklist.'); r.checked = false; $(`[name=mode][value="${from}"]`, b).checked = true; return; } }
      if (!(await confirmDialog({ title: `Switch to ${C.MODES.find((m) => m[0] === to)[1]} mode?`, text: C.MODES.find((m) => m[0] === to)[2], confirmLabel: 'Switch', danger: to === 'live' }))) { $(`[name=mode][value="${from}"]`, b).checked = true; return; }
      d.mode = to; desk.save(d); await desk.log('mode_change', { from, to }); toast.success('Mode changed', to); paint();
    }));
    $('#md-broker', b)?.addEventListener('change', async (e) => { const d = desk.load(); d.broker = e.target.value; desk.save(d); await desk.log('broker_choice', { broker: d.broker }); });
    $('#md-strat', b)?.addEventListener('change', async (e) => { const d = desk.load(); d.strategyStatus = e.target.value; desk.save(d); await desk.log('strategy_status', { status: d.strategyStatus }); });
    $('#ks-add', b)?.addEventListener('click', async () => { const s = $('#ks-sym', b).value.trim().toUpperCase(); if (!/^[A-Z0-9&_-]{1,24}$/.test(s)) return; const d = desk.load(); d.kill.instruments[s] = true; desk.save(d); await desk.log('kill_switch', { instrument: s, on: true }); paint(); });
    $$('[data-unblock]', b).forEach((x) => x.addEventListener('click', async () => { const d = desk.load(); delete d.kill.instruments[x.dataset.unblock]; desk.save(d); await desk.log('kill_switch', { instrument: x.dataset.unblock, on: false }); paint(); }));
    $('#au-verify', b)?.addEventListener('click', async () => { S.verify = await desk.audit.verify(); paint(); });
    $('#au-export', b)?.addEventListener('click', () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([desk.audit.toCsv()], { type: 'text/csv' })); a.download = 'marketlens-audit.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
    $$('[data-ck]', b).forEach((c) => c.addEventListener('change', async () => { const d = desk.load(); d.checklist[c.dataset.ck] = c.checked; desk.save(d); await desk.log('checklist', { item: c.dataset.ck, checked: c.checked }); paint(); }));
  }
  paint(); const t = setInterval(() => { if (!alive || !document.body.contains(root)) { clearInterval(t); return; } if (S.tab === 'health') paint(); }, 3000);
  return () => { alive = false; clearInterval(t); };
}
