"""Regenerate mobile/engine/sectors.js from the Python engine so both apps share one sector map.
Run from the repository root:  PYTHONPATH=src python3 mobile/scripts/gen-sectors.py > mobile/engine/sectors.js"""
import json

from marketlens import market

print("/* Generated from src/marketlens/market.py (SECTOR_MAP, SECTOR_INDICES). Regenerate with mobile/scripts/gen-sectors.py. */")
print("export const SECTOR_MAP = " + json.dumps(market.SECTOR_MAP, indent=2) + ";")
print("export const SECTOR_INDICES = " + json.dumps(market.SECTOR_INDICES) + ";")
