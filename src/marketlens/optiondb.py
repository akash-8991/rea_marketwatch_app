"""Option-chain store on SQLite (public-domain, in the Python standard library) with an append-only audit log.

Snapshots come from two lawful sources only: CSV files that a person downloaded from NSE's option-chain page
(dropped into the inbox folder or uploaded), and an HTTP MCP endpoint the user configures. Nothing here fetches
nseindia.com. Every import, rejection, duplicate and fetch is written to `audit_log`, which is append-only
(triggers block UPDATE/DELETE) and hash-chained so edits made outside the app are detectable with `verify_audit`.
"""
import csv
import datetime
import hashlib
import io
import json
import os
import re
import sqlite3
import sys
import threading
import uuid

from .config import settings

MAX_CSV_BYTES = 2_000_000
MAX_STRIKES = 5000
KEEP_SNAPSHOTS = 300  # per symbol and expiry
SYMBOL_RE = re.compile(r"^[A-Za-z0-9&_-]{1,24}$")
EXPIRY_RE = re.compile(r"^\d{1,2}-[A-Za-z]{3}-\d{4}$")
FILENAME_RE = re.compile(r"option[-_ ]chain[-_ ](?:ED[-_ ]|EQ[-_ ]|INDICES[-_ ]|EQUITIES[-_ ])?([A-Za-z0-9&]+)[-_ ](\d{1,2})[-_ ]([A-Za-z]{3})[-_ ](\d{4})", re.I)
LABELS = {"OI": "oi", "CHNG IN OI": "chgOi", "VOLUME": "vol", "IV": "iv", "LTP": "ltp", "CHNG": "chg", "BID": "bid", "ASK": "ask"}
LEG_KEYS = ("oi", "chgOi", "vol", "iv", "ltp", "chg", "bid", "ask")

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, expiry TEXT NOT NULL, source TEXT NOT NULL, filename TEXT,
  captured_at TEXT NOT NULL, spot REAL, sha256 TEXT NOT NULL UNIQUE, strikes INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS snap_lookup ON snapshots(symbol, expiry, captured_at);
CREATE TABLE IF NOT EXISTS option_rows (
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, strike REAL NOT NULL, side TEXT NOT NULL CHECK (side IN ('CE','PE')),
  oi REAL, chg_oi REAL, vol REAL, iv REAL, ltp REAL, chg REAL, bid REAL, ask REAL, PRIMARY KEY (snapshot_id, strike, side));
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL, event TEXT NOT NULL, actor TEXT NOT NULL, symbol TEXT, snapshot_id INTEGER,
  detail TEXT NOT NULL, sha256 TEXT, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL,
  schema_ver INTEGER NOT NULL DEFAULT 2, uid TEXT, outcome TEXT NOT NULL DEFAULT 'ok', request_id TEXT, channel TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
