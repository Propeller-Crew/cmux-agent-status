#!/usr/bin/env python3
"""Feeds the agent-status sidebar what cmux itself doesn't know.

For every cmux workspace this writes into its description:
- when you last wrote to Claude there ("last prompt @<epoch>"): cmux forgets its
  latestAt on restart, so every tab would read "22h"; Claude's transcripts don't forget;
- " · bg" while Claude has ended its turn but still works in the background and
  will pick up on its own: a Bash-tool shell (shell-snapshots) under the claude
  process that doesn't listen on a port (an idle dev server isn't work), or cmux's
  agent_lifecycle = backgroundWorkPending while a background agent wrote to its
  transcript in the last 2 min;
- " · zz@<epoch>" is set and cleared by the sidebar (you parked the tab in
  "Sleeping"); this script only keeps it;
- on one workspace only, account-wide data: " · lim:<5h %>/<5h reset>/<week %>/<week reset>"
  (Claude Code usage limits, from ~/.claude/rate-limits.json, which your status
  line writes) and " · lang:uk|en" (the sidebar's language, set from the sidebar).
Descriptions that aren't in this format are left alone.

While a batch of background agents runs, the workspace also gets a "done/total"
progress bar (cmux set-progress), counted from <session>/subagents/*.meta.json
started after your last prompt.

Runs from launchd every 15 s (launchd/com.propeller.cmux-last-prompt.plist).
"""
import glob
import json
import os
import re
import subprocess
import time
from datetime import datetime

CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux"
CACHE = os.path.expanduser("~/.config/cmux/last-prompt-cache.json")
# Description tokens, joined with " · ". A description with anything else is someone's own.
TOKEN = re.compile(r"^(last prompt @\d+|bg|zz@\d+|lim:[\d/]+|lang:(uk|en))$")
RATE_LIMITS = os.path.expanduser("~/.claude/rate-limits.json")   # written by the Claude Code status line
TAIL_BYTES = 4 * 1024 * 1024
SKIP_PREFIXES = ("<local-command", "[Request interrupted", "<system-reminder", "Caveat:")


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=30,
                          env={**os.environ, "CMUX_QUIET": "1"}).stdout


def cmux_json(*args):
    return json.loads(run(CMUX, *args) or "{}")


def prompt_text(entry):
    """What a person actually sent, or None (tool results, meta entries, subagents)."""
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain") \
            or entry.get("isCompactSummary"):
        return None
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list):
        if any(c.get("type") == "tool_result" for c in content if isinstance(c, dict)):
            return None
        content = " ".join(c.get("text", "") for c in content
                           if isinstance(c, dict) and c.get("type") == "text")
    if not isinstance(content, str):
        return None
    text = content.strip()
    if not text or text.startswith(SKIP_PREFIXES):
        return None
    return text


def last_prompt_at(path):
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            for start in ([max(0, size - TAIL_BYTES), 0] if size > TAIL_BYTES else [0]):
                f.seek(start)
                for raw in reversed(f.read().splitlines()):
                    try:
                        entry = json.loads(raw)
                    except ValueError:
                        continue
                    if prompt_text(entry) and entry.get("timestamp"):
                        ts = entry["timestamp"].replace("Z", "+00:00")
                        return int(datetime.fromisoformat(ts).timestamp())
    except OSError:
        pass
    return None


