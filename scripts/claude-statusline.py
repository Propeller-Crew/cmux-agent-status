#!/usr/bin/env python3
"""A minimal Claude Code status line, installed by install.sh when there's none yet.

Claude Code sends the account's usage limits to the status line only, so this saves
them for the sidebar's limit card (~/.claude/rate-limits.json) and prints a short
line: folder · model · 5h 42%. Limits are missing from some refreshes, so the last
known values stay on disk.
"""
import json
import os
import sys

try:
    data = json.load(sys.stdin)
except ValueError:
    data = {}

limits = data.get("rate_limits")
if limits:
    path = os.path.expanduser("~/.claude/rate-limits.json")
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(limits, f, separators=(",", ":"))
        os.replace(tmp, path)       # the sync job never reads a half-written file
    except OSError:
        pass

ws = data.get("workspace") or {}
folder = os.path.basename(ws.get("current_dir") or data.get("cwd") or os.getcwd())
model = (data.get("model") or {}).get("display_name")
five = ((limits or {}).get("five_hour") or {}).get("used_percentage")
parts = [folder, model, f"5h {five:.0f}%" if isinstance(five, (int, float)) else None]
print(" · ".join(p for p in parts if p))
