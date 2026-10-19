#!/usr/bin/env python3
"""Points Claude Code's status line at claude-statusline.py when there's none yet,
so the limit card has data. Someone's own status line is never replaced: they get
the two lines to add to it instead.

  setup-statusline.py SETTINGS COMMAND [--dry-run]

Exit codes: 0 done or nothing to do, 2 their own status line doesn't save the
limits yet, 3 settings.json can't be read (left untouched).
"""
import json
import os
import re
import shutil
import sys
import time

LINES = """limits=$(echo "$input" | jq -c '.rate_limits // empty')
[ -n "$limits" ] && printf '%s' "$limits" > "$HOME/.claude/rate-limits.json\""""


def saves_limits(command):
    """True when the command, or a script file it names, already writes rate-limits.json."""
    if "rate-limits.json" in command or "claude-statusline.py" in command:
        return True
    for tok in re.split(r"\s+", command):
        path = os.path.expanduser(os.path.expandvars(tok.strip("'\"")))
        if os.path.isfile(path):
            try:
                if "rate-limits.json" in open(path, encoding="utf-8", errors="replace").read():
                    return True
            except OSError:
                pass
    return False


def main():
    dry = "--dry-run" in sys.argv
    settings, command = [a for a in sys.argv[1:] if a != "--dry-run"][:2]
    data = {}
    if os.path.exists(settings):
        try:
            with open(settings, encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("not an object")
        except ValueError as e:
            print(f"  Can't read {settings} ({e}), so it was left as it is.")
            print(f'  For the limit card, add to it: "statusLine": {{"type": "command", "command": {json.dumps(command)}}}')
            return 3

    current = data.get("statusLine")
    if current:
        cmd = current.get("command", "") if isinstance(current, dict) else ""
        if saves_limits(cmd):
            print("  your status line already saves the limits")
            return 0
        print("  You have your own status line, so it was left as it is. For the limit card, add these")
        print("  two lines to its script, after it reads Claude's input into $input (needs jq):")
        print()
        print("    " + LINES.replace("\n", "\n    "))
        print()
        return 2

    if dry:
        print(f"  would set Claude Code's status line in {settings} to: {command}")
        return 0
    real = os.path.realpath(settings)
    if os.path.exists(real):
        backup = settings + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(real, backup)
        print(f"  backup of the previous settings: {backup}")
    else:
        os.makedirs(os.path.dirname(real), exist_ok=True)
    data["statusLine"] = {"type": "command", "command": command}
    tmp = real + ".tmp-agent-status"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    if os.path.exists(real):
        shutil.copymode(real, tmp)
    os.replace(tmp, real)
    print(f"  Claude Code's status line now saves the limits: {command}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
