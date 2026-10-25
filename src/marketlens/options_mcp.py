"""MCP server (stdio) over MarketLens's option-chain database.

Run:  marketlens-options-mcp --data-dir <same folder as MarketLens>

It exposes what is already in the database (snapshots imported from CSVs you downloaded yourself, or fetched
from an official endpoint you configured) plus the audit log. It does not download anything from NSE.
Only `import_csv` writes, and every write is audit-logged with actor "mcp".

Example client config:
  {"mcpServers": {"marketlens-options": {"command": "marketlens-options-mcp", "args": ["--data-dir", "/path/to/data"]}}}
"""
import argparse
import json
import os
import sys

from . import __version__, config, optiondb
from .config import inbox_dir, settings

PROTOCOL = "2025-06-18"
TOOLS = [
    {"name": "option_chain_latest", "description": "Newest saved option-chain snapshot for a symbol (optionally one expiry), with PCR and max pain.",
     "inputSchema": {"type": "object", "properties": {"symbol": {"type": "string"}, "expiry": {"type": "string", "description": "e.g. 27-Oct-2026; empty for the newest"}}, "required": ["symbol"]}},
    {"name": "option_chain_snapshots", "description": "List saved snapshots (newest first) with source and capture time.",
     "inputSchema": {"type": "object", "properties": {"symbol": {"type": "string"}, "limit": {"type": "integer"}}}},
    {"name": "option_chain_import_csv", "description": "Import an NSE option-chain CSV that a person downloaded. Give csv_text, or the name of a file inside the inbox folder.",
     "inputSchema": {"type": "object", "properties": {"csv_text": {"type": "string"}, "inbox_file": {"type": "string"}, "symbol": {"type": "string"}, "expiry": {"type": "string"}, "spot": {"type": "number"}}}},
    {"name": "option_chain_audit_log", "description": "Recent audit-log entries (newest first) and whether the hash chain is intact.",
     "inputSchema": {"type": "object", "properties": {"limit": {"type": "integer"}}}},
]


def _text(obj, error=False):
    return {"content": [{"type": "text", "text": json.dumps(obj, default=str)}], "isError": error}


def call_tool(name, args):
    args = args or {}
    try:
        if name == "option_chain_latest":
            snap = optiondb.latest(str(args.get("symbol", "")), str(args.get("expiry", "")))
            return _text(snap or {"error": "no snapshot saved for that symbol/expiry"}, error=snap is None)
        if name == "option_chain_snapshots":
            return _text({"snapshots": optiondb.snapshots(args.get("symbol"), args.get("limit", 20))})
        if name == "option_chain_audit_log":
            return _text({"entries": optiondb.audit_log(args.get("limit", 30)), "verify": optiondb.verify_audit()})
        if name == "option_chain_import_csv":
            text, fname = args.get("csv_text"), ""
            if not text and args.get("inbox_file"):
                inbox = os.path.realpath(str(inbox_dir()))
                path = os.path.realpath(os.path.join(inbox, os.path.basename(str(args["inbox_file"]))))
                if os.path.commonpath([inbox, path]) != inbox or not os.path.isfile(path):
                    return _text({"error": "inbox_file must be a file inside the inbox folder"}, True)
                if os.path.getsize(path) > optiondb.MAX_CSV_BYTES:
                    return _text({"error": "file is larger than 2 MB"}, True)
                with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
                    text, fname = f.read(), os.path.basename(path)
            if not text:
                return _text({"error": "provide csv_text or inbox_file"}, True)
            return _text(optiondb.import_csv(text, "mcp", fname, args.get("symbol"), args.get("expiry"), args.get("spot")))
        return _text({"error": f"unknown tool {name}"}, True)
    except optiondb.CsvError as e:
        return _text({"error": str(e)}, True)
    except Exception as e:  # report, never crash the server loop
        return _text({"error": f"{e.__class__.__name__}: {str(e)[:200]}"}, True)


def handle(msg):
    """Return a JSON-RPC response dict for one request, or None for notifications."""
    mid, method = msg.get("id"), msg.get("method")
    if mid is None:
        return None
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}}, "serverInfo": {"name": "marketlens-options", "version": __version__},
                  "instructions": "Option-chain snapshots from CSVs the user downloaded or an official endpoint; audit-logged."}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        p = msg.get("params") or {}
        result = call_tool(p.get("name"), p.get("arguments"))
    elif method == "ping":
        result = {}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def serve(stdin=sys.stdin, stdout=sys.stdout):
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            resp = handle(msg) if isinstance(msg, dict) else {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
        except ValueError:
            resp = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        if resp is not None:
            stdout.write(json.dumps(resp) + "\n")
            stdout.flush()


def main(argv=None):
    p = argparse.ArgumentParser(prog="marketlens-options-mcp", description="MCP (stdio) server over MarketLens's option-chain database.")
    p.add_argument("--data-dir", default=None, help="MarketLens data folder (default: your user data folder)")
    p.add_argument("--option-inbox", default=None, help="inbox folder for import_csv inbox_file (default: <data dir>/option-inbox)")
    args = p.parse_args(argv)
    config.configure(data_dir=args.data_dir, option_inbox=args.option_inbox)
    serve()
    return 0


if __name__ == "__main__":
    sys.exit(main())
