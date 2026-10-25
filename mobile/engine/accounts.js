/* Local accounts on the phone: port of accounts.py. Stored in the app's private storage, never sent anywhere.
 * Passwords: salted PBKDF2-SHA256 (WebCrypto), same "pbkdf2_sha256$iters$salt$digest" format as the desktop app.
 * Recovery by name + email + date of birth is weak by nature (see docs/OPERATIONS.md); it is throttled the same way. */
import { lock } from './storage.js';
import { sha256Hex } from './options.js';

export const SESSION_IDLE = 12 * 3600, SESSION_MAX = 7 * 24 * 3600, LOCK_AFTER = 5, LOCK_BASE = 15 * 60, LOCK_MAX = 24 * 3600;
const USER_ID_RE = /^[A-Za-z0-9_.-]{4,32}$/;
const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s.]{2,}$/;
const NAME_RE = /^[\p{L}][\p{L}\p{N}_ .'\-]{1,79}$/u;
const COMMON = new Set(`password password1 password12 password123 passw0rd p@ssw0rd 123456 1234567 12345678 123456789 1234567890 0123456789
qwerty qwerty123 qwertyuiop asdfghjkl zxcvbnm abc123 abcd1234 iloveyou admin administrator welcome welcome1 letmein monkey dragon
football baseball master login princess sunshine trustno1 111111 000000 123123 654321 superman michael shadow freedom whatever
changeme secret default marketlens nifty sensex stockmarket`.split(/\s+/));

export class AuthError extends Error {
  constructor(message, status = 400, field = null, retryAfter = null) { super(message); this.status = status; this.field = field; this.retryAfter = retryAfter; }
}

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

const ctEqual = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

export class Accounts {
  constructor(storage, optionStore, { iterations = 600000, now = () => Date.now() / 1000 } = {}) {
    this.s = storage; this.opts = optionStore; this.iterations = iterations; this.now = now; this.dummy = null;
  }

  async hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = this.iterations) {
    return `pbkdf2_sha256$${iterations}$${hex(salt)}$${hex(await pbkdf2(password, salt, iterations))}`;
  }

  async verifyPassword(password, stored) {
    try {
      const [algo, iters, salt, digest] = stored.split('$');
      if (algo !== 'pbkdf2_sha256') return false;
      return ctEqual(hex(await pbkdf2(password, unhex(salt), parseInt(iters, 10))), digest);
    } catch (e) { return false; }
  }

  async dummyHash() { return (this.dummy ||= await this.hashPassword('not-a-real-password', new Uint8Array(16))); }

  log(event, actor, detail, outcome = 'ok') {
    return this.opts.safeAudit(event, USER_ID_RE.test(actor || '') ? actor : 'anonymous', detail, { outcome, channel: 'app' });
  }

  /* ---------- validation ---------- */
  checkPassword(password, userId = '', email = '') {
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new AuthError('Password must be 10 to 128 characters.', 400, 'password');
    const low = password.toLowerCase();
    if (COMMON.has(low) || COMMON.has(low.replace(/^\d+|\d+$/g, ''))) throw new AuthError('That password is too common. Choose something less guessable.', 400, 'password');
    if (new Set(password).size < 5) throw new AuthError('Password uses too few different characters.', 400, 'password');
    if (userId && userId.length >= 4 && low.includes(userId.toLowerCase())) throw new AuthError('Password must not contain your user ID.', 400, 'password');
    const local = email ? email.split('@')[0].toLowerCase() : '';
    if (local.length >= 4 && low.includes(local)) throw new AuthError('Password must not contain your email name.', 400, 'password');
  }

  static normName(s) { return (s || '').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).join(' '); }
  static normEmail(s) { return (s || '').trim().toLowerCase(); }
  cleanName(s) { const v = (s || '').normalize('NFKC').split(/\s+/).filter(Boolean).join(' '); if (!NAME_RE.test(v)) throw new AuthError('Enter your name (2 to 80 letters; spaces, apostrophes, dots and hyphens are fine).', 400, 'name'); return v; }
  cleanEmail(s) { const v = Accounts.normEmail(s); if (v.length > 254 || !EMAIL_RE.test(v)) throw new AuthError('Enter a valid email address.', 400, 'email'); return v; }
  cleanDob(s) {
    const v = (s || '').trim(), m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new AuthError('Enter your date of birth as a valid date.', 400, 'dob');
    if (d.getTime() > this.now() * 1000 || +m[1] < 1900) throw new AuthError('Date of birth must be between 1900 and today.', 400, 'dob');
    return v;
  }
  cleanUserId(s) { const v = (s || '').trim(); if (!USER_ID_RE.test(v)) throw new AuthError('User ID must be 4 to 32 characters: letters, digits, dot, dash or underscore.', 400, 'userId'); return v; }

  /* ---------- throttle ---------- */
  async checkLock(key) {
    const t = ((await this.s.get('throttle')) || {})[key];
    if (t && t.lockedUntil > this.now()) {
      const wait = Math.floor(t.lockedUntil - this.now()) + 1;
      throw new AuthError(`Too many failed attempts. Try again in about ${Math.max(1, Math.round(wait / 60))} min.`, 429, null, wait);
    }
  }
  fail(key) {
    return lock('throttle', async () => {
      const all = (await this.s.get('throttle')) || {};
      let { fails, level } = all[key] || { fails: 0, level: 0 };
      fails += 1; let locked = 0;
      if (fails >= LOCK_AFTER) { level += 1; locked = this.now() + Math.min(LOCK_BASE * 2 ** (level - 1), LOCK_MAX); fails = 0; }
      all[key] = { fails, lockedUntil: locked, level };
      await this.s.set('throttle', all);
      return !!locked;
    });
  }
  clear(key) { return lock('throttle', async () => { const all = (await this.s.get('throttle')) || {}; delete all[key]; await this.s.set('throttle', all); }); }

  /* ---------- accounts ---------- */
  async users() { return (await this.s.get('users')) || []; }
  async userCount() { return (await this.users()).length; }
  pub(u) { return { uid: u.id, userId: u.userId, name: u.name }; }

  async signup(name, email, dob, userId, password) {
    name = this.cleanName(name); email = this.cleanEmail(email); dob = this.cleanDob(dob); userId = this.cleanUserId(userId);
    this.checkPassword(password, userId, email);
    const pw = await this.hashPassword(password);
    const row = await lock('users', async () => {
      const users = await this.users();
      if (users.some((u) => u.userId.toLowerCase() === userId.toLowerCase() || u.email === email)) return null;
      const seq = ((await this.s.get('users-seq')) || 0) + 1;
      const stamp = new Date(this.now() * 1000).toISOString().replace(/\.\d+Z$/, '+00:00');
      const u = { id: seq, userId, name, email, dob, pwHash: pw, createdAt: stamp, updatedAt: stamp, lastLogin: null };
      users.push(u);
      await this.s.set('users', users); await this.s.set('users-seq', seq);
      return u;
    });
    if (!row) { await this.log('signup_failed', userId, 'user ID or email already registered', 'denied'); throw new AuthError('That user ID or email is already registered.', 409); }
    await this.log('signup_ok', userId, 'account created');
    return this.pub(row);
  }

  async login(userId, password) {
    const uid = (userId || '').trim().slice(0, 64);
    const key = 'login:' + (await sha256Hex(uid.toLowerCase()));
    await this.checkLock(key);
    const row = (await this.users()).find((u) => u.userId.toLowerCase() === uid.toLowerCase());
    const ok = (await this.verifyPassword(typeof password === 'string' ? password : '', row ? row.pwHash : await this.dummyHash())) && !!row;
    if (!ok) {
      const locked = await this.fail(key);
      await this.log('login_failed', uid, 'incorrect user ID or password' + (locked ? '; locked out' : ''), 'denied');
      throw new AuthError('Incorrect user ID or password.', 401);
    }
    await this.clear(key);
    await lock('users', async () => { const users = await this.users(); const u = users.find((x) => x.id === row.id); u.lastLogin = new Date(this.now() * 1000).toISOString(); await this.s.set('users', users); });
    await this.log('login_ok', row.userId, 'signed in');
    return this.pub(row);
  }

  async verifyIdentity(name, email, dob) {
    const emailN = Accounts.normEmail(email).slice(0, 254);
    const key = 'identity:' + (await sha256Hex(emailN));
    await this.checkLock(key);
    const row = (await this.users()).find((u) => u.email === emailN);
    const st = row || { name: '', email: '', dob: '' };
    const a = ctEqual(Accounts.normName(name), Accounts.normName(st.name)), b = ctEqual(emailN, Accounts.normEmail(st.email)), d = ctEqual((dob || '').trim(), st.dob);
    if (!(row && a && b && d)) {
      const locked = await this.fail(key);
      await this.log('identity_check_failed', 'anonymous', 'name, email and date of birth did not match' + (locked ? '; locked out' : ''), 'denied');
      throw new AuthError('The details do not match our records.', 403);
    }
    await this.clear(key);
    return row;
  }

  async forgotUserId(name, email, dob) {
    const row = await this.verifyIdentity(name, email, dob);
    await this.log('user_id_recovered', row.userId, 'user ID shown after identity check');
    return row.userId;
  }

  async updateCredentials(name, email, dob, newUserId = null, newPassword = null) {
    newUserId = (newUserId || '').trim() || null;
    if (!newUserId && !newPassword) throw new AuthError('Enter a new user ID, a new password, or both.', 400, 'newPassword');
    if (newUserId) newUserId = this.cleanUserId(newUserId);
    const row = await this.verifyIdentity(name, email, dob);
    const finalId = newUserId || row.userId;
    if (newPassword) this.checkPassword(newPassword, finalId, row.email);
    const pw = newPassword ? await this.hashPassword(newPassword) : null;
    const changed = await lock('users', async () => {
      const users = await this.users(), me = users.find((u) => u.id === row.id), stamp = new Date(this.now() * 1000).toISOString();
      const out = [];
      if (newUserId && newUserId !== me.userId) {
        if (users.some((u) => u.id !== me.id && u.userId.toLowerCase() === newUserId.toLowerCase())) throw new AuthError('That user ID is already taken.', 409, 'newUserId');
        me.userId = newUserId; me.updatedAt = stamp; out.push('user ID');
      }
      if (pw) { me.pwHash = pw; me.updatedAt = stamp; out.push('password'); }
      await this.s.set('users', users);
      const sessions = (await this.s.get('sessions')) || {};
      Object.keys(sessions).forEach((k) => { if (sessions[k].userId === me.id) delete sessions[k]; });   // every session must sign in again
      await this.s.set('sessions', sessions);
      return out;
    });
    await this.log('credentials_changed', finalId, 'changed: ' + (changed.join(', ') || 'nothing (same user ID)') + '; all sessions ended');
    return changed;
  }

  /* ---------- sessions ---------- */
  async createSession(userPk) {
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const t = this.now();
    await lock('sessions', async () => {
      const all = (await this.s.get('sessions')) || {};
      Object.keys(all).forEach((k) => { if (all[k].expires < t) delete all[k]; });
      all[await sha256Hex(token)] = { userId: userPk, created: t, expires: t + SESSION_IDLE, lastSeen: t };
      await this.s.set('sessions', all);
    });
    return token;
  }

  async userForToken(token) {
    if (!token || token.length > 100) return null;
    const h = await sha256Hex(token), t = this.now();
    return lock('sessions', async () => {
      const all = (await this.s.get('sessions')) || {}, s = all[h];
      if (!s) return null;
      const u = (await this.users()).find((x) => x.id === s.userId);
      if (!u || t > s.expires || t > s.created + SESSION_MAX) { delete all[h]; await this.s.set('sessions', all); return null; }
      if (t - s.lastSeen > 60) { s.lastSeen = t; s.expires = Math.min(s.created + SESSION_MAX, t + SESSION_IDLE); await this.s.set('sessions', all); }
      return { pk: u.id, userId: u.userId, name: u.name };
    });
  }

  async endSession(token) {
    if (!token) return;
    const h = await sha256Hex(token);
    await lock('sessions', async () => { const all = (await this.s.get('sessions')) || {}; delete all[h]; await this.s.set('sessions', all); });
  }
}
