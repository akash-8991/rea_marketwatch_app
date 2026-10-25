/* Option chain: CSV parsing, summary maths, snapshot store and the hash-chained audit log.
 * Port of optiondb.py + options.summarize. Snapshots live in the key-value store; the audit chain uses the exact
 * hash formula of the Python engine (v2), so a chain written by either side verifies on the other. */
import { lock } from './storage.js';

export const MAX_CSV_BYTES = 2_000_000;
export const MAX_STRIKES = 5000;
export const KEEP_SNAPSHOTS = 20;   // per symbol and expiry on the phone (the desktop app keeps 300)
export const SYMBOL_RE = /^[A-Za-z0-9&_-]{1,24}$/;
const EXPIRY_RE = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/;
const FILENAME_RE = /option[-_ ]chain[-_ ](?:ED[-_ ]|EQ[-_ ]|INDICES[-_ ]|EQUITIES[-_ ])?([A-Za-z0-9&]+)[-_ ](\d{1,2})[-_ ]([A-Za-z]{3})[-_ ](\d{4})/i;
const LABELS = { OI: 'oi', 'CHNG IN OI': 'chgOi', VOLUME: 'vol', IV: 'iv', LTP: 'ltp', CHNG: 'chg', BID: 'bid', ASK: 'ask' };
export const LEG_KEYS = ['oi', 'chgOi', 'vol', 'iv', 'ltp', 'chg', 'bid', 'ask'];

export class CsvError extends Error {}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC-4180 style CSV reader (quoted fields, doubled quotes, CRLF). */
export function readCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const num = (v) => {
  const s = String(v ?? '').trim().replace(/,/g, '').replace(/"/g, '');
  if (['', '-', '--', 'NA', 'N/A', 'nan'].includes(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? n : null;
};

export function guessFromFilename(name) {
  const m = FILENAME_RE.exec(name || '');
  if (!m) return [null, null];
  const mon = m[3][0].toUpperCase() + m[3].slice(1).toLowerCase();
  return [m[1].toUpperCase(), `${parseInt(m[2], 10)}-${mon}-${m[4]}`];
}

export function parseCsv(text, filename = '', symbol = null, expiry = null, spot = null) {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) throw new CsvError('file is larger than 2 MB');
  const rows = readCsv(text.replace(/^﻿/, ''));
  const hdr = rows.findIndex((r) => r.some((c) => c.trim().toUpperCase() === 'STRIKE'));
  if (hdr < 0) throw new CsvError("no STRIKE column header found; expected NSE's option-chain CSV (CALLS | STRIKE | PUTS)");
  const header = rows[hdr].map((c) => c.trim().toUpperCase());
  const sIdx = header.indexOf('STRIKE');
  const left = {}, right = {};
  header.forEach((h, i) => { if (LABELS[h]) { if (i < sIdx) left[LABELS[h]] = i; else if (i > sIdx) right[LABELS[h]] = i; } });
  if (!('oi' in left) || !('oi' in right)) throw new CsvError('could not find an OI column on both the calls and puts side');
  const out = new Map();
  for (const r of rows.slice(hdr + 1)) {
    if (r.length <= sIdx) continue;
    const strike = num(r[sIdx]);
    if (!strike || strike <= 0) continue;
    const leg = (cols) => Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, i < r.length ? num(r[i]) : null]));
    out.set(strike, { strike, ce: leg(left), pe: leg(right) });
  }
  if (out.size < 3) throw new CsvError('fewer than 3 strike rows could be read');
  if (out.size > MAX_STRIKES) throw new CsvError('too many strikes');
  const [gs, ge] = guessFromFilename(filename);
  symbol = (symbol || gs || '').toUpperCase(); expiry = expiry || ge || '';
  if (expiry && EXPIRY_RE.test(expiry)) { const [d, m, y] = expiry.split('-'); expiry = `${parseInt(d, 10)}-${m[0].toUpperCase()}${m.slice(1).toLowerCase()}-${y}`; }
  if (!SYMBOL_RE.test(symbol) || !EXPIRY_RE.test(expiry)) throw new CsvError('symbol and expiry could not be determined; name the file like option-chain-ED-NIFTY-27-Oct-2026.csv or enter them');
  return { symbol, expiry, spot, rows: [...out.keys()].sort((a, b) => a - b).map((k) => out.get(k)) };
}

