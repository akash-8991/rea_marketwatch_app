/* UI components in the shadcn/ui style (same variants, same class API, same accessibility patterns), written as small ES-module helpers because the
 * app is a no-build static site shared by the desktop server, the container and the phone app. Styling is Tailwind utility classes (compiled once into
 * css/tailwind.css; see ui/) over the design tokens in style.css; icons are Lucide. Every helper returns an HTML string or wires behaviour onto the DOM
 * and escapes what it is given. Keep class strings literal: Tailwind finds classes by scanning this file. */
import { esc, icon } from './lib.js';

export const cn = (...parts) => parts.flat().filter(Boolean).join(' ');

/* ---------- button ---------- */
const BUTTON = {
  base: 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  variant: {
    default: 'bg-primary text-primary-foreground hover:opacity-90',
    secondary: 'bg-secondary text-foreground border border-border hover:bg-muted',
    outline: 'border border-input bg-card text-foreground hover:bg-muted',
    ghost: 'text-foreground hover:bg-muted',
    destructive: 'bg-down text-card hover:opacity-90',
    link: 'text-primary underline underline-offset-4 hover:opacity-80',
  },
  size: { default: 'h-9 px-4', sm: 'h-8 px-3 text-xs', lg: 'h-10 px-6', icon: 'size-9' },
};
export const buttonClass = ({ variant = 'default', size = 'default', extra = '' } = {}) => cn(BUTTON.base, BUTTON.variant[variant], BUTTON.size[size], extra);
export const button = (label, { variant, size, id = '', type = 'button', attrs = '', iconName = '', extra = '' } = {}) =>
  `<button type="${type}" ${id ? `id="${esc(id)}"` : ''} class="${buttonClass({ variant, size, extra })}" ${attrs}>${iconName ? icon(iconName, 16) : ''}${label ? `<span>${esc(label)}</span>` : ''}</button>`;

/* ---------- badge ---------- */
const BADGE = {
  base: 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
  variant: {
    default: 'border-transparent bg-primary text-primary-foreground',
    secondary: 'border-border bg-secondary text-foreground',
    outline: 'border-border text-foreground',
    success: 'border-transparent bg-up-bg text-up',
    danger: 'border-transparent bg-down-bg text-down',
    warning: 'border-transparent bg-warn-bg text-warn',
    flat: 'border-transparent bg-flat-bg text-flat',
  },
};
export const badge = (text, { variant = 'secondary', iconName = '', title = '' } = {}) =>
  `<span class="${cn(BADGE.base, BADGE.variant[variant])}" ${title ? `title="${esc(title)}"` : ''}>${iconName ? icon(iconName, 12) : ''}${esc(text)}</span>`;

/** Data status, never by colour alone: every state has its own icon and word. */
export const STATUS = {
  live: { variant: 'success', iconName: 'circle-dot', label: 'Live', hint: 'Market is open and this price is fresh (under 5 minutes old).' },
  delayed: { variant: 'warning', iconName: 'clock', label: 'Delayed', hint: 'Market is open but the latest price is more than 5 minutes old.' },
  cached: { variant: 'flat', iconName: 'database', label: 'Cached', hint: 'Shown from the app’s cache; a newer value is being fetched.' },
  closed: { variant: 'flat', iconName: 'circle-dot', label: 'Closed', hint: 'Market is closed: this is the last update of the day.' },
  stale: { variant: 'warning', iconName: 'triangle-alert', label: 'Stale', hint: 'NSE could not be reached, so a saved copy is shown.' },
  unavailable: { variant: 'danger', iconName: 'circle-x', label: 'Unavailable', hint: 'No data for this symbol right now.' },
};
export const statusBadge = (status, extraHint = '') => {
  const s = STATUS[status] || STATUS.unavailable;
  return badge(s.label, { variant: s.variant, iconName: s.iconName, title: extraHint ? `${s.hint} ${extraHint}` : s.hint });
};

