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
- " · st:<prompts>/<minutes>": your prompts and time spent in this workspace's
  Claude sessions (pauses over 5 min don't count);
- on one workspace only, account-wide data: " · day:<prompts>/<minutes>/<agents>/<streak>"
  for today across every Claude session (streak = days in a row with a prompt), " · lim:<5h %>/<5h reset>/<week %>/<week reset>"
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
from datetime import datetime, timedelta

CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux"
CACHE = os.path.expanduser("~/.config/cmux/last-prompt-cache.json")
# Description tokens, joined with " · ". A description with anything else is someone's own.
TOKEN = re.compile(r"^(last prompt @\d+|bg|zz@\d+|st:[\d/]+|lim:[\d/]+|day:[\d/]+|lang:(uk|en))$")
RATE_LIMITS = os.path.expanduser("~/.claude/rate-limits.json")   # written by the Claude Code status line
TRANSCRIPTS = os.path.expanduser("~/.claude/projects/*/*.jsonl")
IDLE_GAP = 300   # seconds between transcript entries still counted as time in the session
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


def scan_transcript(path, tx):
    """Running totals for one transcript: last prompt, prompts, active seconds, and the
    same per day. Transcripts run to several MB, so each run reads only what was
    appended since the last one (offset kept in the cache)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    st = tx.get(path)
    if not st or size < st["off"]:          # new, or rewritten from scratch
        st = {"off": 0, "last": 0, "lp": None, "prompts": 0, "active": 0, "days": {}}
    if size > st["off"]:
        with open(path, "rb") as f:
            f.seek(st["off"])
            chunk = f.read()
        end = chunk.rfind(b"\n") + 1        # a half-written last line waits for the next run
        for raw in chunk[:end].splitlines():
            try:
                entry = json.loads(raw)
            except ValueError:
                continue
            ts = entry.get("timestamp")
            if not ts:
                continue
            at = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            day = st["days"].setdefault(datetime.fromtimestamp(at).strftime("%Y-%m-%d"), [0, 0])
            gap = at - st["last"]
            if 0 < gap <= IDLE_GAP:             # a longer pause isn't time spent in the session
                st["active"] += gap
                day[1] += gap
            st["last"] = max(st["last"], at)
            if prompt_text(entry):
                st["prompts"] += 1
                day[0] += 1
                st["lp"] = int(at)
        st["off"] += end
        tx[path] = st
    return st


def agents_started_today(transcript, today):
    n = 0
    for f in glob.glob(transcript[:-len(".jsonl")] + "/subagents/*.meta.json"):
        try:
            n += datetime.fromtimestamp(os.stat(f).st_birthtime).strftime("%Y-%m-%d") == today
        except OSError:
            pass
    return n


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
    cache = {k: v for k, v in cache.items() if k.startswith("_")}   # drop the pre-"_tx" format

    tx = cache.setdefault("_tx", {})
    children, commands = process_table()
    listening = listening_pids()
    latest, busy, progress, stats = {}, set(), {}, {}
    for s in cmux_json("sessions", "list", "--json", "--all").get("sessions", []):
        ws, path = s.get("workspace_id"), s.get("transcript_path")
        if not ws or not path or not os.path.exists(path):
            continue
        st = scan_transcript(path, tx)
        at = st and st["lp"]
        if at and at > latest.get(ws, 0):
            latest[ws] = at
        prompts, active = stats.get(ws, (0, 0))
        stats[ws] = (prompts + st["prompts"], active + st["active"])
        if busy_in_background(s, children, commands, listening):
            busy.add(ws)
            if s.get("agent_lifecycle") == "backgroundWorkPending" and fresh_subagent(s):
                batch = subagent_batch(s, at)
                done, total = progress.get(ws, (0, 0))
                progress[ws] = (done + batch[0], total + batch[1])

    # Today across every Claude session on this Mac, inside cmux or not, and the streak
    # of days in a row with at least one prompt (today may still be empty).
    today = datetime.now().strftime("%Y-%m-%d")
    day_prompts = day_active = day_agents = 0
    active_days = set()
    for path in glob.glob(TRANSCRIPTS):
        st = scan_transcript(path, tx)
        if not st:
            continue
        active_days.update(d for d, (prompts, _) in st["days"].items() if prompts)
        prompts, active = st["days"].get(today, [0, 0])
        if prompts or active:
            day_prompts, day_active = day_prompts + prompts, day_active + active
            day_agents += agents_started_today(path, today)
    streak, d = 0, datetime.now()
    if today not in active_days:
        d -= timedelta(days=1)
    while d.strftime("%Y-%m-%d") in active_days:
        streak, d = streak + 1, d - timedelta(days=1)
    day = f"day:{day_prompts}/{round(day_active / 60)}/{day_agents}/{streak}"
    for path in [p for p in tx if not os.path.exists(p)]:
        tx.pop(path)

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
            "st:%d/%d" % (stats[w["id"]][0], round(stats[w["id"]][1] / 60)) if w["id"] in stats else None,
            limit if is_owner else None,
            day if is_owner else None,
            lang if is_owner else None,
        ]))
        if current != wanted:
            run(CMUX, "workspace-action", "--workspace", w["id"],
                "--action", "set-description", "--description", wanted)

    with open(CACHE, "w") as f:
        json.dump(cache, f)


if __name__ == "__main__":
    main()
