/* Intraday price record (port of ticks.py). NSE's servers keep daily history only, so intraday candles are built from the live prices the app sees while it is
 * open: every fresh quote adds a tick, ticks fold into one-minute bars [open, high, low, close, volume] saved per symbol per day (the last few days are kept).
 * The chart page resamples them into 5-minute, 15-minute and hourly candles. A minute with no new price has no bar: nothing is invented. */
export const KEEP_DAYS = 5;
const FLUSH_MS = 15000;
const IST_MS = 5.5 * 3600 * 1000;
const dayOf = (minute) => new Date(minute * 60000 + IST_MS).toISOString().slice(0, 10);

export class Ticks {
  constructor({ snaps, now = () => Date.now() }) { this.snaps = snaps; this.now = now; this.mem = new Map(); }

  async load(sym, day) {
    const k = `${sym}|${day}`;
    if (!this.mem.has(k)) { const saved = (await this.snaps.get(`ticks:${sym}:${day.replace(/-/g, '')}`)) || {}; this.mem.set(k, { bars: new Map(Object.entries(saved.bars || {}).map(([m, b]) => [+m, b])), cumvol: saved.cumvol ?? null, ts: saved.ts ?? null, dirty: false, saved: this.now() }); }
    return this.mem.get(k);
  }

  static minuteOf(tsText, now) {
    const t = tsText ? Date.parse(String(tsText).replace(' ', 'T') + '+05:30') : NaN;
    return Math.floor((Number.isFinite(t) ? t : now) / 60000);
  }

  /** Add one tick. Ignored unless the price is positive and not an unchanged repeat of the last quote NSE returned. */
  async record(sym, price, cumvol, tsText) {
    if (!(price > 0)) return false;
    const minute = Ticks.minuteOf(tsText, this.now()), d = await this.load(sym, dayOf(minute)), cur = d.bars.get(minute);
    if (tsText && d.ts && tsText <= d.ts && cur && cur[3] === price) return false;
    let delta = 0;
    if (cumvol != null && d.cumvol != null && cumvol >= d.cumvol) delta = cumvol - d.cumvol;
    if (cumvol != null) d.cumvol = cumvol;
    d.ts = tsText || d.ts;
    if (!cur) d.bars.set(minute, [price, price, price, price, delta]);
    else { cur[1] = Math.max(cur[1], price); cur[2] = Math.min(cur[2], price); cur[3] = price; cur[4] += delta; }
    d.dirty = true;
    if (this.now() - d.saved >= FLUSH_MS) await this.flush(sym, dayOf(minute), d);
    return true;
  }

  async flush(sym, day, d) {
    d.dirty = false; d.saved = this.now();
    await this.snaps.put(`ticks:${sym}:${day.replace(/-/g, '')}`, { bars: Object.fromEntries([...d.bars.entries()].sort((a, b) => a[0] - b[0]).map(([m, b]) => [String(m), b])), cumvol: d.cumvol, ts: d.ts });
  }

  async flushAll() { for (const [k, d] of this.mem) if (d.dirty) { const [sym, day] = k.split('|'); await this.flush(sym, day, d); } }

  /** One-minute bars [[epoch seconds, o, h, l, c, v], ...] for the last `days` calendar days with data, oldest first. */
  async bars(sym, days = KEEP_DAYS) {
    const today = new Date(this.now() + IST_MS), out = [];
    for (let back = days - 1; back >= 0; back--) {
      const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back)).toISOString().slice(0, 10);
      if (!this.mem.has(`${sym}|${day}`) && (await this.snaps.age(`ticks:${sym}:${day.replace(/-/g, '')}`)) == null) continue;
      const d = await this.load(sym, day);
      for (const [m, b] of [...d.bars.entries()].sort((a, c) => a[0] - c[0])) out.push([m * 60, ...b]);
    }
    return out;
  }
}
