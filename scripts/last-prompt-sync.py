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
  watcher through `--download`, carried here), " · dlseen:<epoch>" (the sidebar's
  chip for it was pasted or hidden, carried here),
  " · win:<points>" (cmux's window height, so the sidebar can keep its card at the bottom;
  reported by the window watcher through `--window`, only carried over here),
  " · lim:<5h %>/<5h reset>/<week %>/<week reset>" (Claude Code usage limits, from ~/.claude/rate-limits.json, which your status
  line writes), " · lang:uk|en" (the sidebar's language, set from the sidebar),
  " · spin:color|pulse|dots|braille" (how a working row shows it works, set from the
  sidebar), " · tabs:on|off" (the "Tasks in new tabs" tick, see below),
  " · upd:<tag>:<release page>" (a newer release is out, see below) and
  " · updhide:<tag>" (the sidebar's chip for that release was hidden, carried here).
Descriptions that aren't in this format are left alone.

Once a day, on an install that sits on a release (see install_state()), one request to
GitHub's releases/latest, without a token, says whether a newer release is out; without
a network nothing happens until the next day. A development clone never asks.

"tabs:on" links the skill in skills/cmux-tabs into ~/.claude/skills, so new Claude
sessions open a separate task in a new cmux tab; "tabs:off" (or no token) takes away that
link, and only a link to a clone of this repo: a file or link of someone else's under
that name stays. `--tabs on|off` sets it from the command line (install.sh asks).

While a batch of background agents runs, the workspace also gets a "done/total"
progress bar (cmux set-progress), counted from <session>/subagents/*.meta.json
started after your last prompt.

Sleeping sessions are closed to free memory and reopened when you come back. A Claude in
a workspace the sidebar shows under "Sleeping" (no prompt for a day, or parked with
zz@), on a tab you aren't looking at, idle with an empty prompt and nothing of its own
running (no Bash-tool shell, no background agents), gets `/exit` typed into it: Claude
quits the normal way, its conversation stays on disk and the terminal keeps its shell.
When you open that workspace again, `claude --resume <session> <its flags>` is typed
into the same terminal. cmux's own Agent Hibernation would do this, but it refuses these
sessions (lifecycle_unknown, then process_scope_unsafe, 20.10.2026). Run with
`--dry-run` to see what it would close and reopen without touching anything.

A Claude that cmux started without its hook forwarder (`cmux hooks claude spool-forwarder`,
a child of the claude process that carries hook events such as Stop to cmux) loses those
events, and its row can spin over an agent that waits for you. Such a session, once it's
free the same way as above (idle by Claude's own ~/.claude/sessions/<pid>.json for a
minute, an empty prompt, no dialog, nothing of its own running, a workspace you aren't
looking at), is restarted at once: `/exit`, "Keep worktree" if it asks, then
`claude --resume <session> <its flags>` in the same terminal. The new Claude starts its
forwarder and the conversation goes on. One per run, each session at most every 30 min.
(Telling cmux `set_agent_lifecycle … idle` instead doesn't move its status: it answers OK
and the pill stays, 20.10.2026.)

Runs from launchd every 15 s (launchd/com.propeller.cmux-last-prompt.plist); the window
watcher (scripts/window-watch.swift) calls it with `--window <points>` on every resize.
"""
import base64
import glob
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import quote

CMUX = os.environ.get("CMUX_BIN") or "/Applications/cmux.app/Contents/Resources/bin/cmux"
CACHE = os.path.expanduser("~/.config/cmux/last-prompt-cache.json")
# Description tokens, joined with " · ". A description with anything else is someone's own.
# "skin:" is left over from the System 1 look (tag system1-skin): still ours, so the
# workspace carrying it isn't dropped, and gone from the next description written.
TOKEN = re.compile(r"^(last prompt @\d+|new|bg|zz@\d+|st:[\d/]+|lim:[\d/]+|day:[\d/]+|win:\d+|focus:\d+|dl:\d+:\S+|dlseen:\d+|lang:(uk|en)|skin:(normal|system1|system1-lite)|spin:(color|pulse|dots|braille)|tabs:(on|off)|upd:v\d+\.\d+\.\d+:\S+|updhide:v\d+\.\d+\.\d+)$")
RATE_LIMITS = os.path.expanduser("~/.claude/rate-limits.json")   # written by the Claude Code status line
# The name the "Claude workspace" command gives a new workspace (config/cmux.snippet.jsonc
# and its Ukrainian variant), and the tab titles Claude shows before it names the chat.
PLACEHOLDER_NAMES = {"New session", "Нова сесія"}
GENERIC_TAB_TITLES = {"Claude Code", "Claude", "claude"}
SPINNER_PREFIX = re.compile(r"^[\s✳✶✻✽✢✦·•●○◐◓◑◒⠀-⣿*]+")
HOOK_SESSIONS = os.path.expanduser("~/.cmuxterm/claude-hook-sessions.json")
# What the watcher reported (window height, newest download). Kept apart from the cache:
# the full run reads it but never writes it, so a report landing mid-run isn't overwritten.
WATCH_STATE = os.path.expanduser("~/.config/cmux/watch-state.json")
TRANSCRIPTS = os.path.expanduser("~/.claude/projects/*/*.jsonl")
FOCUS_SECONDS = 25 * 60   # the sidebar's focus timer
IDLE_GAP = 300   # seconds between transcript entries still counted as time in the session
SKIP_PREFIXES = ("<local-command", "[Request interrupted", "<system-reminder", "Caveat:")
SLEEP_AFTER = 24 * 3600   # no prompt for this long: the sidebar's "Sleeping" (its INACTIVE_AFTER)
WAKE_GRACE = 2 * 3600     # a session reopened here isn't closed again for this long
CLAUDE_SESSIONS = os.path.expanduser("~/.claude/sessions")   # Claude's own <pid>.json per live process
FORWARDER_GRACE = 120     # a Claude younger than this may still be starting its hook forwarder
SETTLED_FOR = 60          # idle this long by Claude's own account before it's restarted
RELAUNCH_AFTER = 30 * 60  # a session restarted for a missing forwarder isn't again for this long
RELAUNCH_PER_RUN = 1
EXIT_WAIT = 15            # seconds a restart waits for Claude to quit after /exit
CLOSE_PER_RUN = 3         # sessions closed per run, so a restart doesn't type into thirty at once
# Flags carried over when a closed session is reopened, and whether each takes a value.
# The rest (a first prompt, --resume, --continue, --session-id) belongs to the first launch.
RESUME_FLAGS = {"--permission-mode": True, "--model": True, "--add-dir": True,
                "--dangerously-skip-permissions": False}
# The clone this script runs from (the installed files are symlinks into it).
REPO = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
# Where install.sh puts its own clone; install.sh also marks the clones it manages.
MANAGED_DIR = os.path.expanduser("~/.cmux-claude-sidebar")
# The skill the "Tasks in new tabs" tick turns on, and where Claude Code looks for skills.
TABS_SKILL = os.path.join(REPO, "skills", "cmux-tabs")
SKILLS_DIR = os.path.expanduser("~/.claude/skills")
RELEASE = re.compile(r"v(\d+)\.(\d+)\.(\d+)")
UPDATE_EVERY = 24 * 3600
UPDATE_TIMEOUT = 3
# Only tests set it, to a mock of GitHub's releases/latest.
RELEASES_API = os.environ.get("CMUX_SIDEBAR_RELEASES_API")


def run(*args):
    return subprocess.run(args, capture_output=True, text=True, timeout=30,
                          env={**os.environ, "CMUX_QUIET": "1"}).stdout


def cmux_json(*args):
    return json.loads(run(CMUX, *args) or "{}")


def cmux_ok(*args):
    """Runs a cmux command for its effect; False when cmux refused it (a draft, a dialog)."""
    return subprocess.run([CMUX, *args], capture_output=True, text=True, timeout=30,
                          env={**os.environ, "CMUX_QUIET": "1"}).returncode == 0


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
                 "agent_lifecycle": r.get("agentLifecycle"), "session_id": r.get("sessionId"),
                 "cwd": r.get("cwd"),
                 "launch_arguments": ((r.get("launchCommand") or {}).get("arguments"))} for r in records]
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


