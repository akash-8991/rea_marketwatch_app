"""Local user accounts on SQLite (same database file as the option-chain data).

What is stored: user ID, name, email, date of birth, and a **salted PBKDF2-SHA256 hash** of the password (never the
password itself). Sessions store only a SHA-256 of the random token. Everything is written to the audit log without
passwords, tokens or the personal fields.

Recovery by name + email + date of birth is weak by nature (anyone who knows all three can take over the account, and
no mail server verifies the address). It is throttled per email (lockout with exponential back-off), gives one generic
failure message regardless of which field was wrong, and ends every session when credentials change. The machine owner
can always reset a password from the command line (`marketlens --reset-password USERID`).
"""
import datetime
import getpass
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
import unicodedata

from . import optiondb
from .config import settings

SESSION_IDLE = 12 * 3600          # a session ends after 12 h without use...
SESSION_MAX = 7 * 24 * 3600       # ...and never lasts more than 7 days
LOCK_AFTER = 5                    # consecutive failures before a lockout
LOCK_BASE = 15 * 60               # first lockout; doubles each time, up to LOCK_MAX
LOCK_MAX = 24 * 3600
USER_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{4,32}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s.]{2,}$")
NAME_RE = re.compile(r"^[^\W\d_][\w .'\-]{1,79}$", re.UNICODE)
COMMON = frozenset("""password password1 password12 password123 passw0rd p@ssw0rd 123456 1234567 12345678 123456789 1234567890 0123456789
qwerty qwerty123 qwertyuiop asdfghjkl zxcvbnm abc123 abcd1234 iloveyou admin administrator welcome welcome1 letmein monkey dragon
football baseball master login princess sunshine trustno1 111111 000000 123123 654321 superman michael shadow freedom whatever
changeme secret default marketlens nifty sensex stockmarket""".split())

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, user_id TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  dob TEXT NOT NULL, pw_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_pk INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created REAL NOT NULL, expires REAL NOT NULL, last_seen REAL NOT NULL);
CREATE TABLE IF NOT EXISTS throttle (key TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, locked_until REAL NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0);
"""

now = time.time        # replaced in tests
_ready = {"conn": None}
_dummy = {}


class AuthError(Exception):
    """A failure whose message is safe to show to the user. `status` is the HTTP status; `retry_after` seconds if locked."""
    def __init__(self, message, status=400, field=None, retry_after=None):
        super().__init__(message)
        self.status, self.field, self.retry_after = status, field, retry_after


# ---------- storage ----------
def _conn():
    c = optiondb._db()
    if _ready["conn"] is not c:
        c.executescript(SCHEMA)
        _ready["conn"] = c
    return c


def _sha(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _log(event, actor, detail, outcome="ok", channel=None):
    optiondb.safe_audit(event, actor if USER_ID_RE.match(actor or "") else "anonymous", detail, outcome=outcome, channel=channel)


# ---------- passwords ----------
def hash_password(password, salt=None, iterations=None):
    iterations = iterations or settings.pbkdf2_iterations
    salt = salt or os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${dk.hex()}"


def verify_password(password, stored):
    try:
        algo, iters, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, AttributeError):
        return False


def _dummy_hash():
    """A hash to verify against when the user does not exist, so unknown and known users take the same time."""
    key = settings.pbkdf2_iterations
    if key not in _dummy:
        _dummy[key] = hash_password("not-a-real-password", b"\x00" * 16, key)
    return _dummy[key]


def check_password(password, user_id="", email=""):
    if not isinstance(password, str) or not 10 <= len(password) <= 128:
        raise AuthError("Password must be 10 to 128 characters.", field="password")
    low = password.lower()
    if low in COMMON or low.strip("0123456789") in COMMON:
        raise AuthError("That password is too common. Choose something less guessable.", field="password")
    if len(set(password)) < 5:
        raise AuthError("Password uses too few different characters.", field="password")
    if user_id and len(user_id) >= 4 and user_id.lower() in low:
        raise AuthError("Password must not contain your user ID.", field="password")
    local = email.split("@")[0].lower() if email else ""
    if len(local) >= 4 and local in low:
        raise AuthError("Password must not contain your email name.", field="password")


# ---------- field validation and normalisation ----------
def norm_name(s):
    return " ".join(unicodedata.normalize("NFKC", s or "").casefold().split())


def norm_email(s):
    return (s or "").strip().lower()


def clean_name(s):
    s = " ".join(unicodedata.normalize("NFKC", s or "").split())
    if not NAME_RE.match(s):
        raise AuthError("Enter your name (2 to 80 letters; spaces, apostrophes, dots and hyphens are fine).", field="name")
    return s


def clean_email(s):
    s = norm_email(s)
    if len(s) > 254 or not EMAIL_RE.match(s):
        raise AuthError("Enter a valid email address.", field="email")
    return s


def clean_dob(s):
    try:
        d = datetime.date.fromisoformat((s or "").strip())
    except ValueError:
        raise AuthError("Enter your date of birth as a valid date.", field="dob")
    if d > datetime.date.fromtimestamp(now()) or d.year < 1900:
        raise AuthError("Date of birth must be between 1900 and today.", field="dob")
    return d.isoformat()


def clean_user_id(s):
    s = (s or "").strip()
    if not USER_ID_RE.match(s):
        raise AuthError("User ID must be 4 to 32 characters: letters, digits, dot, dash or underscore.", field="userId")
    return s


# ---------- throttling: lockout with exponential back-off, keyed by hashed identifier (works for unknown accounts too) ----------
def _check_lock(c, key):
    row = c.execute("SELECT locked_until FROM throttle WHERE key=?", (key,)).fetchone()
    if row and row[0] > now():
        wait = int(row[0] - now()) + 1
        raise AuthError(f"Too many failed attempts. Try again in about {max(1, round(wait / 60))} min.", 429, retry_after=wait)


def _fail(c, key):
    row = c.execute("SELECT fails, level FROM throttle WHERE key=?", (key,)).fetchone()
    fails, level = (row[0] + 1, row[1]) if row else (1, 0)
    locked = 0.0
    if fails >= LOCK_AFTER:
        level += 1
        locked, fails = now() + min(LOCK_BASE * 2 ** (level - 1), LOCK_MAX), 0
    c.execute("INSERT INTO throttle (key, fails, locked_until, level) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET fails=?, locked_until=?, level=?",
              (key, fails, locked, level, fails, locked, level))
    return bool(locked)


def _clear(c, key):
    c.execute("DELETE FROM throttle WHERE key=?", (key,))


# ---------- accounts ----------
def user_count():
    with optiondb._lock:
        return _conn().execute("SELECT COUNT(*) FROM users").fetchone()[0]


def _public(row):
    return {"userId": row[1], "name": row[2]}


def signup(name, email, dob, user_id, password):
    name, email, dob, user_id = clean_name(name), clean_email(email), clean_dob(dob), clean_user_id(user_id)
    check_password(password, user_id, email)
    stamp = datetime.datetime.fromtimestamp(now(), datetime.timezone.utc).isoformat(timespec="seconds")
    pw = hash_password(password)           # the slow step happens before the lock is taken
    with optiondb._lock:
        c = _conn()
        try:
            cur = c.execute("INSERT INTO users (user_id, name, email, dob, pw_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", (user_id, name, email, dob, pw, stamp, stamp))
        except sqlite3.IntegrityError:
            _log("signup_failed", user_id, "user ID or email already registered", "denied")
            raise AuthError("That user ID or email is already registered.", 409)
        row = c.execute("SELECT id, user_id, name FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    _log("signup_ok", user_id, "account created")
    return row


def login(user_id, password):
    uid = (user_id or "").strip()[:64]
    key = "login:" + _sha(uid.lower())
    with optiondb._lock:
        c = _conn()
        _check_lock(c, key)
        row = c.execute("SELECT id, user_id, name, pw_hash FROM users WHERE user_id=?", (uid,)).fetchone()
    ok = verify_password(password if isinstance(password, str) else "", row[3] if row else _dummy_hash()) and row is not None
    with optiondb._lock:
        c = _conn()
        if not ok:
            locked = _fail(c, key)
            _log("login_failed", uid, "incorrect user ID or password" + ("; locked out" if locked else ""), "denied")
            raise AuthError("Incorrect user ID or password.", 401)
        _clear(c, key)
        stamp = datetime.datetime.fromtimestamp(now(), datetime.timezone.utc).isoformat(timespec="seconds")
        c.execute("UPDATE users SET last_login=? WHERE id=?", (stamp, row[0]))
    _log("login_ok", row[1], "signed in")
    return row[:3]


def _verify_identity(name, email, dob):
    """Return the user row only if name, email and date of birth all match. One generic failure otherwise, and throttled."""
    email_n = norm_email(email)[:254]
    key = "identity:" + _sha(email_n)
    with optiondb._lock:
        c = _conn()
        _check_lock(c, key)
        row = c.execute("SELECT id, user_id, name, email, dob FROM users WHERE email=?", (email_n,)).fetchone()
    stored = row or (0, "", "", "", "")
    # compare all three every time (no early exit), in constant time
    a = hmac.compare_digest(norm_name(name).encode(), norm_name(stored[2]).encode())
    b = hmac.compare_digest(email_n.encode(), norm_email(stored[3]).encode())
    d = hmac.compare_digest((dob or "").strip().encode(), stored[4].encode())
    ok = bool(row) and a and b and d
    with optiondb._lock:
        c = _conn()
        if not ok:
            locked = _fail(c, key)
            _log("identity_check_failed", "anonymous", "name, email and date of birth did not match" + ("; locked out" if locked else ""), "denied")
            raise AuthError("The details do not match our records.", 403)
        _clear(c, key)
    return row


def forgot_user_id(name, email, dob):
    row = _verify_identity(name, email, dob)
    _log("user_id_recovered", row[1], "user ID shown after identity check")
    return row[1]


def update_credentials(name, email, dob, new_user_id=None, new_password=None):
    """Change user ID and/or password, but only if name, email and date of birth all match."""
    new_user_id = (new_user_id or "").strip() or None
    if not new_user_id and not new_password:
        raise AuthError("Enter a new user ID, a new password, or both.", field="newPassword")
    if new_user_id:
        new_user_id = clean_user_id(new_user_id)
    row = _verify_identity(name, email, dob)
    final_id = new_user_id or row[1]
    if new_password:
        check_password(new_password, final_id, row[3])
    pw = hash_password(new_password) if new_password else None
    changed = []
    with optiondb._lock:
        c = _conn()
        stamp = datetime.datetime.fromtimestamp(now(), datetime.timezone.utc).isoformat(timespec="seconds")
        try:
            c.execute("BEGIN")
            if new_user_id and new_user_id != row[1]:
                c.execute("UPDATE users SET user_id=?, updated_at=? WHERE id=?", (new_user_id, stamp, row[0]))
                changed.append("user ID")
            if pw:
                c.execute("UPDATE users SET pw_hash=?, updated_at=? WHERE id=?", (pw, stamp, row[0]))
                changed.append("password")
            c.execute("DELETE FROM sessions WHERE user_pk=?", (row[0],))     # every device must sign in again
            c.execute("COMMIT")
        except sqlite3.IntegrityError:
            c.execute("ROLLBACK")
            raise AuthError("That user ID is already taken.", 409, field="newUserId")
        except Exception:
            c.execute("ROLLBACK")
            raise
    _log("credentials_changed", final_id, "changed: " + (", ".join(changed) or "nothing (same user ID)") + "; all sessions ended")
    return changed


# ---------- sessions ----------
def create_session(user_pk):
    token = secrets.token_urlsafe(32)
    t = now()
    with optiondb._lock:
        c = _conn()
        c.execute("DELETE FROM sessions WHERE expires < ?", (t,))
        c.execute("INSERT INTO sessions (token_hash, user_pk, created, expires, last_seen) VALUES (?,?,?,?,?)", (_sha(token), user_pk, t, t + SESSION_IDLE, t))
    return token


def user_for_token(token):
    if not token or len(token) > 100:
        return None
    t = now()
    with optiondb._lock:
        c = _conn()
        row = c.execute("SELECT s.created, s.expires, s.last_seen, u.id, u.user_id, u.name FROM sessions s JOIN users u ON u.id=s.user_pk WHERE s.token_hash=?", (_sha(token),)).fetchone()
        if not row:
            return None
        created, expires, last_seen, uid, user_id, name = row
        if t > expires or t > created + SESSION_MAX:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (_sha(token),))
            return None
        if t - last_seen > 60:   # slide the idle window, but write at most once a minute
            c.execute("UPDATE sessions SET last_seen=?, expires=? WHERE token_hash=?", (t, min(created + SESSION_MAX, t + SESSION_IDLE), _sha(token)))
    return {"pk": uid, "userId": user_id, "name": name}


def end_session(token):
    if token:
        with optiondb._lock:
            _conn().execute("DELETE FROM sessions WHERE token_hash=?", (_sha(token),))


# ---------- command-line administration for the machine owner ----------
def list_users():
    with optiondb._lock:
        return [{"userId": r[0], "name": r[1], "created": r[2], "lastLogin": r[3]} for r in _conn().execute("SELECT user_id, name, created_at, last_login FROM users ORDER BY id")]


def admin_reset_password(user_id, new_password):
    with optiondb._lock:
        c = _conn()
        row = c.execute("SELECT id, user_id, email FROM users WHERE user_id=?", (user_id,)).fetchone()
    if not row:
        raise AuthError("No such user.", 404)
    check_password(new_password, row[1], row[2])
    pw = hash_password(new_password)
    with optiondb._lock:
        c = _conn()
        c.execute("UPDATE users SET pw_hash=?, updated_at=? WHERE id=?", (pw, datetime.datetime.fromtimestamp(now(), datetime.timezone.utc).isoformat(timespec="seconds"), row[0]))
        c.execute("DELETE FROM sessions WHERE user_pk=?", (row[0],))
        c.execute("DELETE FROM throttle WHERE key=?", ("login:" + _sha(row[1].lower()),))
    optiondb.safe_audit("password_reset_admin", row[1], "reset from the command line on the machine; all sessions ended", channel="cli")


def prompt_new_password():
    a, b = getpass.getpass("New password: "), getpass.getpass("Repeat it: ")
    if a != b:
        raise AuthError("The two passwords do not match.")
    return a
