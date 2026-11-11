/* Settings page: appearance (theme), trading defaults, and the Zerodha connection. The broker part is desktop-only: Kite Connect needs a whitelisted static IP for orders and the
 * API secret must stay on a machine you control, so the phone app shows an explanation instead. The secret and the access token never reach this page: the server keeps them
 * (owner-only file) and only reports whether you are connected. */
import { $, $$, esc, api, store, fmtDate } from './lib.js';
import { toast, buttonClass, confirmDialog, alert } from './ui.js';
import { THEMES, applyTheme, currentTheme } from './theme.js';
import * as desk from './desk.js';
import * as C from './desk-core.js';
import { viewTabs, bindViewTabs, kpi, stateBadge, when } from './desk-ui.js';

export function mount(root, { D }) {
  const S = { tab: store.get('ml.set.tab', 'appearance'), bs: null, account: null };
  const q = new URLSearchParams((location.hash.split('?')[1] || '')); if (q.get('broker')) S.tab = 'broker';
  const phone = !!window.MLEngine;
  root.innerHTML = `<div class="grid gap-3"><div><h1 class="m-0">Settings</h1><p class="m-0 mt-1 text-sm text-muted-foreground">Appearance, trading defaults and your Zerodha connection.</p></div>${viewTabs('st-tabs', [['appearance', 'Appearance'], ['trading', 'Trading'], ['broker', 'Zerodha'], ['about', 'About']], S.tab, 'Settings sections')}<div id="st-body"></div></div>`;
  bindViewTabs(root, 'st-tabs', (t) => { S.tab = t; store.set('ml.set.tab', t); paint(); });

  const appearance = () => `<section class="card"><h2>Theme</h2><div class="grid gap-2">${THEMES.map(([k, l]) => `<label class="flex items-center gap-2"><input type="radio" name="theme" value="${k}" ${currentTheme() === k ? 'checked' : ''}> <b>${esc(l)}</b></label>`).join('')}</div>
    <p class="note mt-2">Terminal is a dense amber-on-black layout in the style of a trading terminal: monospace figures, ticker tape, function-key bar (Alt + number) and command-line mnemonics in the search box (for example <code>INFY GP</code> opens the chart, <code>SIG</code> the signals, <code>ORD</code> the orders). The top-bar button cycles the three themes.</p></section>`;
  const trading = () => { const d = desk.load(); return `<section class="card"><h2>Trading</h2><div class="desk-kpis">${kpi('Mode', esc(C.MODES.find((m) => m[0] === d.mode)[1]), '<a href="#/ops">change on the Operator page</a>')}${kpi('Fusion weights', esc(d.fusion.version), '<a href="#/signals">edit on the Signals page</a>')}${kpi('Max order value', `₹${d.limits.maxOrderValue.toLocaleString('en-IN')}`, '<a href="#/orders">edit risk limits</a>')}${kpi('Kill switch', d.kill.global ? '<span class="down">ON</span>' : 'off')}</div>
    <p class="note">Nothing here can switch live trading on. Live orders need the server to be started with <code>--enable-live-orders</code>, a connected Zerodha session, every pre-live checklist item ticked and live mode chosen on the Operator page, with a confirmation.</p></section>`; };
  const about = () => `<section class="card"><h2>About</h2><p class="m-0">MarketLens ${esc(window.MLVersion || '')}: a local NSE markets dashboard with paper trading, chart and fundamental analysis, signals, a risk engine and an optional Zerodha connection. Data is for learning and research.</p><p class="note">Order, trade and audit records live in this browser or app (per signed-in user); export the audit log from the Operator page.</p></section>`;
  const broker = () => {
    if (phone) return `<section class="card"><h2>Zerodha</h2>${alert({ variant: 'default', title: 'Desktop app only', text: 'Kite Connect needs a whitelisted static IP to place orders and keeps your API secret on a machine you control, so the connection is part of the desktop app (the pip package or the container). Paper and shadow trading work on the phone.' })}</section>`;
    const b = S.bs; if (!b) return '<section class="card"><h2>Zerodha</h2><p class="muted">Loading…</p></section>';
    const step = (n, t) => `<h3 class="m-0 mt-3">${n}. ${t}</h3>`;
    return `<section class="card"><h2>Zerodha (Kite Connect)</h2><div class="desk-kpis">${kpi('Connection', b.connected ? '<span class="up">connected</span>' : b.configured ? 'not signed in' : 'not set up', b.user ? esc(`${b.user.name || ''} ${b.user.id || ''}`) : '')}${kpi('API key', b.apiKey ? esc(b.apiKey) : '—', b.configured ? 'secret stored on this computer' : '')}${kpi('Token valid until', b.tokenExpiresAt ? when(b.tokenExpiresAt * 1000) + ' IST' : '—', 'expires about 06:00 IST daily')}${kpi('Live orders', b.liveOrdersEnabled ? '<span class="down">ENABLED</span>' : 'off', b.liveOrdersEnabled ? 'started with --enable-live-orders' : 'reading and paper trading only')}${kpi('Server kill switch', b.killSwitch ? '<span class="down">ON</span>' : 'off')}${kpi('Market data', b.marketData && b.marketData.source === 'zerodha' ? '<span class="up">Zerodha</span>' : 'NSE', esc((b.marketData && b.marketData.reason) || ''))}</div>
      ${q.get('broker') === 'ok' ? alert({ variant: 'success', title: 'Connected to Zerodha', text: 'The session is active until about 06:00 IST tomorrow.' }) : q.get('broker') === 'error' ? alert({ variant: 'destructive', title: 'Zerodha login did not complete', text: q.get('msg') || '' }) : ''}
      ${step(1, 'Your Kite Connect app')}<p class="note">Create an app at developers.kite.trade. Set its <b>Redirect URL</b> to <code>${esc(b.redirectUrl)}</code> exactly, then enter its API key and secret. They are kept in an owner-only file in this app's data folder and are never shown again.</p>
      <div class="desk-form"><label>API key<input id="zk-key" autocomplete="off" maxlength="40" placeholder="${b.apiKey ? 'saved (enter again to replace)' : ''}"></label><label>API secret<input id="zk-secret" type="password" autocomplete="new-password" maxlength="40"></label><div><button type="button" id="zk-save" class="${buttonClass({})}">Save key and secret</button></div></div>
      ${step(2, 'Sign in at Zerodha')}<p class="note">You sign in on Zerodha's own page (your password and 2FA never touch this app). Zerodha then returns here and the connection completes.</p><button type="button" id="zk-login" class="${buttonClass({})}" ${b.configured ? '' : 'disabled'}>Login with Zerodha</button>
      <details class="mt-2"><summary>The redirect did not come back? Paste the request_token instead</summary><div class="desk-form mt-2"><label>request_token (from the address bar after login)<input id="zk-token" autocomplete="off" maxlength="80"></label><div><button type="button" id="zk-session" class="btn">Connect</button></div></div></details>
      ${step(3, 'Account')}<div class="flex gap-2"><button type="button" class="btn" id="zk-refresh" ${b.connected ? '' : 'disabled'}>Refresh account</button><button type="button" class="btn" id="zk-logout" ${b.connected ? '' : 'disabled'}>Log out</button><button type="button" class="btn" id="zk-forget" ${b.configured ? '' : 'disabled'}>Remove key and secret</button></div><div id="zk-acc" class="mt-2"></div>
      <p class="note mt-3">Zerodha lets only a whitelisted static IP place orders through the API (up to two IPs) and caps a client account at 10 orders per second; API orders count as algo orders under SEBI and NSE rules. This app adds its own gate (kill switch, limit orders only, order-value and per-second caps, one send per tag) and cannot arrange the IP or the registration for you: see docs/BROKER.md and the pre-live checklist.</p></section>`;
  };
  async function loadBroker() { try { S.bs = await desk.brokerStatus(); } catch (e) { S.bs = null; } if (S.tab === 'broker') paint(false); if (S.bs && S.bs.connected && S.tab === 'broker') accountView(); }
  async function accountView() {
    const box = $('#zk-acc', root); if (!box) return; box.innerHTML = '<span class="muted">Loading account…</span>';
    try { const a = await api('/api/broker/account', { quiet: true, retries: 0, timeoutMs: 25000 }), m = a.margins || {}, avail = m.available || {}, pos = (a.positions && a.positions.net) || [], ord = Array.isArray(a.orders) ? a.orders : [];
      box.innerHTML = `<div class="desk-kpis">${kpi('Profile', esc((a.profile || {}).user_name || ''), esc((a.profile || {}).email || ''))}${kpi('Available cash', `₹${Number(avail.live_balance ?? m.net ?? 0).toLocaleString('en-IN')}`)}${kpi('Margin used', `₹${Number((m.utilised || {}).debits ?? 0).toLocaleString('en-IN')}`)}${kpi('Open positions', pos.length)}${kpi('Orders today', ord.length)}</div>
        ${ord.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Time</th><th>Stock</th><th>Side</th><th class="num">Qty</th><th class="num">Price</th><th>Status</th></tr></thead><tbody>${ord.slice(0, 15).map((o) => `<tr><td>${esc(String(o.order_timestamp || '').slice(11, 19))}</td><td>${esc(o.tradingsymbol)}</td><td class="${o.transaction_type === 'BUY' ? 'up' : 'down'}">${esc(o.transaction_type)}</td><td class="num">${o.quantity}</td><td class="num">${o.average_price || o.price || ''}</td><td>${stateBadge(String(o.status || '').toUpperCase().replace(/ /g, '_'))}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    } catch (e) { box.innerHTML = `<span class="down">${esc(e.message)}</span>`; }
  }
  function paint(reload = true) {
    const b = $('#st-body', root); b.innerHTML = { appearance, trading, broker, about }[S.tab]();
    $$('[name=theme]', b).forEach((r) => r.addEventListener('change', () => applyTheme(r.value)));
    if (S.tab === 'broker' && !phone) {
      if (reload && !S.bs) loadBroker();
      $('#zk-save', b)?.addEventListener('click', async () => { try { S.bs = await desk.post('/api/broker/credentials', { apiKey: $('#zk-key', b).value.trim(), apiSecret: $('#zk-secret', b).value.trim() }); toast.success('Saved', 'Now sign in at Zerodha.'); paint(false); } catch (e) { toast.error('Not saved', e.message); } });
      $('#zk-login', b)?.addEventListener('click', async () => { try { const r = await api('/api/broker/login-url', { quiet: true, retries: 0 }); window.open(r.url, '_blank', 'noopener'); toast.info('Zerodha login opened in a new tab', 'Come back here when it redirects.'); } catch (e) { toast.error('Cannot start the login', e.message); } });
      $('#zk-session', b)?.addEventListener('click', async () => { try { S.bs = await desk.post('/api/broker/session', { requestToken: $('#zk-token', b).value.trim() }); toast.success('Connected', ''); paint(false); accountView(); } catch (e) { toast.error('Not connected', e.message); } });
      $('#zk-refresh', b)?.addEventListener('click', () => accountView());
      $('#zk-logout', b)?.addEventListener('click', async () => { try { S.bs = await desk.post('/api/broker/logout', {}); paint(false); } catch (e) { toast.error('Logout failed', e.message); } });
      $('#zk-forget', b)?.addEventListener('click', async () => { if (!(await confirmDialog({ title: 'Remove the API key and secret?', text: 'You will need to enter them again to reconnect.', confirmLabel: 'Remove', danger: true }))) return; try { S.bs = await desk.post('/api/broker/forget', {}); paint(false); } catch (e) { toast.error('Failed', e.message); } });
    }
  }
  const onTheme = () => { if (S.tab === 'appearance') paint(false); }; document.addEventListener('themechange', onTheme);
  paint(); if (!phone) loadBroker();
  return () => document.removeEventListener('themechange', onTheme);
}