SESSION_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def resume_command(session):
    """`claude --resume <id>` with the flags the session was first started with, from its
    folder: Claude finds a conversation by the folder it was started in."""
    args = (session.get("launch_arguments") or [])[1:]
    kept, i = [], 0
    while i < len(args):
        takes_value = RESUME_FLAGS.get(args[i].split("=")[0])
        if takes_value and "=" not in args[i] and i + 1 < len(args):
            kept += args[i:i + 2]
            i += 2
            continue
        if takes_value is not None:
            kept.append(args[i])
        i += 1
    command = " ".join(["claude", "--resume", session["session_id"], *map(shlex.quote, kept)])
    cwd = session.get("cwd")
    return f"cd -- {shlex.quote(cwd)} && {command}" if cwd else command


def runs_own_work(pid, children, commands):
    """A Bash-tool shell under Claude, idle or not (a dev server, a watcher): closing
    Claude would stop it, so such a session stays open."""
    return any("/.claude/shell-snapshots/" in commands.get(c, "") for c in children.get(pid, []))


def input_state(ws, surface):
    """cmux's view of a terminal: is an agent there, and is its prompt empty."""
    try:
        return json.loads(run(CMUX, "rpc", "surface.input_state",
                              json.dumps({"workspace_id": ws, "surface_id": surface})) or "{}")
    except ValueError:
        return {}


