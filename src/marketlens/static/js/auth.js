/* Sign-in, sign-up and account recovery (lazy-loaded ES module, shown only when no session exists).
 * All checks that matter are repeated on the server; this file only makes the forms usable. */
import { $, $$, esc, api, ApiError, icon } from './lib.js';

const HEADERS = { 'Content-Type': 'application/json', 'X-Requested-With': 'MarketLens' };
const today = () => new Date().toISOString().slice(0, 10);

const field = ({ name, label, type = 'text', auto = 'off', hint = '', attrs = '' }) =>
  `<div class="field"><label for="f-${name}">${esc(label)}</label><input id="f-${name}" name="${name}" type="${type}" autocomplete="${auto}" ${attrs}${hint ? ` aria-describedby="h-${name}"` : ''}>${hint ? `<small class="hint" id="h-${name}">${esc(hint)}</small>` : ''}</div>`;
const idFields = () => field({ name: 'name', label: 'Full name', auto: 'name', attrs: 'required maxlength="80"' }) +
  field({ name: 'email', label: 'Email', type: 'email', auto: 'email', attrs: 'required maxlength="254"' }) +
  field({ name: 'dob', label: 'Date of birth', type: 'date', auto: 'bday', attrs: `required min="1900-01-01" max="${today()}"` });
const showPw = '<label class="inline"><input type="checkbox" data-show> Show password</label>';
const POLICY = '10 or more characters. Not a common password, and not containing your user ID or the first part of your email.';

const VIEWS = {
  signin: {
    title: 'Sign in', endpoint: '/api/auth/login', submit: 'Sign in',
    fields: () => field({ name: 'userId', label: 'User ID', auto: 'username', attrs: 'required maxlength="64" autocapitalize="none" spellcheck="false"' }) + field({ name: 'password', label: 'Password', type: 'password', auto: 'current-password', attrs: 'required maxlength="256"' }) + showPw,
    body: (v) => ({ userId: v.userId, password: v.password }),
  },
  signup: {
    title: 'Create an account', endpoint: '/api/auth/signup', submit: 'Create account',
    intro: 'Your details are stored only in the database on this computer. The password is stored as a salted hash, never as text.',
    fields: () => idFields() + field({ name: 'userId', label: 'Choose a user ID', auto: 'username', hint: '4 to 32 characters: letters, digits, dot, dash or underscore.', attrs: 'required maxlength="32" autocapitalize="none" spellcheck="false"' }) +
      field({ name: 'password', label: 'Choose a password', type: 'password', auto: 'new-password', hint: POLICY, attrs: 'required maxlength="128"' }) + field({ name: 'confirm', label: 'Repeat the password', type: 'password', auto: 'new-password', attrs: 'required maxlength="128"' }) + showPw,
    body: (v) => ({ name: v.name, email: v.email, dob: v.dob, userId: v.userId, password: v.password }),
    check: (v) => (v.password !== v.confirm ? { field: 'confirm', message: 'The two passwords do not match.' } : null),
  },
  forgotId: {
    title: 'Forgot your user ID?', endpoint: '/api/auth/forgot-user-id', submit: 'Show my user ID',
    intro: 'Enter the name, email and date of birth you signed up with. All three must match.',
    fields: idFields, body: (v) => ({ name: v.name, email: v.email, dob: v.dob }),
    done: (d) => `Your user ID is <strong class="mono">${esc(d.userId)}</strong>.`,
  },
  update: {
    title: 'Forgot password, or change user ID or password', endpoint: '/api/auth/update-credentials', submit: 'Change it',
    intro: 'Enter the name, email and date of birth you signed up with. Only if all three match can you set a new user ID, a new password, or both. You will be signed out everywhere.',
    fields: () => idFields() + '<hr>' + field({ name: 'newUserId', label: 'New user ID (optional)', auto: 'username', attrs: 'maxlength="32" autocapitalize="none" spellcheck="false"' }) +
      field({ name: 'newPassword', label: 'New password (optional)', type: 'password', auto: 'new-password', hint: POLICY, attrs: 'maxlength="128"' }) + field({ name: 'confirm', label: 'Repeat the new password', type: 'password', auto: 'new-password', attrs: 'maxlength="128"' }) + showPw,
    body: (v) => ({ name: v.name, email: v.email, dob: v.dob, newUserId: v.newUserId, newPassword: v.newPassword }),
    check: (v) => ((v.newPassword || v.confirm) && v.newPassword !== v.confirm ? { field: 'confirm', message: 'The two passwords do not match.' } : null),
    done: (d) => `Done. Changed: ${esc(d.changed.join(' and ') || 'nothing')}. Sign in with your new details.`, then: 'signin',
  },
};