export function summarize(rows, spot) {
  if (!rows.length) return { pcr: null, maxPain: null, atm: null, ceOi: 0, peOi: 0 };
  const oi = (leg) => (leg && leg.oi) || 0;
  const ce = rows.reduce((a, r) => a + oi(r.ce), 0), pe = rows.reduce((a, r) => a + oi(r.pe), 0);
  const strikes = rows.map((r) => r.strike);
  const pain = (k) => rows.reduce((a, r) => a + oi(r.ce) * Math.max(0, k - r.strike) + oi(r.pe) * Math.max(0, r.strike - k), 0);
  let maxPain = null;
  if (ce || pe) maxPain = strikes.reduce((best, s) => (pain(s) < pain(best) ? s : best), strikes[0]);
  const atm = spot ? strikes.reduce((best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]) : null;
  return { pcr: ce ? Math.round((pe / ce) * 1000) / 1000 : null, maxPain, atm, ceOi: ce, peOi: pe };
}

export function estimateSpot(rows) {
  let best = null;
  for (const r of rows) {
    const ce = r.ce && r.ce.ltp, pe = r.pe && r.pe.ltp;
    if (ce == null || pe == null) continue;
    if (best === null || Math.abs(ce - pe) < best[0]) best = [Math.abs(ce - pe), r.strike + ce - pe];
  }
  return best ? Math.round(best[1] * 100) / 100 : null;
}

/* ---------- audit log (hash chain, v2 formula of optiondb._entry_hash) ---------- */
const ZERO = '0'.repeat(64);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
const uuid = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function entryHash(prev, ts, event, actor, symbol, snapshotId, detail, sha, v2) {
  const parts = [prev, ts, event, actor, symbol || '', String(snapshotId || ''), detail, sha || ''];
  if (v2) parts.push('v2', ...v2.map((x) => String(x || '')));
  return sha256Hex(parts.join('|'));
}

export class OptionStore {
  constructor(storage) { this.s = storage; }

  /** Append one audit row. Callers that need atomicity pass their own writes through `during`. */
  audit(event, actor, detail, { symbol = null, snapshotId = null, sha = null, outcome = 'ok', channel = 'app', requestId = null } = {}) {
    return lock('audit', async () => {
      const log = (await this.s.get('audit')) || [];
      const prev = log.length ? log[log.length - 1].entryHash : ZERO;
      const ts = nowIso(), uid = uuid(), d = String(detail).slice(0, 500);
      const h = await entryHash(prev, ts, event, actor, symbol, snapshotId, d, sha, [uid, outcome, requestId, channel]);
      log.push({ id: (log.length ? log[log.length - 1].id : 0) + 1, ts, event, actor, symbol, snapshotId, detail: d, sha256: sha, schemaVer: 2, uid, outcome, requestId, channel, prevHash: prev, entryHash: h });
      await this.s.set('audit', log);
    });
  }

  async safeAudit(...a) { try { await this.audit(...a); return true; } catch (e) { return false; } }

  async auditLog(limit = 50) {
    const log = (await this.s.get('audit')) || [];
    const n = Math.max(1, Math.min(parseInt(limit, 10) || 50, 500));
    return log.slice(-n).reverse().map(({ prevHash, entryHash: eh, ...pub }) => pub);
  }

