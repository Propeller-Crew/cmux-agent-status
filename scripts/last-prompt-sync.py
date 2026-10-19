#!/usr/bin/env python3
"""Feeds the agent-status sidebar what cmux itself doesn't know.

For every cmux workspace this writes into its description:
- when you last wrote to Claude there ("last prompt @<epoch>"): cmux forgets its
  latestAt on restart, so every tab would read "22h"; Claude's transcripts don't forget;
- " · new" on a workspace you just opened that has no prompt yet;
- " · bg" while Claude has ended its turn but still works in the background and
  will pick up on its own: a Bash-tool shell (shell-snapshots) under the claude
  process that doesn't listen on a port (an idle dev server isn't work), or cmux's
  agent_lifecycle = backgroundWorkPending while a background agent wrote to its
  transcript in the last 2 min;
- " · zz@<epoch>" is set and cleared by the sidebar (you parked the tab in
  "Sleeping"); this script only keeps it;
- " · st:<prompts>/<minutes>": your prompts and the wall-clock minutes this
  workspace's Claude sessions were active (an entry in a transcript, by you or by
  Claude, within 5 min of the previous one; parallel sessions count once);
- on one workspace only, account-wide data: " · day:<prompts>/<minutes>/<agents>/<streak>"
  for today across every Claude session (streak = days in a row with a prompt),
  " · focus:<epoch>" (a running focus timer, started from the sidebar, carried here),
  " · dl:<epoch>:<url-quoted path>" (the newest file in ~/Downloads, reported by the
  watcher through `--download`, carried here),
  " · win:<points>" (cmux's window height, so the sidebar can keep its card at the bottom;
  reported by the window watcher through `--window`, only carried over here),
  " · lim:<5h %>/<5h reset>/<week %>/<week reset>" (Claude Code usage limits, from ~/.claude/rate-limits.json, which your status
  line writes) and " · lang:uk|en" (the sidebar's language, set from the sidebar).
Descriptions that aren't in this format are left alone.

While a batch of background agents runs, the workspace also gets a "done/total"
progress bar (cmux set-progress), counted from <session>/subagents/*.meta.json
started after your last prompt.

Runs from launchd every 15 s (launchd/com.propeller.cmux-last-prompt.plist); the window
watcher (scripts/window-watch.swift) calls it with `--window <points>` on every resize.
"""
import glob
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta
from urllib.parse import quote

CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux"
CACHE = os.path.expanduser("~/.config/cmux/last-prompt-cache.json")
# Description tokens, joined with " · ". A description with anything else is someone's own.
TOKEN = re.compile(r"^(last prompt @\d+|new|bg|zz@\d+|st:[\d/]+|lim:[\d/]+|day:[\d/]+|win:\d+|focus:\d+|dl:\d+:\S+|lang:(uk|en))$")
RATE_LIMITS = os.path.expanduser("~/.claude/rate-limits.json")   # written by the Claude Code status line
HOOK_SESSIONS = os.path.expanduser("~/.cmuxterm/claude-hook-sessions.json")
# What the watcher reported (window height, newest download). Kept apart from the cache:
# the full run reads it but never writes it, so a report landing mid-run isn't overwritten.
WATCH_STATE = os.path.expanduser("~/.config/cmux/watch-state.json")
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