def close_and_reopen(sessions, ours, latest, busy, children, commands, cache, dry_run):
    """Closes sleeping Claude sessions and reopens them when you come back (see the top)."""
    now = time.time()
    closed = cache.setdefault("_closed", {})   # surface → {"ws", "cmd", "at"}
    woke = cache.setdefault("_woke", {})       # workspace → when it was reopened here
    by_id = {w["id"]: w for w in ours}

    for surface, c in list(closed.items()):
        w = by_id.get(c["ws"])
        if not w:
            closed.pop(surface)                # the workspace is gone
            continue
        if not w.get("selected") and not c.get("now"):
            continue                           # a sleeping one waits for you to come back
        if c.get("pid") and still_exiting(c["pid"]) and "claude" in commands.get(c["pid"], ""):
            if now - c["at"] > 300:
                closed.pop(surface)            # it never quit: leave it as it is
            else:
                keep_worktree(c["ws"], surface)
            continue
        st = input_state(c["ws"], surface)
        if st.get("agent"):                    # Claude is back already (you, or a cmux restore)
            closed.pop(surface)
            continue
        if not st.get("terminal"):
            continue                           # its terminal isn't live yet
        if dry_run:
            print(f"would reopen  {w.get('title', '')[:40]}: {c['cmd']}")
            continue
        if cmux_ok("send", "--workspace", c["ws"], "--surface", surface, c["cmd"]) \
                and cmux_ok("send-key", "--workspace", c["ws"], "--surface", surface, "enter"):
            closed.pop(surface)
            woke[c["ws"]] = now

    left = CLOSE_PER_RUN
    for s in sessions:
        ws, surface, pid = s.get("workspace_id"), s.get("surface_id"), s.get("pid")
        w = by_id.get(ws)
        if not w or w.get("selected") or w.get("pinned") or not surface or surface in closed:
            continue
        if not pid or "claude" not in commands.get(pid, "") or s.get("agent_lifecycle") != "idle" \
                or not SESSION_ID.fullmatch(s.get("session_id") or ""):
            continue
        try:
            if not os.path.getsize(s.get("transcript_path") or ""):
                continue
        except OSError:
            continue                           # no conversation on disk to resume from
        # Asleep the way the sidebar sees it: parked by hand, or no prompt for a day.
        parts = (w.get("description") or "").split(" · ")
        zz = next((int(p[3:]) for p in parts if p.startswith("zz@")), None)
        last = latest.get(ws) or 0
        if not last or "new" in parts or not ((zz and last <= zz) or now - last > SLEEP_AFTER):
            continue
        if ws in busy or now - woke.get(ws, 0) < WAKE_GRACE or runs_own_work(pid, children, commands):
            continue
        st = input_state(ws, surface)
        if not st.get("agent") or st.get("state") != "empty" or st.get("waiting_on_human"):
            continue
        cmd = resume_command(s)
        if dry_run:
            print(f"would close   {w.get('title', '')[:40]} (pid {pid}); reopen with: {cmd}")
            continue
        if left == 0:
            break
        # cmux types nothing over a draft or into an open dialog.
        if cmux_ok("send", "--workspace", ws, "--surface", surface, "/exit") \
                and cmux_ok("send-key", "--workspace", ws, "--surface", surface, "enter"):
            closed[surface] = {"ws": ws, "cmd": cmd, "at": int(now)}
            left -= 1
    for ws in [k for k, at in woke.items() if now - at > WAKE_GRACE]:
        woke.pop(ws)


