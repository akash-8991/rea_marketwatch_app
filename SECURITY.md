# Security policy

MarketLens is a personal, local-first tool. Please read [docs/OPERATIONS.md](docs/OPERATIONS.md) ("Who can reach the server") before exposing it beyond your own computer.

## Reporting a vulnerability
Use GitHub's **private vulnerability reporting** for this repository (Security tab, "Report a vulnerability"). Please do not open a public issue for a security problem, and do not include real credentials, brokerage data or personal data in a report. Expect an acknowledgement within a few days; this is a one-person project, so fixes follow as time allows.

## Supported versions
Only the latest desktop, container and Android releases receive fixes.

## What to know before you rely on it
* Sign-in accounts live on the machine that runs the server. The first account is the administrator; only the administrator can use the Zerodha connection, the audit log, metrics and CSV import. Registration and online account recovery are switched off automatically when the server is bound beyond loopback (see `--open-signup`, `--allow-recovery`).
* Put a TLS reverse proxy in front of any non-loopback deployment and set `--public-url https://your.host` (and `--trusted-proxy` for the proxy's address).
* Live orders are off by default and have their own server-side limits (per order, per day, symbol allow-list); see [docs/BROKER.md](docs/BROKER.md).
* Release checksums are published with each release; the desktop zips also carry a build-provenance attestation (`gh attestation verify`).
* An independent penetration test is recommended before any multi-user hosting or before enabling live orders for anyone other than the owner.
