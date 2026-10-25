"""Regenerate mobile/engine/sectors.js from the Python engine's sector list (src/marketlens/data/sectors.csv, NSE's Nifty Total Market
constituents), so the desktop and phone apps classify stocks identically.
Run from the repository root:  PYTHONPATH=src python3 mobile/scripts/gen-sectors.py > mobile/engine/sectors.js"""
import json

from marketlens import market

print("/* Generated from src/marketlens/data/sectors.csv and market.SECTOR_INDICES by mobile/scripts/gen-sectors.py. Do not edit by hand. */")
print("export const SECTOR_MAP = " + json.dumps(market.SECTOR_MAP, separators=(",", ":"), sort_keys=True) + ";")
print("export const SECTOR_INDICES = " + json.dumps(market.SECTOR_INDICES) + ";")