def claude_session(pid):
    """Claude's own record of a live process: its session, the folder it started in, and
    whether it's idle, busy or running a shell."""
    try:
        with open(os.path.join(CLAUDE_SESSIONS, f"{pid}.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def process_env(pid):
    """The CMUX_* variables of a process (`ps eww` prints them after its command)."""
    return dict(re.findall(r"\b(CMUX_[A-Z0-9_]+)=(\S*)", run("ps", "eww", "-o", "command=", "-p", str(pid))))


def launch_arguments(env):
    """The command line cmux's wrapper was given, before it added its own flags."""
    try:
        return base64.b64decode(env.get("CMUX_AGENT_LAUNCH_ARGV_B64", "")).decode().rstrip("\0").split("\0")
    except ValueError:
        return []


def without_forwarder(children, commands):
    """Live Claudes started by cmux's wrapper (it adds --settings from ~/.cmuxterm) that
    have no hook forwarder under them."""
    return [pid for pid, cmd in commands.items()
            if os.path.basename(cmd.split(" ", 1)[0]) == "claude" and "/.cmuxterm/claude-settings/" in cmd
            and not any("hooks claude spool-forwarder" in commands.get(c, "") for c in children.get(pid, []))]


def still_exiting(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def keep_worktree(ws, surface):
    """`/exit` in a worktree session asks "Keep worktree / Remove worktree": keep it, so the
    conversation resumes there. Only when the screen shows that dialog with Keep picked."""
    screen = run(CMUX, "read-screen", "--workspace", ws, "--surface", surface, "--lines", "30")
    if "Exiting worktree session" not in screen:
        return False
    picked = [l for l in screen.splitlines() if "❯" in l and " worktree" in l]   # past prompts have ❯ too
    return bool(picked) and "Keep worktree" in picked[-1] and \
        cmux_ok("send-key", "--force", "--workspace", ws, "--surface", surface, "enter")


def relaunch_without_forwarder(sessions, ours, children, commands, cache, dry_run):
    """Restarts a free Claude that has no hook forwarder (see the top). Its reopen goes
    through close_and_reopen's list, marked "now" so it doesn't wait for you."""
    now = time.time()
    closed = cache.setdefault("_closed", {})
    relaunched = cache.setdefault("_relaunched", {})   # session → when it was restarted here
    by_id = {w["id"]: w for w in ours}
    by_surface = {s.get("surface_id"): s for s in sessions}
    left = RELAUNCH_PER_RUN
    for pid in without_forwarder(children, commands):
        me = claude_session(pid)
        sid, cwd = me.get("sessionId") or "", me.get("cwd")
        if not SESSION_ID.fullmatch(sid) or not cwd or now - relaunched.get(sid, 0) < RELAUNCH_AFTER:
            continue
        if now - (me.get("startedAt") or now * 1000) / 1000 < FORWARDER_GRACE:
            continue
        env = process_env(pid)
        ws, surface = env.get("CMUX_WORKSPACE_ID"), env.get("CMUX_SURFACE_ID")
        w = by_id.get(ws)
        if not w or not surface or surface in closed:
            continue
        label = f"{w.get('title', '')[:40]} (pid {pid}, no forwarder)"
        # Claude resumes a conversation from the folder it was started in.
        transcript = os.path.join(os.path.expanduser("~/.claude/projects"),
                                  re.sub(r"[^A-Za-z0-9]", "-", cwd), sid + ".jsonl")
        try:
            if not os.path.getsize(transcript):
                continue
        except OSError:
            continue
        if w.get("selected") or me.get("status") != "idle" \
                or now - (me.get("statusUpdatedAt") or now * 1000) / 1000 < SETTLED_FOR:
            if dry_run:
                print(f"would wait    {label}: not free yet")
            continue
        if runs_own_work(pid, children, commands) or fresh_subagent({"transcript_path": transcript}):
            continue
        st = input_state(ws, surface)
        if not st.get("agent") or st.get("state") != "empty" or st.get("waiting_on_human"):
            continue
        args = launch_arguments(env) or by_surface.get(surface, {}).get("launch_arguments")
        cmd = resume_command({"session_id": sid, "cwd": cwd, "launch_arguments": args})
        if dry_run:
            print(f"would restart {label}: /exit, then {cmd}")
            continue
        if left == 0:
            break
        # cmux types nothing over a draft or into an open dialog.
        if not (cmux_ok("send", "--workspace", ws, "--surface", surface, "/exit")
                and cmux_ok("send-key", "--workspace", ws, "--surface", surface, "enter")):
            continue
        closed[surface] = {"ws": ws, "cmd": cmd, "at": int(now), "pid": pid, "now": True}
        relaunched[sid] = int(now)
        left -= 1
        # Wait for it to quit, so close_and_reopen can type the resume in this same run.
        for _ in range(EXIT_WAIT * 2):
            if not still_exiting(pid) and not input_state(ws, surface).get("agent"):
                break
            keep_worktree(ws, surface)
            time.sleep(0.5)
    for sid in [k for k, at in relaunched.items() if now - at > RELAUNCH_AFTER]:
        relaunched.pop(sid)


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


def git(*args):
    """A git command in the clone: its output, or None when it failed."""
    try:
        r = subprocess.run(["git", "-C", REPO, *args], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return r.stdout.strip() if r.returncode == 0 else None


def head_ref():
    """The clone's HEAD as git keeps it ("ref: refs/heads/master" or a commit), read from the
    file: it only says when to look at the install again, so no git call on every run."""
    path = os.path.join(REPO, ".git")
    try:
        if os.path.isfile(path):               # a worktree: .git names the real git dir
            with open(path) as f:
                path = os.path.join(REPO, f.read().split("gitdir:", 1)[1].strip())
        with open(os.path.join(path, "HEAD")) as f:
            return f.read().strip()
    except (OSError, IndexError):
        return None


def version(tag):
    m = RELEASE.fullmatch(tag or "")
    return tuple(map(int, m.groups())) if m else None


def install_state():
    """What an update would move this clone from: the release tag it sits on, "master" for
    an install from before the first release, or None, and then nothing is checked: a
    development clone (not one install.sh manages, on another branch, or with local
    changes) or an install that follows master by choice (install.sh --master)."""
    channel = git("config", "--get", "cmux-sidebar.channel")
    if not channel and os.path.realpath(REPO) != os.path.realpath(MANAGED_DIR):
        return None
    if (channel or "releases") != "releases" or git("status", "--porcelain", "--untracked-files=no") != "":
        return None
    branch = git("symbolic-ref", "-q", "--short", "HEAD")
    if branch:
        return "master" if branch == "master" else None
    tags = [t for t in (git("tag", "--points-at", "HEAD") or "").split() if version(t)]
    return max(tags, key=version) if tags else None


def releases_api():
    """GitHub's releases/latest for the clone's origin."""
    if RELEASES_API:
        return RELEASES_API
    m = re.search(r"github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?/?$", git("remote", "get-url", "origin") or "")
    return f"https://api.github.com/repos/{m.group(1)}/{m.group(2)}/releases/latest" if m else None


def latest_release(api):
    """[tag, release page] of the newest published release, or None while there is none."""
    req = urllib.request.Request(api, headers={"Accept": "application/vnd.github+json",
                                               "User-Agent": "cmux-claude-sidebar"})
    try:
        with urllib.request.urlopen(req, timeout=UPDATE_TIMEOUT) as r:
            rel = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    tag, page = rel.get("tag_name") or "", rel.get("html_url") or ""
    return [tag, page] if version(tag) and page else None


def update_token(cache):
    """"upd:<tag>:<release page>" while a release newer than the installed one is out.
    The install is looked at again when HEAD moves (an update just ran) and once a day; on
    that daily look an install on a release asks GitHub, once, whatever the answer."""
    u = cache.setdefault("_update", {})
    head, now = head_ref(), time.time()
    stale = now - u.get("checked", 0) > UPDATE_EVERY
    if stale or head != u.get("head"):
        u["head"], u["installed"] = head, install_state()
    if stale:
        u["checked"] = now
        api = u["installed"] and releases_api()
        try:
            if api:
                u["latest"] = latest_release(api)
        except (OSError, ValueError):
            pass                               # no network, rate-limited: it waits a day
    installed, latest = u.get("installed"), u.get("latest")
    if not installed or not latest:
        return None
    if installed != "master" and version(latest[0]) <= version(installed):
        return None
    return f"upd:{latest[0]}:{quote(latest[1], safe=':/')}"


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
    swap_owner_token(prefix, value)


def swap_owner_token(prefix, value):
    ours = our_workspaces()
    if not ours:
        return
    owner = ours[0]
    parts = [p for p in (owner.get("description") or "").split(" · ") if p and not p.startswith(prefix)]
    parts.append(prefix + value)
    run(CMUX, "workspace-action", "--workspace", owner["id"],
        "--action", "set-description", "--description", " · ".join(parts))


def apply_tabs_skill(on, dry_run=False):
    """Links the cmux-tabs skill into ~/.claude/skills, or takes away only our own link."""
    path = os.path.join(SKILLS_DIR, os.path.basename(TABS_SKILL))
    target = os.readlink(path) if os.path.islink(path) else None
    if on:
        if target == TABS_SKILL:
            return
        if os.path.lexists(path) and not ours_skill_link(target):
            return                     # someone's own skill by that name
        if not dry_run:
            os.makedirs(SKILLS_DIR, exist_ok=True)
            if target is not None:
                os.remove(path)        # ours, from another clone (or gone)
            os.symlink(TABS_SKILL, path)
    elif target is not None and ours_skill_link(target) and not dry_run:
        os.remove(path)


def ours_skill_link(target):
    """A link to skills/cmux-tabs in a clone of this repo (this one, an older one, or a removed one)."""
    if target is None or os.path.normpath(target).split(os.sep)[-2:] != ["skills", "cmux-tabs"]:
        return False
    clone = os.path.dirname(os.path.dirname(os.path.normpath(target)))
    return target == TABS_SKILL or not os.path.exists(target) \
        or os.path.exists(os.path.join(clone, "scripts", "last-prompt-sync.py"))


def set_tabs(value):
    """`--tabs on|off`: what the sidebar's tick does, for install.sh. With cmux closed, the
    choice waits in the watch state ("tabs:" = "<on|off>@<epoch ms>") and the next full run
    with workspaces puts it on the owner once, over a token left from before."""
    state = read_watch_state()
    state["tabs:"] = f"{value}@{int(time.time() * 1000)}"
    os.makedirs(os.path.dirname(WATCH_STATE), exist_ok=True)
    tmp = WATCH_STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, WATCH_STATE)
    try:
        swap_owner_token("tabs:", value)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass                           # cmux isn't open
    apply_tabs_skill(value == "on")


def name_new_workspaces(sessions, dry_run):
    """A workspace opened by the Claude command keeps its placeholder name: Claude titles
    its tab after the first prompt, not the workspace. Give the workspace that title."""
    clean = lambda s: SPINNER_PREFIX.sub("", s or "")   # Claude's spinner glyph, as in the sidebar
    agent_surfaces = {s["surface_id"].upper() for s in sessions if s.get("surface_id")}
    tree = cmux_json("tree", "--json", "--id-format", "both")
    for window in tree.get("windows", []):
        for w in window.get("workspaces", []):
            if clean(w.get("title")) not in PLACEHOLDER_NAMES:
                continue
            titles = [clean(s.get("title")) for p in w.get("panes", []) for s in p.get("surfaces", [])
                      if (s.get("id") or "").upper() in agent_surfaces]
            title = next((t for t in titles if t and t not in PLACEHOLDER_NAMES
                          and t not in GENERIC_TAB_TITLES and not t.startswith(("/", "~"))), None)
            if title and not dry_run:
                run(CMUX, "workspace-action", "--workspace", w["id"], "--action", "rename", "--title", title)


def main(dry_run=False):
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
    sessions = hook_sessions()
    for s in sessions:
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
    spin = carried(ours, "spin:") or cache.get("_spin")
    cache["_spin"] = spin
    watched = read_watch_state()
    tabs = carried(ours, "tabs:") or cache.get("_tabs")
    asked, _, asked_at = watched.get("tabs:", "").partition("@")
    if ours and asked in ("on", "off") and asked_at.isdigit() and int(asked_at) > cache.get("_tabs_at", 0):
        tabs, cache["_tabs_at"] = "tabs:" + asked, int(asked_at)   # `--tabs`, once
    cache["_tabs"] = tabs
    apply_tabs_skill(tabs == "tabs:on", dry_run)
    win = "win:" + watched["win:"] if "win:" in watched else carried(ours, "win:")
    download = "dl:" + watched["dl:"] if "dl:" in watched else carried(ours, "dl:")
    focus = carried(ours, "focus:")
    if focus and time.time() - int(focus.split(":")[1]) > FOCUS_SECONDS:
        focus = None                 # the timer ran out; the sidebar has notified
    seen = carried(ours, "dlseen:")
    hidden = carried(ours, "updhide:") or cache.get("_updhide")
    cache["_updhide"] = hidden
    update = update_token(cache)
    if update and hidden and update.split(":")[1] == hidden.split(":")[1]:
        update = None                # hidden in the sidebar until a newer one is out

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
            seen if is_owner else None,
            lang if is_owner else None,
            spin if is_owner else None,
            tabs if is_owner else None,
            update if is_owner else None,
            hidden if is_owner else None,
        ]))
        if current != wanted:
            run(CMUX, "workspace-action", "--workspace", w["id"],
                "--action", "set-description", "--description", wanted)

    cache["_known"] = sorted(known & {w["id"] for w in ours})   # forget closed workspaces
    cache.pop("_unstuck", None)      # left by the set_agent_lifecycle attempt this replaced
    cache.pop("_skin", None)         # left by the System 1 look
    name_new_workspaces(sessions, dry_run)
    relaunch_without_forwarder(sessions, ours, children, commands, cache, dry_run)
    close_and_reopen(sessions, ours, latest, busy, children, commands, cache, dry_run)
    with open(CACHE, "w") as f:
        json.dump(cache, f)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--window" and sys.argv[2].isdigit():
        set_owner_token("win:", sys.argv[2])
    elif len(sys.argv) == 4 and sys.argv[1] == "--download" and sys.argv[2].isdigit():
        # quote() keeps spaces and " · " out of the token; the sidebar decodes it.
        set_owner_token("dl:", f"{sys.argv[2]}:{quote(sys.argv[3])}")
    elif len(sys.argv) == 3 and sys.argv[1] == "--tabs" and sys.argv[2] in ("on", "off"):
        set_tabs(sys.argv[2])
    else:
        main(dry_run="--dry-run" in sys.argv)
