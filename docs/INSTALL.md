# Installation and deployment guide

MarketLens is a local web app: you run it on your own computer and open it in your browser. It needs Python and
nothing else (no database server, no Node.js, no other packages).

## 1. Requirements
- Python **3.9 or newer** (tested on 3.12, 3.13 and 3.14; 3.9 to 3.11 are untested).
- A modern browser.
- Internet access for live data (NSE, Yahoo Finance, Google News). Without it the app runs on its last saved snapshot.

Check Python: `python3 --version` (on Windows: `py --version`).

## 2. Install

### Option A: from the release package (recommended)
Download `marketlens-0.2.0-py3-none-any.whl` and `SHA256SUMS.txt` from the `dist/` folder of this repository, then:

```bash
shasum -a 256 -c SHA256SUMS.txt          # macOS/Linux: checks both files; "OK" for the one you downloaded
python3 -m venv ~/marketlens-env         # a private environment keeps it separate from other Python tools
source ~/marketlens-env/bin/activate     # Windows: %USERPROFILE%\marketlens-env\Scripts\activate
pip install marketlens-0.2.0-py3-none-any.whl
marketlens
```
(`shasum -c` reports "FAILED open or read" for a file you did not download; that is expected.)

### Option B: from source
```bash
git clone https://github.com/akash-8991/rea_marketwatch_app.git
cd rea_marketwatch_app
python3 -m venv .venv && source .venv/bin/activate
pip install .
marketlens
```

### Option C: run without installing (development)
```bash
git clone https://github.com/akash-8991/rea_marketwatch_app.git && cd rea_marketwatch_app
PYTHONPATH=src python3 -m marketlens
```

## 3. First run
`marketlens` starts the server on `http://127.0.0.1:8080/` and opens your browser. The first visit shows
**Create an account**: enter name, email, date of birth, a user ID and a password. After that, sign in with the user
ID and password. More people can create their own accounts on the same installation.

Useful flags (full list: `marketlens --help`):

| Flag | Purpose |
|---|---|
| `--port 8081` | use another port if 8080 is taken |
| `--data-dir PATH` | where the database and caches live |
| `--offline` | never contact NSE; show saved data only |
| `--no-news` | do not fetch headlines |
| `--no-login` | turn accounts off (single trusted user only) |
| `--no-open` | do not open a browser window |
| `--fo-mcp-url URL` | option-chain endpoint, if you have an official NSE derivatives MCP |

## 4. Where your data lives
| System | Default data folder |
|---|---|
| macOS | `~/Library/Application Support/MarketLens` |
| Linux | `~/.local/share/MarketLens` (or `$XDG_DATA_HOME/MarketLens`) |
| Windows | `%APPDATA%\MarketLens` |

It holds `marketlens.db` (accounts, option-chain snapshots, audit log; readable by you only), cached market snapshots
(`*.json`), and the `option-inbox/` folder. Nothing is stored anywhere else, and no NSE data is shipped with the package.

## 5. Option chain
NSE's website blocks automated access, so MarketLens does not download from it. Download the option-chain CSV yourself
from NSE's page and either use **Import CSV** on the Option chain page or drop the file into
`<data folder>/option-inbox/` (checked every 2.5 minutes). Name it like `option-chain-ED-NIFTY-27-Oct-2026.csv` so the
symbol and expiry are read from the name, or type them in. The importer has been tested on synthetic files in NSE's
layout, not on a real download; if a real file is rejected, the reason is in the audit log (`marketlens --audit 20`).

## 6. Run it in the background (examples, not tested here)
The app is meant for `127.0.0.1`. Do **not** bind it to a public address: it speaks plain HTTP.

**macOS (launchd)**: save as `~/Library/LaunchAgents/local.marketlens.plist`, then `launchctl load` it:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.marketlens</string>
  <key>ProgramArguments</key><array>
    <string>/Users/YOU/marketlens-env/bin/marketlens</string><string>--no-open</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
```

**Linux (systemd user service)**: `~/.config/systemd/user/marketlens.service`, then
`systemctl --user enable --now marketlens`:
```ini
[Unit]
Description=MarketLens

[Service]
ExecStart=%h/marketlens-env/bin/marketlens --no-open
Restart=on-failure

[Install]
WantedBy=default.target
```
**Windows**: create a Task Scheduler task that runs `marketlens.exe --no-open` from the environment's `Scripts` folder at log-on.

Health checks for supervisors: `GET /healthz` (alive) and `GET /readyz` (ready to serve data).

## 7. Upgrade, back up, uninstall
- **Upgrade**: `pip install --upgrade marketlens-<new>.whl`. The database upgrades itself on first start; older audit
  entries still verify. Stop the app first and copy the data folder if you want a rollback point.
- **Back up**: stop the app and copy `marketlens.db` (it contains account details and the audit log; keep the copy private).
- **Uninstall**: `pip uninstall marketlens`, then delete the data folder if you also want your accounts and data gone.

## 8. Forgotten credentials
On the sign-in screen use **Forgot user ID?** or **Forgot or change password / user ID** (name, email and date of birth
must all match). If you cannot, whoever runs the machine can run `marketlens --reset-password USERID` (asks for the new
password twice). `marketlens --list-users` shows who is registered.

## 9. Troubleshooting
| Problem | What to do |
|---|---|
| "Address already in use" | start with `--port 8081` or stop the other program |
| Yellow **Stale** banner | NSE or the internet is unreachable, or NSE paused us after too many requests; the app waits 15 minutes before trying again. Do not restart repeatedly. |
| Many "…" in dividend/income columns | those load in the background from NSE and need live access |
| Sign-in locked for 15 minutes | five failed attempts; wait, or use `--reset-password` |
| Option chain empty | import a CSV (section 5) |
| Blank page | check the terminal for errors; try a private window; make sure no browser extension blocks `localhost` |

## 10. For developers
```bash
pip install -e .
PYTHONPATH=src python3 -m unittest discover -s tests          # 140 offline tests, no network needed
python3 tools/loadtest.py --url http://127.0.0.1:8080 --concurrency 1 16 --seconds 8 --cookie "ml_session=<cookie>"
python3 -m pip wheel . --no-deps -w dist                       # build the wheel (needs setuptools)
```
More: `docs/ARCHITECTURE.md` (design and trade-offs), `docs/OPERATIONS.md` (limits, audit log, accounts, runbook),
`docs/ASSESSMENT.md` (findings and measured before/after).

## 11. Licence
MIT. See the `LICENSE` file. The software is provided as is, without warranty, and nothing it shows is investment advice.