"""

_lock = threading.RLock()
_state = {"conn": None, "path": None}
ctx = threading.local()  # per-request context set by the HTTP server: ctx.request_id, ctx.channel
V2_COLUMNS = (("schema_ver", "INTEGER NOT NULL DEFAULT 1"), ("uid", "TEXT"), ("outcome", "TEXT NOT NULL DEFAULT 'ok'"), ("request_id", "TEXT"), ("channel", "TEXT"))


class CsvError(ValueError):
    """The CSV could not be understood; the message is safe to show to the user."""


def db_path():
    return os.path.join(str(settings.data_dir), "marketlens.db")


def _db():
    with _lock:
        path = db_path()
        if _state["conn"] is None or _state["path"] != path:
            if _state["conn"] is not None:
                _state["conn"].close()
            os.makedirs(str(settings.data_dir), exist_ok=True)
            c = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
            try:
                os.chmod(path, 0o600)   # accounts and personal details: readable by the owner only (no effect on Windows)
            except OSError:
                pass
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA foreign_keys=ON")
            c.executescript(SCHEMA)
            _migrate(c)
            _state["conn"], _state["path"] = c, path
        return _state["conn"]


def _migrate(c):
    """Bring an older database up to date. Rows written before v2 keep schema_ver=1 and their original hash formula."""
    have = {r[1] for r in c.execute("PRAGMA table_info(audit_log)")}
    for name, decl in V2_COLUMNS:
        if name not in have:
            c.execute(f"ALTER TABLE audit_log ADD COLUMN {name} {decl}")


def close():
    with _lock:
        if _state["conn"] is not None:
            _state["conn"].close()
        _state["conn"] = _state["path"] = None


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


# ---------- audit log ----------
def _entry_hash(prev, ts, event, actor, symbol, snapshot_id, detail, sha, v2=None):
    """v1 (no `v2`): original formula, kept so old rows still verify. v2: also covers uid, outcome, request id, channel."""
    parts = [prev, ts, event, actor, symbol or "", str(snapshot_id or ""), detail, sha or ""]
    if v2 is not None:
        parts += ["v2", *(str(x or "") for x in v2)]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def _audit_row(c, event, actor, detail, symbol=None, snapshot_id=None, sha=None, outcome="ok", channel=None, request_id=None):
    """Append one audit row on connection `c` without managing a transaction (callers couple it to their own)."""
    row = c.execute("SELECT entry_hash FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()
    prev, ts, detail = (row[0] if row else "0" * 64), _now(), str(detail)[:500]
    uid = uuid.uuid4().hex
    request_id = request_id or getattr(ctx, "request_id", None)
    channel = channel or getattr(ctx, "channel", None) or "internal"
    h = _entry_hash(prev, ts, event, actor, symbol, snapshot_id, detail, sha, (uid, outcome, request_id, channel))
    c.execute("INSERT INTO audit_log (ts, event, actor, symbol, snapshot_id, detail, sha256, prev_hash, entry_hash, schema_ver, uid, outcome, request_id, channel) "
              "VALUES (?,?,?,?,?,?,?,?,?,2,?,?,?,?)", (ts, event, actor, symbol, snapshot_id, detail, sha, prev, h, uid, outcome, request_id, channel))


def audit(event, actor, detail, symbol=None, snapshot_id=None, sha=None, outcome="ok", channel=None, request_id=None):
    with _lock:
        _audit_row(_db(), event, actor, detail, symbol, snapshot_id, sha, outcome, channel, request_id)


def safe_audit(*args, **kw):
    """For non-critical events: a failed audit write is reported on stderr (operational alert) instead of breaking the caller."""
    try:
        audit(*args, **kw)
        return True
    except Exception as e:
        sys.stderr.write(json.dumps({"level": "error", "msg": "audit_write_failed", "event": args[0] if args else None, "error": e.__class__.__name__}) + "\n")
        return False


FIELDS = ("id", "ts", "event", "actor", "symbol", "snapshot_id", "detail", "sha256", "schema_ver", "uid", "outcome", "request_id", "channel")


def audit_log(limit=50):
    with _lock:
        rows = _db().execute(f"SELECT {', '.join(FIELDS)} FROM audit_log ORDER BY id DESC LIMIT ?", (max(1, min(int(limit), 500)),)).fetchall()
    return [dict(zip(("id", "ts", "event", "actor", "symbol", "snapshotId", "detail", "sha256", "schemaVer", "uid", "outcome", "requestId", "channel"), r)) for r in rows]


def verify_audit():
    """Recompute the hash chain. A broken chain means rows were edited or removed outside the app."""
    with _lock:
        rows = _db().execute("SELECT id, ts, event, actor, symbol, snapshot_id, detail, sha256, prev_hash, entry_hash, schema_ver, uid, outcome, request_id, channel FROM audit_log ORDER BY id").fetchall()
    prev = "0" * 64
    for r in rows:
        id_, ts, event, actor, symbol, snap, detail, sha, p, h, ver, uid, outcome, rid, channel = r
        v2 = (uid, outcome, rid, channel) if ver and ver >= 2 else None
        if p != prev or _entry_hash(p, ts, event, actor, symbol, snap, detail, sha, v2) != h:
            return {"ok": False, "entries": len(rows), "firstBadId": id_}
        prev = h
    return {"ok": True, "entries": len(rows), "firstBadId": None}


# ---------- CSV parsing (layout of NSE's option-chain download: CALLS | STRIKE | PUTS) ----------
def _num(v):
    v = (v or "").strip().replace(",", "").replace('"', "")
    if v in ("", "-", "--", "NA", "N/A", "nan"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def guess_from_filename(name):
    m = FILENAME_RE.search(name or "")
    if not m:
        return None, None
    return m.group(1).upper(), f"{int(m.group(2))}-{m.group(3).capitalize()}-{m.group(4)}"


def parse_csv(text, filename="", symbol=None, expiry=None, spot=None):
    """Parse an NSE-style option-chain CSV into {symbol, expiry, spot, rows}; raises CsvError with a clear reason."""
    if len(text.encode("utf-8", "ignore")) > MAX_CSV_BYTES:
        raise CsvError("file is larger than 2 MB")
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    hdr = next((i for i, r in enumerate(rows) if any(c.strip().upper() == "STRIKE" for c in r)), None)
    if hdr is None:
        raise CsvError("no STRIKE column header found; expected NSE's option-chain CSV (CALLS | STRIKE | PUTS)")
    header = [c.strip().upper() for c in rows[hdr]]
    s_idx = header.index("STRIKE")
    left = {LABELS[h]: i for i, h in enumerate(header[:s_idx]) if h in LABELS}
    right = {LABELS[h]: i for i, h in enumerate(header) if i > s_idx and h in LABELS}
    if "oi" not in left or "oi" not in right:
        raise CsvError("could not find an OI column on both the calls and puts side")
    out = {}
    for r in rows[hdr + 1:]:
        if len(r) <= s_idx:
            continue
        strike = _num(r[s_idx])
        if not strike or strike <= 0:
            continue
        out[strike] = {"strike": strike,
                       "ce": {k: _num(r[i]) if i < len(r) else None for k, i in left.items()},
                       "pe": {k: _num(r[i]) if i < len(r) else None for k, i in right.items()}}
    if len(out) < 3:
        raise CsvError("fewer than 3 strike rows could be read")
    if len(out) > MAX_STRIKES:
        raise CsvError("too many strikes")
    g_sym, g_exp = guess_from_filename(filename)
    symbol, expiry = (symbol or g_sym or "").upper(), (expiry or g_exp or "")
    if expiry and EXPIRY_RE.match(expiry):
        d, m, y = expiry.split("-")
        expiry = f"{int(d)}-{m.capitalize()}-{y}"
    if not SYMBOL_RE.match(symbol) or not EXPIRY_RE.match(expiry):
        raise CsvError("symbol and expiry could not be determined; name the file like option-chain-ED-NIFTY-27-Oct-2026.csv or enter them")
    return {"symbol": symbol, "expiry": expiry, "spot": spot, "rows": [out[k] for k in sorted(out)]}


# ---------- storing and reading snapshots ----------
def _sha(rows, symbol, expiry):
    return hashlib.sha256(json.dumps([symbol, expiry, rows], sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def store(parsed, source, actor, filename=None, file_sha=None):
    """Save one snapshot. Returns {'status': 'stored'|'duplicate', 'id': ...}. Identical data is stored once."""
    sym, exp = parsed["symbol"], parsed["expiry"]
    sha = file_sha or _sha(parsed["rows"], sym, exp)
    with _lock:
        c = _db()
        dup = c.execute("SELECT id FROM snapshots WHERE sha256=?", (sha,)).fetchone()
        if dup:
            audit("import_duplicate", actor, f"{sym} {exp} from {source}: identical to snapshot #{dup[0]}", sym, dup[0], sha)
            return {"status": "duplicate", "id": dup[0]}
        c.execute("BEGIN")
        try:
            cur = c.execute("INSERT INTO snapshots (symbol, expiry, source, filename, captured_at, spot, sha256, strikes) VALUES (?,?,?,?,?,?,?,?)",
                            (sym, exp, source, (filename or "")[:120] or None, _now(), parsed.get("spot"), sha, len(parsed["rows"])))
            sid = cur.lastrowid
            for r in parsed["rows"]:
                for side, key in (("CE", "ce"), ("PE", "pe")):
                    leg = r.get(key)
                    if leg:
                        c.execute("INSERT INTO option_rows VALUES (?,?,?,?,?,?,?,?,?,?,?)", (sid, r["strike"], side, *(leg.get(k) for k in LEG_KEYS)))
            # the audit row commits in the same transaction: an import can never succeed without its audit record
            _audit_row(c, "import_ok" if source.startswith("csv") else "fetch_ok", actor, f"{sym} {exp} from {source}: {len(parsed['rows'])} strikes", sym, sid, sha)
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        c.execute("DELETE FROM snapshots WHERE symbol=? AND expiry=? AND id NOT IN (SELECT id FROM snapshots WHERE symbol=? AND expiry=? ORDER BY id DESC LIMIT ?)",
                  (sym, exp, sym, exp, KEEP_SNAPSHOTS))
        return {"status": "stored", "id": sid}


def import_csv(text, actor, filename="", symbol=None, expiry=None, spot=None):
    """Parse and store a CSV; every outcome (stored, duplicate, rejected) is audit-logged."""
    sha = hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest()
    try:
        parsed = parse_csv(text, filename, symbol, expiry, spot)
    except CsvError as e:
        audit("import_rejected", actor, f"{(filename or 'upload')[:80]}: {e}", sha=sha)
        raise
    return store(parsed, f"csv:{(filename or 'upload')[:80]}", actor, filename, file_sha=sha)


def _from_db(row, rows):
    legs = {}
    for strike, side, *vals in rows:
        legs.setdefault(strike, {"strike": strike, "ce": None, "pe": None})["ce" if side == "CE" else "pe"] = dict(zip(LEG_KEYS, vals))
    return [legs[k] for k in sorted(legs)]


def latest(symbol, expiry=""):
    """Most recent snapshot for a symbol (and expiry, or the soonest-captured one), as normalised chain data."""
    from . import options  # local import: options imports this module lazily too
    with _lock:
        c = _db()
        q, args = "SELECT id, symbol, expiry, source, filename, captured_at, spot, strikes FROM snapshots WHERE symbol=?", [symbol.upper()]
        if expiry:
            q += " AND expiry=?"
            args.append(expiry)
        row = c.execute(q + " ORDER BY id DESC LIMIT 1", args).fetchone()
        if not row:
            return None
        rows = _from_db(row, c.execute("SELECT strike, side, oi, chg_oi, vol, iv, ltp, chg, bid, ask FROM option_rows WHERE snapshot_id=?", (row[0],)).fetchall())
        expiries = [r[0] for r in c.execute("SELECT DISTINCT expiry FROM snapshots WHERE symbol=? ORDER BY expiry", (symbol.upper(),))]
    spot, est = row[6], False
    if spot is None:
        spot, est = estimate_spot(rows), True
    return {"spot": spot, "spotEstimated": est and spot is not None, "expiries": expiries, "rows": rows, "summary": options.summarize(rows, spot),
            "meta": {"source": row[3], "filename": row[4], "capturedAt": row[5], "snapshotId": row[0], "strikes": row[7]},
            "symbol": row[1], "expiry": row[2]}


def estimate_spot(rows):
    """Put-call parity at the strike where call and put prices are closest: spot ~ strike + call - put."""
    best = None
    for r in rows:
        ce, pe = (r["ce"] or {}).get("ltp"), (r["pe"] or {}).get("ltp")
        if ce is None or pe is None:
            continue
        if best is None or abs(ce - pe) < best[0]:
            best = (abs(ce - pe), r["strike"] + ce - pe)
    return round(best[1], 2) if best else None


def symbols():
    with _lock:
        return [r[0] for r in _db().execute("SELECT DISTINCT symbol FROM snapshots ORDER BY symbol")]


def snapshots(symbol=None, limit=50):
    with _lock:
        q, args = "SELECT id, symbol, expiry, source, filename, captured_at, strikes FROM snapshots", []
        if symbol:
            q, args = q + " WHERE symbol=?", [symbol.upper()]
        rows = _db().execute(q + " ORDER BY id DESC LIMIT ?", args + [max(1, min(int(limit), 200))]).fetchall()
    return [dict(zip(("id", "symbol", "expiry", "source", "filename", "capturedAt", "strikes"), r)) for r in rows]