def mark_minutes(st, start, end):
    """Marks every wall-clock minute from start to end as active, one bitmask per day,
    so parallel sessions count once when the masks are OR-ed together."""
    for minute in range(int(start // 60), int(end // 60) + 1):
        t = datetime.fromtimestamp(minute * 60)
        day = t.strftime("%Y-%m-%d")
        st["mins"][day] = st["mins"].get(day, 0) | (1 << (t.hour * 60 + t.minute))


def scan_transcript(path, tx):
    """Running totals for one transcript: last prompt, prompts per day, and which
    minutes of each day the session was active (an entry within IDLE_GAP of the
    previous one keeps the minutes between them active). Transcripts run to several MB,
    so each run reads only what was appended since the last one (offset kept in the cache)."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    st = tx.get(path)
    if not st or size < st["off"] or "mins" not in st:    # new, rewritten, or an older cache format
        st = {"off": 0, "last": 0, "lp": None, "prompts": 0, "days": {}, "mins": {}}
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
            gap = at - st["last"]
            mark_minutes(st, st["last"] if 0 < gap <= IDLE_GAP else at, at)
            st["last"] = max(st["last"], at)
            if prompt_text(entry):
                st["prompts"] += 1
                day = datetime.fromtimestamp(at).strftime("%Y-%m-%d")
                st["days"][day] = st["days"].get(day, 0) + 1
                st["lp"] = int(at)
        st["off"] += end
        tx[path] = st
    return st


def active_minutes(states, day=None):
    """Wall-clock minutes with at least one of these sessions active (overlaps count once)."""
    days = {day} if day else {d for st in states for d in st["mins"]}
    total = 0
    for d in days:
        mask = 0
        for st in states:
            mask |= st["mins"].get(d, 0)
        total += bin(mask).count("1")
    return total


def hook_sessions():
    """cmux's Claude session records, read straight from its store (a `cmux sessions list`
    call costs a quarter of a second each run); falls back to the CLI if the format moves."""
    try:
        with open(HOOK_SESSIONS) as f:
            records = json.load(f)["sessions"].values()
        return [{"workspace_id": r.get("workspaceId"), "surface_id": r.get("surfaceId"),
                 "transcript_path": r.get("transcriptPath"), "pid": r.get("pid"),
                 "agent_lifecycle": r.get("agentLifecycle")} for r in records]
    except (OSError, ValueError, KeyError, AttributeError):
        return cmux_json("sessions", "list", "--json", "--all").get("sessions", [])


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


def our_workspaces():
    workspaces = cmux_json("workspace", "list", "--json").get("workspaces", [])
    return [w for w in workspaces
            if all(TOKEN.match(p) for p in (w.get("description") or "").split(" · ") if p)]


def carried(ours, prefix):
    """A token the sidebar or the window watcher set, wherever it currently sits."""
    return next((p for w in ours for p in (w.get("description") or "").split(" · ")
                 if p.startswith(prefix)), None)


def read_watch_state():
    try:
        with open(WATCH_STATE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def set_owner_token(prefix, value):
    """Fast path for the watcher: remember the value, then swap that one token on the owner workspace."""
    state = read_watch_state()
    state[prefix] = value
    tmp = WATCH_STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, WATCH_STATE)
    ours = our_workspaces()
    if not ours:
        return
    owner = ours[0]
    parts = [p for p in (owner.get("description") or "").split(" · ") if p and not p.startswith(prefix)]
    parts.append(prefix + value)
    run(CMUX, "workspace-action", "--workspace", owner["id"],
        "--action", "set-description", "--description", " · ".join(parts))


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
    latest, busy, progress, per_ws = {}, set(), {}, {}
    for s in hook_sessions():
        ws, path = s.get("workspace_id"), s.get("transcript_path")
        if not ws or not path or not os.path.exists(path):
            continue
        st = scan_transcript(path, tx)
        at = st and st["lp"]
        if at and at > latest.get(ws, 0):
            latest[ws] = at
        per_ws.setdefault(ws, []).append(st)
        if busy_in_background(s, children, commands, listening):
            busy.add(ws)
            if s.get("agent_lifecycle") == "backgroundWorkPending" and fresh_subagent(s):
                batch = subagent_batch(s, at)
                done, total = progress.get(ws, (0, 0))
                progress[ws] = (done + batch[0], total + batch[1])

    # Today across every Claude session on this Mac, inside cmux or not, and the streak
    # of days in a row with at least one prompt (today may still be empty).
    today = datetime.now().strftime("%Y-%m-%d")
    day_prompts = day_agents = 0
    active_days, today_states = set(), []
    for path in glob.glob(TRANSCRIPTS):
        st = scan_transcript(path, tx)
        if not st:
            continue
        active_days.update(d for d, prompts in st["days"].items() if prompts)
        if today in st["mins"]:
            today_states.append(st)
            day_prompts += st["days"].get(today, 0)
            day_agents += agents_started_today(path, today)
    streak, d = 0, datetime.now()
    if today not in active_days:
        d -= timedelta(days=1)
    while d.strftime("%Y-%m-%d") in active_days:
        streak, d = streak + 1, d - timedelta(days=1)
    day = f"day:{day_prompts}/{active_minutes(today_states, today)}/{day_agents}/{streak}"
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

    ours = our_workspaces()
    # Account-wide tokens (usage limit, sidebar language) ride on one workspace: the first of ours.
    owner = ours[0]["id"] if ours else None
    limit = rate_limit_token()
    # Remembered in the cache too: these ride on one workspace, and closing it loses them.
    lang = carried(ours, "lang:") or cache.get("_lang")
    cache["_lang"] = lang
    watched = read_watch_state()
    win = "win:" + watched["win:"] if "win:" in watched else carried(ours, "win:")
    download = "dl:" + watched["dl:"] if "dl:" in watched else carried(ours, "dl:")
    focus = carried(ours, "focus:")

    # "new": a workspace this script has never seen before and that has no prompt yet,
    # i.e. one you just opened. A restored session can also lack a readable prompt
    # (cmux points it at a transcript Claude hasn't written yet), so "no prompt" alone
    # doesn't mean new.
    known = set(cache.get("_known", []))
    first_run = not known
    for w in ours:
        at = latest.get(w["id"])
        current = w.get("description") or ""
        fresh = not at and (("new" in current.split(" · ")) or (w["id"] not in known and not first_run))
        known.add(w["id"])
        if not at and not fresh and w["id"] != owner:
            continue
        sleep = next((p for p in current.split(" · ") if p.startswith("zz@")), None)
        is_owner = w["id"] == owner
        wanted = " · ".join(filter(None, [
            f"last prompt @{at}" if at else None,
            "new" if fresh else None,
            "bg" if w["id"] in busy else None,
            sleep,
            ("st:%d/%d" % (sum(st["prompts"] for st in per_ws[w["id"]]), active_minutes(per_ws[w["id"]])))
            if w["id"] in per_ws else None,
            limit if is_owner else None,
            day if is_owner else None,
            win if is_owner else None,
            focus if is_owner else None,
            download if is_owner else None,
            lang if is_owner else None,
        ]))
        if current != wanted:
            run(CMUX, "workspace-action", "--workspace", w["id"],
                "--action", "set-description", "--description", wanted)

    cache["_known"] = sorted(known & {w["id"] for w in ours})   # forget closed workspaces
    with open(CACHE, "w") as f:
        json.dump(cache, f)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--window" and sys.argv[2].isdigit():
        set_owner_token("win:", sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "--download" and sys.argv[2].isdigit():
        # quote() keeps spaces and " · " out of the token; the sidebar decodes it.
        set_owner_token("dl:", f"{sys.argv[2]}:{quote(sys.argv[3])}")
    else:
        main()