  async verifyAudit() {
    const log = (await this.s.get('audit')) || [];
    let prev = ZERO;
    for (const r of log) {
      const v2 = r.schemaVer >= 2 ? [r.uid, r.outcome, r.requestId, r.channel] : null;
      if (r.prevHash !== prev || (await entryHash(r.prevHash, r.ts, r.event, r.actor, r.symbol, r.snapshotId, r.detail, r.sha256, v2)) !== r.entryHash) {
        return { ok: false, entries: log.length, firstBadId: r.id };
      }
      prev = r.entryHash;
    }
    return { ok: true, entries: log.length, firstBadId: null };
  }

  /* ---------- snapshots ---------- */
  async store(parsed, source, actor, filename = null, fileSha = null) {
    const { symbol: sym, expiry: exp } = parsed;
    const sha = fileSha || (await sha256Hex(JSON.stringify([sym, exp, parsed.rows])));
    return lock('snapshots', async () => {
      const index = (await this.s.get('snap-index')) || { seq: 0, items: [] };
      const dup = index.items.find((i) => i.sha256 === sha);
      if (dup) { await this.audit('import_duplicate', actor, `${sym} ${exp} from ${source}: identical to snapshot #${dup.id}`, { symbol: sym, snapshotId: dup.id, sha }); return { status: 'duplicate', id: dup.id }; }
      const id = index.seq + 1;
      await this.s.set('snap-rows:' + id, parsed.rows);          // rows first, so a crash leaves no index entry pointing at nothing
      index.seq = id;
      index.items.push({ id, symbol: sym, expiry: exp, source, filename: (filename || '').slice(0, 120) || null, capturedAt: nowIso(), spot: parsed.spot ?? null, sha256: sha, strikes: parsed.rows.length });
      const same = index.items.filter((i) => i.symbol === sym && i.expiry === exp);
      for (const old of same.slice(0, Math.max(0, same.length - KEEP_SNAPSHOTS))) { await this.s.del('snap-rows:' + old.id); index.items = index.items.filter((i) => i.id !== old.id); }
      await this.s.set('snap-index', index);
      await this.audit(source.startsWith('csv') ? 'import_ok' : 'fetch_ok', actor, `${sym} ${exp} from ${source}: ${parsed.rows.length} strikes`, { symbol: sym, snapshotId: id, sha });
      return { status: 'stored', id };
    });
  }

  async importCsv(text, actor, filename = '', symbol = null, expiry = null, spot = null) {
    const sha = await sha256Hex(text);
    let parsed;
    try { parsed = parseCsv(text, filename, symbol, expiry, spot); } catch (e) {
      if (e instanceof CsvError) await this.audit('import_rejected', actor, `${(filename || 'upload').slice(0, 80)}: ${e.message}`, { sha, outcome: 'denied' });
      throw e;
    }
    return this.store(parsed, `csv:${(filename || 'upload').slice(0, 80)}`, actor, filename, sha);
  }

  async latest(symbol, expiry = '') {
    const index = (await this.s.get('snap-index')) || { items: [] };
    const sym = symbol.toUpperCase();
    const mine = index.items.filter((i) => i.symbol === sym && (!expiry || i.expiry === expiry));
    const row = mine[mine.length - 1];
    if (!row) return null;
    const rows = (await this.s.get('snap-rows:' + row.id)) || [];
    const expiries = [...new Set(index.items.filter((i) => i.symbol === sym).map((i) => i.expiry))].sort();
    let spot = row.spot, est = false;
    if (spot == null) { spot = estimateSpot(rows); est = true; }
    return { spot, spotEstimated: est && spot != null, expiries, rows, summary: summarize(rows, spot),
      meta: { source: row.source, filename: row.filename, capturedAt: row.capturedAt, snapshotId: row.id, strikes: row.strikes }, symbol: row.symbol, expiry: row.expiry };
  }

  async symbols() { const i = (await this.s.get('snap-index')) || { items: [] }; return [...new Set(i.items.map((x) => x.symbol))].sort(); }

  async snapshots(limit = 50) {
    const i = (await this.s.get('snap-index')) || { items: [] };
    return i.items.slice(-Math.min(limit, 200)).reverse().map(({ spot, sha256, ...pub }) => pub);
  }
}
