/* Automatic option chain: keeps the newest end-of-day derivatives file and turns it into saved snapshots on demand.
 *
 * Design: a small service with one job (freshness policy), behind the same interface the rest of the engine already uses.
 *   - source  : anything with fetchLatest(knownTradeDate) -> parsed | null   (BhavcopySource, or a fake in tests)
 *   - store   : OptionStore (snapshots + hash-chained audit)
 *   - policy  : check for a newer file at most every COOLDOWN, never run two checks at once, and ALWAYS answer from what is
 *               saved if the network fails, so the screen never waits on a retry loop it cannot win.
 * Only the symbols a person actually opens are written to storage (a day's file holds ~200 underlyings); the parsed file is kept in
 * memory for a while so switching symbols does not download anything again. */
import { INDEX_SYMBOLS, expiryLabel } from './bhavcopy.js';

export const SOURCE = 'nse-fo-bhavcopy';
const COOLDOWN_MS = 20 * 60 * 1000, KEEP_PARSED_MS = 30 * 60 * 1000, MAX_EXPIRIES = 8;

export class OptionFeed {
  constructor({ source, store, now = () => Date.now() }) {
    Object.assign(this, { source, store, now });
    this.s = { lastCheck: 0, lastOk: null, result: 'not checked yet', tradeDate: null, parsed: null, parsedAt: 0, inflight: null };
  }

  status() {
    return { source: 'NSE end-of-day derivatives file (published after the close; not live)', tradeDate: this.s.tradeDate, lastCheck: this.s.lastCheck ? Math.floor(this.s.lastCheck / 1000) : null,
      lastOk: this.s.lastOk ? Math.floor(this.s.lastOk / 1000) : null, result: this.s.result, checking: !!this.s.inflight };
  }

  /** Look for a newer file unless we looked recently. Single-flight: concurrent callers share one check. Never throws. */
  refresh({ force = false } = {}) {
    if (this.s.inflight) return this.s.inflight;
    if (!force && this.now() - this.s.lastCheck < COOLDOWN_MS) return Promise.resolve(this.status());
    this.s.inflight = (async () => {
      try {
        const known = (await this.store.latestTradeDate(SOURCE)) || null;
        this.s.tradeDate ||= known;
        const parsed = await this.source.fetchLatest(known);
        if (parsed) {
          Object.assign(this.s, { parsed, parsedAt: this.now(), tradeDate: parsed.tradeDate, lastOk: this.now(), result: `downloaded the file for ${parsed.tradeDate}` });
          await this.store.safeAudit('fetch_ok', 'nse-archive', `derivatives file for ${parsed.tradeDate}: ${Object.keys(parsed.symbols).length} underlyings`, { channel: 'system' });
        } else {
          this.s.lastOk = this.now(); this.s.result = known ? `already have the latest file (${known})` : 'NSE has not published a recent file';
        }
      } catch (e) {
        this.s.result = `could not fetch the file: ${String(e.message || e).slice(0, 140)}`;
        await this.store.safeAudit('fetch_failed', 'nse-archive', this.s.result, { outcome: 'error', channel: 'system' });
      } finally { this.s.lastCheck = this.now(); this.s.inflight = null; }
      return this.status();
    })();
    return this.s.inflight;
  }

  /** Symbols to offer: indices first, then stock options found in the current file, then anything saved earlier. */
  async symbols() {
    const parsed = this.fresh() ? Object.keys(this.s.parsed.symbols) : [];
    const stocks = parsed.filter((x) => !INDEX_SYMBOLS.includes(x)).sort();
    return [...new Set([...INDEX_SYMBOLS, ...stocks, ...(await this.store.symbols())])];
  }

  fresh() { return this.s.parsed && this.now() - this.s.parsedAt < KEEP_PARSED_MS; }

  /** Make sure the newest file's contracts for `symbol` are saved, then return the saved chain. */
  async chain(symbol, expiry = '') {
    await this.refresh();
    const p = this.fresh() ? this.s.parsed : null, sym = symbol.toUpperCase();
    if (p && p.symbols[sym]) {
      const u = p.symbols[sym];
      for (const iso of Object.keys(u.expiries).sort().slice(0, MAX_EXPIRIES)) {
        const label = expiryLabel(iso);
        if (await this.store.hasSnapshot(sym, label, p.tradeDate, SOURCE)) continue;
        await this.store.store({ symbol: sym, expiry: label, spot: u.spot, tradeDate: p.tradeDate, rows: u.expiries[iso] }, SOURCE, 'nse-archive', `fo-bhavcopy-${p.tradeDate}.csv`);
      }
    }
    return this.store.latest(sym, expiry);
  }
}