export function mountAuth(root, status) {
  document.body.classList.add('unauth');
  let view = status.usersExist ? 'signin' : 'signup';
  const render = (notice = '') => {
    const V = VIEWS[view];
    root.innerHTML = `<section class="card auth" aria-labelledby="auth-h">
      <p class="auth-brand">Market<span>Lens</span></p><h1 id="auth-h">${esc(V.title)}</h1>
      ${!status.usersExist && view === 'signup' ? '<p class="notice">This is the first run. Create the first account to continue.</p>' : ''}
      ${V.intro ? `<p class="muted">${esc(V.intro)}</p>` : ''}
      <div id="auth-msg" role="status" aria-live="polite">${notice}</div>
      <form id="auth-form" novalidate>${V.fields()}<button class="btn on wide" type="submit">${esc(V.submit)}</button></form>
      <nav class="auth-links" aria-label="Account options">
        ${view !== 'signin' ? '<button type="button" class="link" data-go="signin">Sign in</button>' : ''}
        ${view !== 'signup' ? '<button type="button" class="link" data-go="signup">Create an account</button>' : ''}
        ${view !== 'forgotId' ? '<button type="button" class="link" data-go="forgotId">Forgot user ID?</button>' : ''}
        ${view !== 'update' ? '<button type="button" class="link" data-go="update">Forgot or change password / user ID</button>' : ''}
      </nav></section>`;
    $('#auth-form input')?.focus();
  };
  const say = (html, kind) => { const m = $('#auth-msg'); m.setAttribute('role', kind === 'error' ? 'alert' : 'status'); m.innerHTML = html ? `<p class="${kind === 'error' ? 'alert' : 'notice'}">${html}</p>` : ''; };

  root.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { view = go.dataset.go; render(); }
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-show]')) $$('#auth-form input').forEach((i) => { if (/password|confirm/i.test(i.name)) i.type = e.target.checked ? 'text' : 'password'; });
  });
  root.addEventListener('submit', async (e) => {
    if (e.target.id !== 'auth-form') return;
    e.preventDefault();
    const V = VIEWS[view], form = e.target, btn = form.querySelector('button[type=submit]');
    const v = Object.fromEntries(new FormData(form).entries());
    $$('#auth-form [aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
    const bad = V.check && V.check(v);
    if (bad) { say(esc(bad.message), 'error'); const i = form.elements[bad.field]; i.setAttribute('aria-invalid', 'true'); i.focus(); return; }
    if (!form.checkValidity()) { say('Please fill in every required field correctly.', 'error'); form.reportValidity(); return; }
    btn.disabled = true; say('Working…', 'status');                    // one submission at a time
    try {
      const d = await api(V.endpoint, { method: 'POST', headers: HEADERS, body: JSON.stringify(V.body(v)), timeoutMs: 30000 });
      if (V.done) { if (V.then) { view = V.then; render(`<p class="notice">${V.done(d)}</p>`); } else say(V.done(d), 'ok'); return; }
      location.hash = '#/'; location.reload();                          // signed in: load the app
    } catch (err) {
      say(esc(err.message), 'error');
      const i = err instanceof ApiError && err.data && err.data.field && form.elements[err.data.field];
      if (i) { i.setAttribute('aria-invalid', 'true'); i.focus(); }
    } finally { btn.disabled = false; }
  });
  render();
}
