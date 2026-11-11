/* Small pieces the desk pages share (tabs in the same underlined style as the Screener and Paper trading, KPI tiles, state badges). */
import { esc, money } from './lib.js';

export const viewTabs = (id, items, active, label) => `<div class="viewtabs" role="tablist" id="${id}" aria-label="${esc(label)}">${items.map(([k, l]) => `<button type="button" role="tab" class="vt ${k === active ? 'on' : ''}" aria-selected="${k === active}" tabindex="${k === active ? 0 : -1}" data-tab="${k}">${esc(l)}</button>`).join('')}</div>`;

/** Wire the tabs: click and arrow keys; `onPick(key)` is called after the buttons are updated. */
export function bindViewTabs(root, id, onPick) {
  const list = root.querySelector(`#${id}`); if (!list) return;
  const all = () => [...list.querySelectorAll('[role=tab]')];
  const pick = (el) => { all().forEach((b) => { const on = b === el; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; }); onPick(el.dataset.tab); };
  list.addEventListener('click', (e) => { const b = e.target.closest('[role=tab]'); if (b) pick(b); });
  list.addEventListener('keydown', (e) => { const t = all(), i = t.indexOf(document.activeElement), to = { ArrowRight: (i + 1) % t.length, ArrowLeft: (i - 1 + t.length) % t.length, Home: 0, End: t.length - 1 }[e.key]; if (to !== undefined && i >= 0) { e.preventDefault(); t[to].focus(); pick(t[to]); } });
}

export const kpi = (label, value, sub = '', cls = '') => `<div class="kpi"><small>${esc(label)}</small><b class="${cls}">${value}</b>${sub ? `<div class="note">${sub}</div>` : ''}</div>`;
const TONE = { FILLED: 'ok', PARTIALLY_FILLED: 'wait', ACKNOWLEDGED: 'wait', SUBMITTED: 'wait', SUBMITTING: 'wait', RISK_APPROVED: 'wait', CREATED: 'wait', CANCEL_REQUESTED: 'wait', CANCELLED: 'bad', REJECTED: 'bad', UNKNOWN: 'bad',
  approve: 'ok', reject: 'bad', candidate: 'ok', rejected: 'bad', no_trade: '', awaiting_approval: 'wait', research_only: '', new: '', rejected_by_user: 'bad', filled: 'ok', acknowledged: 'wait', unknown: 'bad', cancelled: 'bad' };
export const stateBadge = (s) => `<span class="state ${TONE[s] ?? ''}">${esc(String(s).replace(/_/g, ' '))}</span>`;
export const when = (ms) => (ms ? new Date(ms + 5.5 * 3600e3).toISOString().slice(5, 19).replace('T', ' ') : '—');
export const meter = (score) => `<span class="meter bi" title="${score}"><i class="${score < 0 ? 'neg' : ''}" style="${score >= 0 ? `left:50%;width:${Math.abs(score) * 50}%` : `right:50%;left:auto;width:${Math.abs(score) * 50}%`}"></i></span>`;
export const rupee = (n, d = 0) => `₹${money(n, d)}`;
