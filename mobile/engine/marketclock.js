/* When is the NSE cash market trading, and which day's data is "the last update"?
 *
 * Regular session: Monday to Friday, 09:15 to 15:30 India time (IST, UTC+5:30, no daylight saving). The exchange holiday calendar
 * is not available to the app, so a holiday is recognised from the data itself: inside session hours, if the quotes NSE returns do
 * not carry today's date, nothing is trading. Pure functions of time and data, so every rule is tested without a clock. */

export const OPEN_MIN = 9 * 60 + 15;
export const CLOSE_MIN = 15 * 60 + 30;
const GRACE_MIN = 20;   // after the open, how long we wait for the first quote with today's date before concluding "no trading today"

const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** India-time parts of an instant: {date:'YYYY-MM-DD', minutes since midnight, dow 0=Sunday}. */
export function ist(ms) {
  const d = new Date(ms + 5.5 * 3600 * 1000);
  return { date: iso(d), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

export const isWeekday = (dow) => dow >= 1 && dow <= 5;

/** True during regular session hours on a weekday (holidays are handled by marketState). */
export function inSessionHours(ms) {
  const t = ist(ms);
  return isWeekday(t.dow) && t.minutes >= OPEN_MIN && t.minutes < CLOSE_MIN;
}

/** The most recent weekday whose session has ended or is under way: the date the "last update" should carry (holidays aside). */
export function lastSessionDate(ms) {
  const t = ist(ms);
  let d = new Date(Date.UTC(+t.date.slice(0, 4), +t.date.slice(5, 7) - 1, +t.date.slice(8, 10)));
  const sessionStarted = isWeekday(t.dow) && t.minutes >= OPEN_MIN;
  if (!sessionStarted) d = new Date(d.getTime() - 86400000);
  while (!isWeekday(d.getUTCDay())) d = new Date(d.getTime() - 86400000);
  return iso(d);
}

/** `seen` = {received: how many live quotes arrived, newest: the newest quote timestamp, 'YYYY-MM-DD ...'}.
 * Returns {open, live, label, session}: open = inside session hours; live = quotes are really moving today. */
export function marketState(ms, seen = {}) {
  const t = ist(ms), newestDay = (seen.newest || '').slice(0, 10), session = newestDay || lastSessionDate(ms);
  if (!isWeekday(t.dow)) return { open: false, live: false, label: 'Market closed (weekend)', session };
  if (t.minutes < OPEN_MIN) return { open: false, live: false, label: t.minutes >= 9 * 60 ? 'Pre-open' : 'Market opens at 9:15 am IST', session };
  if (t.minutes >= CLOSE_MIN) return { open: false, live: false, label: 'Market closed for the day', session };
  if (newestDay === t.date) return { open: true, live: true, label: 'Market open', session: t.date };
  const waiting = t.minutes < OPEN_MIN + GRACE_MIN || (seen.received || 0) < 3;   // first quotes may not have arrived yet
  return waiting ? { open: true, live: true, label: 'Market open', session } : { open: false, live: false, label: 'No trading today (exchange holiday?)', session };
}