/* ---------- alert ---------- */
const ALERT = { default: 'border-border bg-card text-foreground', warning: 'border-warn bg-warn-bg text-warn', destructive: 'border-down bg-down-bg text-down', success: 'border-up bg-up-bg text-up' };
const ALERT_ICON = { default: 'info', warning: 'triangle-alert', destructive: 'circle-alert', success: 'circle-check' };
export const alert = ({ title, text = '', variant = 'default', actionLabel = '', actionId = '' }) =>
  `<div role="${variant === 'destructive' ? 'alert' : 'status'}" class="${cn('flex items-start gap-3 rounded-lg border p-3 text-sm', ALERT[variant])}">${icon(ALERT_ICON[variant], 18)}
    <div class="grid gap-0.5"><p class="font-semibold leading-none">${esc(title)}</p>${text ? `<p class="opacity-90">${esc(text)}</p>` : ''}</div>
    ${actionLabel ? `<button type="button" id="${esc(actionId)}" class="${buttonClass({ variant: 'outline', size: 'sm', extra: 'ml-auto' })}">${esc(actionLabel)}</button>` : ''}</div>`;

/* ---------- skeleton ---------- */
export const skeletonBlock = (h = '1rem', w = '100%') => `<div class="animate-pulse rounded-md bg-muted" style="height:${h};width:${w}" aria-hidden="true"></div>`;
export const skeletonRows = (n = 6) => `<div role="status" aria-label="Loading" class="grid gap-2">${Array.from({ length: n }, (_, i) => skeletonBlock('2rem', `${96 - (i % 3) * 8}%`)).join('')}</div>`;

/* ---------- empty state ---------- */
export const emptyCard = ({ iconName = 'info', title, text = '', action = '' }) =>
  `<div class="grid justify-items-center gap-2 rounded-lg border border-dashed border-border bg-card p-8 text-center"><span class="text-muted-foreground">${icon(iconName, 28)}</span>
    <h2 class="m-0 text-base font-semibold normal-case tracking-normal text-foreground" style="text-transform:none;letter-spacing:0">${esc(title)}</h2>${text ? `<p class="m-0 max-w-md text-sm text-muted-foreground">${esc(text)}</p>` : ''}${action}</div>`;

/* ---------- toasts (Sonner-style): short, stacked, never modal ---------- */
const recent = new Map();
export function toast({ title, text = '', variant = 'default', duration, actionLabel = '', onAction = null, dedupeMs = 2500 }) {
  const host = document.getElementById('toasts'); if (!host) return;
  const key = `${variant}|${title}|${text}`, now = Date.now();
  if (recent.get(key) > now - dedupeMs) return;            // the same message twice in a row is one message
  recent.set(key, now);
  while (host.children.length >= 4) host.firstElementChild.remove();
  const el = document.createElement('div');
  const tone = { default: 'border-border', success: 'border-up', warning: 'border-warn', destructive: 'border-down' }[variant];
  const ic = { default: 'info', success: 'circle-check', warning: 'triangle-alert', destructive: 'circle-alert' }[variant];
  el.className = cn('toast pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-foreground', tone);
  el.setAttribute('role', variant === 'destructive' ? 'alert' : 'status');
  el.innerHTML = `${icon(ic, 18)}<div class="grid flex-1 gap-0.5"><p class="font-semibold leading-none">${esc(title)}</p>${text ? `<p class="text-muted-foreground">${esc(text)}</p>` : ''}</div>
    ${actionLabel ? `<button type="button" class="${buttonClass({ variant: 'outline', size: 'sm' })}" data-act>${esc(actionLabel)}</button>` : ''}
    <button type="button" class="${buttonClass({ variant: 'ghost', size: 'icon', extra: 'size-6' })}" aria-label="Dismiss" data-x>${icon('x', 14)}</button>`;
  const close = () => { el.remove(); };
  el.querySelector('[data-x]').addEventListener('click', close);
  const act = el.querySelector('[data-act]'); if (act) act.addEventListener('click', () => { close(); onAction && onAction(); });
  host.appendChild(el);
  let timer = setTimeout(close, duration ?? (variant === 'destructive' ? 8000 : 4500));
  el.addEventListener('mouseenter', () => clearTimeout(timer)); el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2500); });
}
toast.success = (title, text, o) => toast({ title, text, variant: 'success', ...o });
toast.info = (title, text, o) => toast({ title, text, ...o });
toast.warn = (title, text, o) => toast({ title, text, variant: 'warning', ...o });
toast.error = (title, text, o) => toast({ title, text, variant: 'destructive', ...o });