def cached_last_prompt_at(path, cache):
    """Transcripts run to several MB; only re-read the ones that changed."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = [st.st_mtime, st.st_size]
    hit = cache.get(path)
    if hit and hit[:2] == key:
        return hit[2]
    at = last_prompt_at(path)
    cache[path] = key + [at]
    return at


def process_table():
    children, commands = {}, {}
    for line in run("ps", "-axo", "pid=,ppid=,command=").splitlines():
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid, ppid = int(parts[0]), int(parts[1])
        commands[pid] = parts[2]
        children.setdefault(ppid, []).append(pid)
    return children, commands


def listening_pids():
    out = run("lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fp")
    return {int(l[1:]) for l in out.splitlines() if l.startswith("p")}


def subtree(pid, children):
    out, stack = [], [pid]
    while stack:
        p = stack.pop()
        out.append(p)
        stack.extend(children.get(p, []))
    return out


def subagent_batch(session, since):
    """(done, total) background agents started after the last prompt.
    Claude writes a `finished` flag into <session>/subagents/agent-*.meta.json."""
    done = total = 0
    transcript = session.get("transcript_path") or ""
    for f in glob.glob(transcript[:-len(".jsonl")] + "/subagents/*.meta.json"):
        try:
            if since and os.stat(f).st_birthtime < since:
                continue
            with open(f) as fh:
                meta = json.load(fh)
        except (OSError, ValueError):
            continue
        total += 1
        done += meta.get("finished") is True
    return done, total


def fresh_subagent(session, within=120):
    transcript = session.get("transcript_path") or ""
    now = time.time()
    for f in glob.glob(transcript[:-len(".jsonl")] + "/subagents/*.jsonl"):
        try:
            if now - os.path.getmtime(f) < within:
                return True
        except OSError:
            pass
    return False


def busy_in_background(session, children, commands, listening):
    pid = session.get("pid")
    if not pid or "claude" not in commands.get(pid, ""):
        return False  # no live Claude, so no background agents either
    # cmux also reports backgroundWorkPending when only a server idles in the
    # background, so trust it only while a background agent is writing its transcript.
    # The `finished` flags alone aren't trusted: older Claude versions never wrote them.
    if session.get("agent_lifecycle") == "backgroundWorkPending" and fresh_subagent(session):
        return True
    for child in children.get(pid, []):
        if "/.claude/shell-snapshots/" not in commands.get(child, ""):
            continue
        if not any(p in listening for p in subtree(child, children)):
            return True
    return False


def rate_limit_token():
    """"lim:<5h %>/<5h reset>/<week %>/<week reset>" from the status line's last known limits."""
    try:
        with open(RATE_LIMITS) as f:
            rl = json.load(f)
        five, week = rl.get("five_hour") or {}, rl.get("seven_day") or {}
        values = [five.get("used_percentage"), five.get("resets_at"),
                  week.get("used_percentage"), week.get("resets_at")]
        return "lim:" + "/".join(str(round(v or 0)) for v in values)
    except (OSError, ValueError):
        return None


def main():
    try:
        with open(CACHE) as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}

    children, commands = process_table()
    listening = listening_pids()
    latest, busy, progress = {}, set(), {}
    for s in cmux_json("sessions", "list", "--json", "--all").get("sessions", []):
        ws, path = s.get("workspace_id"), s.get("transcript_path")
        if not ws or not path or not os.path.exists(path):
            continue
        at = cached_last_prompt_at(path, cache)
        if at and at > latest.get(ws, 0):
            latest[ws] = at
        if busy_in_background(s, children, commands, listening):
            busy.add(ws)
            if s.get("agent_lifecycle") == "backgroundWorkPending" and fresh_subagent(s):
                batch = subagent_batch(s, at)
                done, total = progress.get(ws, (0, 0))
                progress[ws] = (done + batch[0], total + batch[1])

    # The "12/16" progress bar shows only while a batch of background agents is still running.
    shown = cache.setdefault("_progress", {})
    for ws in set(shown) | set(progress):
        done, total = progress.get(ws, (0, 0))
        label = f"{done}/{total}" if total >= 2 and done < total else None
        if label == shown.get(ws):
            continue
        if label:
            run(CMUX, "set-progress", f"{done / total:.3f}", "--label", label, "--workspace", ws)
            shown[ws] = label
        else:
            run(CMUX, "clear-progress", "--workspace", ws)
            shown.pop(ws, None)

    workspaces = cmux_json("workspace", "list", "--json").get("workspaces", [])
    ours = [w for w in workspaces
            if all(TOKEN.match(p) for p in (w.get("description") or "").split(" · ") if p)]
    # Account-wide tokens (usage limit, sidebar language) ride on one workspace: the first of ours.
    owner = ours[0]["id"] if ours else None
    limit = rate_limit_token()
    lang = next((p for w in ours for p in (w.get("description") or "").split(" · ")
                 if p.startswith("lang:")), None)

    for w in ours:
        at = latest.get(w["id"])
        current = w.get("description") or ""
        if not at and w["id"] != owner:
            continue
        sleep = next((p for p in current.split(" · ") if p.startswith("zz@")), None)
        is_owner = w["id"] == owner
        wanted = " · ".join(filter(None, [
            f"last prompt @{at}" if at else None,
            "bg" if w["id"] in busy else None,
            sleep,
            limit if is_owner else None,
            lang if is_owner else None,
        ]))
        if current != wanted:
            run(CMUX, "workspace-action", "--workspace", w["id"],
                "--action", "set-description", "--description", wanted)

    with open(CACHE, "w") as f:
        json.dump(cache, f)


if __name__ == "__main__":
    main()
