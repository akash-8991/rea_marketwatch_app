"""Regenerate mobile/engine/sectors.js from the Python engine's bundled list (src/marketlens/data/ind_niftytotalmarket_list.csv, NSE's Nifty Total
Market constituents), so the desktop and phone apps start from the same list. At run time both apps refresh it from the official download.
Run from the repository root:  PYTHONPATH=src python3 mobile/scripts/gen-sectors.py > mobile/engine/sectors.js"""
import json

from marketlens import market, securities

securities.load_bundled()
print("/* Generated from src/marketlens/data/ind_niftytotalmarket_list.csv and market.SECTOR_INDICES by mobile/scripts/gen-sectors.py. Do not edit by hand. */")
print("export const SECURITIES = " + json.dumps({s: [r["industry"], r["company"]] for s, r in sorted(securities.ROWS.items())}, separators=(",", ":"), ensure_ascii=False) + ";")
print("export const SECTOR_INDICES = " + json.dumps(market.SECTOR_INDICES) + ";")