/* ---------- dialog (native <dialog>: focus trap, Esc, inert background, focus restore come from the platform) ---------- */
export function confirmDialog({ title, text = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'rounded-xl border border-border bg-popover p-0 text-foreground backdrop:bg-black/50';
    d.setAttribute('aria-labelledby', 'dlg-title');
    d.innerHTML = `<form method="dialog" class="grid w-[min(24rem,90vw)] gap-3 p-5"><h2 id="dlg-title" class="m-0 text-base font-semibold" style="text-transform:none;letter-spacing:0;color:inherit">${esc(title)}</h2>
      ${text ? `<p class="m-0 text-sm text-muted-foreground">${esc(text)}</p>` : ''}
      <div class="mt-2 flex justify-end gap-2"><button value="cancel" class="${buttonClass({ variant: 'outline' })}">Cancel</button>
      <button value="ok" class="${buttonClass({ variant: danger ? 'destructive' : 'default' })}" autofocus>${esc(confirmLabel)}</button></div></form>`;
    d.addEventListener('close', () => { const ok = d.returnValue === 'ok'; d.remove(); resolve(ok); });
    document.body.appendChild(d); d.showModal();
  });
}

/* ---------- tabs (ARIA tablist with arrow-key navigation) ---------- */
export const tabs = (items, active, { id = 'tabs', label = '' } = {}) =>
  `<div role="tablist" id="${esc(id)}" aria-label="${esc(label)}" class="inline-flex flex-wrap gap-1 rounded-lg bg-muted p-1">${items.map(([k, l]) =>
    `<button role="tab" type="button" data-tab="${esc(k)}" aria-selected="${k === active}" tabindex="${k === active ? 0 : -1}" class="rounded-md px-3 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring ${k === active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}">${esc(l)}</button>`).join('')}</div>`;
export function bindTabs(root, onChange) {
  const list = root.matches?.('[role=tablist]') ? root : root.querySelector('[role=tablist]'); if (!list) return;
  const all = () => [...list.querySelectorAll('[role=tab]')];
  const select = (el) => { all().forEach((t) => { const on = t === el; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; t.classList.toggle('bg-card', on); t.classList.toggle('text-foreground', on); t.classList.toggle('shadow-sm', on); t.classList.toggle('text-muted-foreground', !on); }); onChange(el.dataset.tab); };
  list.addEventListener('click', (e) => { const t = e.target.closest('[role=tab]'); if (t) select(t); });
  list.addEventListener('keydown', (e) => {
    const tabsEls = all(), i = tabsEls.indexOf(document.activeElement); if (i < 0) return;
    const to = { ArrowRight: (i + 1) % tabsEls.length, ArrowLeft: (i - 1 + tabsEls.length) % tabsEls.length, Home: 0, End: tabsEls.length - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); tabsEls[to].focus(); select(tabsEls[to]); }
  });
}

/* ---------- dropdown menu (button + role=menu, arrow keys, Esc, outside click) ---------- */
export function dropdown(trigger, items) {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu'); menu.hidden = true;
  menu.className = 'absolute z-50 mt-1 min-w-40 rounded-md border border-border bg-popover p-1 text-sm text-foreground shadow-md';
  menu.innerHTML = items.map(([key, label, ic]) => `<button role="menuitem" type="button" data-k="${esc(key)}" class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">${ic ? icon(ic, 14) : ''}${esc(label)}</button>`).join('');
  trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
  trigger.parentElement.style.position = 'relative'; trigger.after(menu);
  const entries = () => [...menu.querySelectorAll('[role=menuitem]')];
  const close = (focus) => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus(); };
  const open = () => { menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); entries()[0]?.focus(); };
  trigger.addEventListener('click', () => (menu.hidden ? open() : close(true)));
  menu.addEventListener('keydown', (e) => {
    const els = entries(), i = els.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); } else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length].focus(); } else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length].focus(); } else if (e.key === 'Tab') close(false);
  });
  document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) close(false); });
  return { menu, onSelect: (fn) => menu.addEventListener('click', (e) => { const b = e.target.closest('[role=menuitem]'); if (b) { close(true); fn(b.dataset.k); } }) };
}

/* ---------- small formatting helpers shared by the new views ---------- */
export const ago = (ms) => { if (ms == null) return '—'; const s = Math.round(ms / 1000); return s < 5 ? 'just now' : s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
