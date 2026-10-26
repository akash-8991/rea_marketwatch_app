"""When is the NSE cash market trading? Python twin of mobile/engine/marketclock.js (the same rules, tested against the same cases).

Regular session: Monday to Friday, 09:15 to 15:30 India time (IST, UTC+5:30, no daylight saving). There is no exchange holiday calendar
available, so a holiday is recognised from the data: inside session hours, if the quotes NSE returns do not carry today's date, nothing trades.
"""
import datetime

OPEN_MIN = 9 * 60 + 15
CLOSE_MIN = 15 * 60 + 30
GRACE_MIN = 20          # after the open, how long to wait for the first quote carrying today's date before concluding "no trading today"
_IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))


def ist(ts):
    """India-time parts of an epoch second: (date 'YYYY-MM-DD', minutes since midnight, weekday 0=Sunday)."""
    d = datetime.datetime.fromtimestamp(ts, _IST)
    return d.date().isoformat(), d.hour * 60 + d.minute, (d.weekday() + 1) % 7


def is_weekday(dow):
    return 1 <= dow <= 5


def in_session_hours(ts):
    _, minutes, dow = ist(ts)
    return is_weekday(dow) and OPEN_MIN <= minutes < CLOSE_MIN


def last_session_date(ts):
    date, minutes, dow = ist(ts)
    d = datetime.date.fromisoformat(date)
    if not (is_weekday(dow) and minutes >= OPEN_MIN):
        d -= datetime.timedelta(days=1)
    while d.weekday() >= 5:
        d -= datetime.timedelta(days=1)
    return d.isoformat()


def market_state(ts, received=0, newest=""):
    """{'open', 'live', 'label', 'session'}; `received` live quotes seen and the `newest` quote timestamp ('YYYY-MM-DD HH:MM:SS')."""
    date, minutes, dow = ist(ts)
    session = (newest or "")[:10] or last_session_date(ts)
    if not is_weekday(dow):
        return {"open": False, "live": False, "label": "Market closed (weekend)", "session": session}
    if minutes < OPEN_MIN:
        return {"open": False, "live": False, "label": "Pre-open" if minutes >= 9 * 60 else "Market opens at 9:15 am IST", "session": session}
    if minutes >= CLOSE_MIN:
        return {"open": False, "live": False, "label": "Market closed for the day", "session": session}
    if (newest or "")[:10] == date:
        return {"open": True, "live": True, "label": "Market open", "session": date}
    waiting = minutes < OPEN_MIN + GRACE_MIN or received < 3
    if waiting:
        return {"open": True, "live": True, "label": "Market open", "session": session}
    return {"open": False, "live": False, "label": "No trading today (exchange holiday?)", "session": session}
