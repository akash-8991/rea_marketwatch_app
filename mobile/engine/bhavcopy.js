/* NSE's end-of-day derivatives file ("UDiFF bhavcopy") as the automatic option-chain source.
 *
 * NSE publishes one zip per trading day at a static archive URL, meant to be downloaded: every option contract with open
 * interest, change in open interest, volume, closing price and the underlying's price. It is end-of-day data (published
 * after the close), not a live chain, and it has no implied volatility. NSE's live option-chain API is protected against
 * automated clients; nothing here touches it, and no browser headers, cookies or challenge scripts are imitated.
 *
 * Pieces: unzip() (ZIP reader on top of DecompressionStream), parseBhavcopy() (CSV -> contracts), candidateDates()
 * (which trading days to try), BhavcopySource (download with a polite cadence). All pure or injected, so tests need no network. */

export const ARCHIVE = 'https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{d}_F_0000.csv.zip';
export const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class BhavcopyError extends Error {}

/** '2026-10-27' -> '27-Oct-2026' (the expiry format the rest of the app uses). */
export const expiryLabel = (iso) => { const [y, m, d] = iso.split('-'); return `${parseInt(d, 10)}-${MON[parseInt(m, 10) - 1]}-${y}`; };

/* ---------- ZIP (first entry) ---------- */
export async function unzip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new BhavcopyError('not a zip file');
  const cd = v.getUint32(eocd + 16, true);
  if (v.getUint32(cd, true) !== 0x02014b50) throw new BhavcopyError('zip directory is damaged');
  const method = v.getUint16(cd + 10, true), csize = v.getUint32(cd + 20, true), usize = v.getUint32(cd + 24, true), local = v.getUint32(cd + 42, true);
  if (usize > 60_000_000) throw new BhavcopyError('file is unexpectedly large');
  if (v.getUint32(local, true) !== 0x04034b50) throw new BhavcopyError('zip entry is damaged');
  const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
  const data = bytes.subarray(start, start + csize);
  if (method === 0) return data;
  if (method !== 8) throw new BhavcopyError('unsupported zip compression');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ---------- CSV -> contracts ---------- */
const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : null; };

/** Returns {tradeDate, symbols: {SYMBOL: {kind, spot, expiries: {'YYYY-MM-DD': [{strike, ce, pe}]}}}} for index (IDO) and stock (STO) options. */
export function parseBhavcopy(text) {
  const lines = text.split(/\r?\n/);
  const head = (lines.shift() || '').split(',').map((h) => h.trim());
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const need of ['TradDt', 'FinInstrmTp', 'TckrSymb', 'XpryDt', 'StrkPric', 'OptnTp', 'ClsPric', 'PrvsClsgPric', 'UndrlygPric', 'OpnIntrst', 'ChngInOpnIntrst', 'TtlTradgVol']) {
    if (!(need in col)) throw new BhavcopyError(`column ${need} missing: NSE may have changed the file layout`);
  }
  const symbols = {}; let tradeDate = null, n = 0;
  for (const line of lines) {
    if (!line) continue;
    const f = line.split(',');
    const tp = f[col.FinInstrmTp];
    if (tp !== 'IDO' && tp !== 'STO') continue;
    const side = f[col.OptnTp] === 'CE' ? 'ce' : f[col.OptnTp] === 'PE' ? 'pe' : null, strike = num(f[col.StrkPric]);
    if (!side || !strike) continue;
    tradeDate ||= f[col.TradDt];
    const sym = f[col.TckrSymb], exp = f[col.XpryDt];
    const s = (symbols[sym] ||= { kind: tp === 'IDO' ? 'index' : 'stock', spot: num(f[col.UndrlygPric]), expiries: {} });
    const rowsByStrike = (s.expiries[exp] ||= new Map());
    const close = num(f[col.ClsPric]), prev = num(f[col.PrvsClsgPric]);
    const leg = { oi: num(f[col.OpnIntrst]), chgOi: num(f[col.ChngInOpnIntrst]), vol: num(f[col.TtlTradgVol]), iv: null, ltp: close,
      chg: close != null && prev != null ? Math.round((close - prev) * 100) / 100 : null, bid: null, ask: null };
    const row = rowsByStrike.get(strike) || { strike, ce: null, pe: null };
    row[side] = leg; rowsByStrike.set(strike, row); n++;
  }
  if (!n) throw new BhavcopyError('no option contracts found in the file');
  for (const s of Object.values(symbols)) for (const [e, m] of Object.entries(s.expiries)) s.expiries[e] = [...m.values()].sort((a, b) => a.strike - b.strike);
  return { tradeDate, symbols };
}

/* ---------- which days to try ---------- */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** Weekdays, newest first, strictly after `known` (ISO date or null). Today counts only after about 18:30 India time, when NSE has
 * published the file. Holidays simply answer 404 and are skipped by the caller. */
export function candidateDates(nowMs, known = null, days = 7) {
  const ist = new Date(nowMs + 5.5 * 3600 * 1000), out = [];
  const afterClose = ist.getUTCHours() * 60 + ist.getUTCMinutes() >= 18 * 60 + 30;
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - i));
    if (i === 0 && !afterClose) continue;
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const iso = ymd(d);
    if (known && iso <= known) break;
    out.push(iso);
  }
  return out;
}

/* ---------- download ---------- */
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export class BhavcopySource {
  /** fetchBinary(url) -> {status, bytes}. The default uses Capacitor's native HTTP when running in the app (no CORS rule applies
   * there) and the browser's fetch otherwise. */
  constructor({ fetchBinary = defaultFetchBinary, now = () => Date.now() } = {}) { this.fetchBinary = fetchBinary; this.now = now; }

  /** Newest file after `known`, parsed, or null when none is published yet. Tries at most 7 days back, newest first. */
  async fetchLatest(known = null) {
    for (const d of candidateDates(this.now(), known)) {
      const r = await this.fetchBinary(ARCHIVE.replace('{d}', d.replaceAll('-', '')));
      if (r.status === 404) continue;                       // holiday, or not published yet
      if (r.status !== 200) throw new BhavcopyError(`NSE archive answered HTTP ${r.status}`);
      const parsed = parseBhavcopy(new TextDecoder().decode(await unzip(r.bytes)));
      return parsed;
    }
    return null;
  }
}

export async function defaultFetchBinary(url) {
  const http = globalThis.Capacitor?.Plugins?.CapacitorHttp;
  if (http) {
    const r = await http.request({ url, method: 'GET', responseType: 'blob', headers: { Accept: 'application/zip' }, connectTimeout: 20000, readTimeout: 60000 });
    return { status: r.status, bytes: r.status === 200 ? b64(r.data) : new Uint8Array() };
  }
  const r = await fetch(url, { headers: { Accept: 'application/zip' } });
  return { status: r.status, bytes: r.status === 200 ? new Uint8Array(await r.arrayBuffer()) : new Uint8Array() };
}
