#!/usr/bin/env python3
"""Opens Claude on a new git worktree of the repo this workspace works on.

Run by the tab-strip button in a new tab. When the tab's folder is a git repo,
that's the repo. When it isn't (say, a notes vault where Claude edits code that
lives elsewhere), the repo is the one the workspace's Claude sessions touched
most in their recent tool calls (files read or edited, commands run). A guessed repo is never used silently: the button
lists up to three candidates and waits for Enter (or a number, or "n" for plain
Claude). With no repo at all, plain `claude` starts.

A repo Claude doesn't trust yet gets asked about first (Claude refuses -w there).
`claude -w` doesn't touch the repo's checkout or branches: it makes a new branch and
a separate copy under <repo>/.claude/worktrees/, branched from whatever is checked
out. A wrong pick costs a stray worktree (`git worktree remove <path>`).
"""
import collections
import json
import os
import re
import subprocess

CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux"
CLAUDE_CONFIG = os.path.expanduser("~/.claude.json")
CHUNK = 4 * 1024 * 1024
MAX_SCAN = 64 * 1024 * 1024    # how far back to look before giving up
MAX_LINE = 200 * 1024          # longer lines are pasted images or big outputs, not work
RECENT_PATHS = 400
PATH = re.compile(r"(?:/Users/[^\s\"'`:;,)\]\\\\]+|~/[^\s\"'`:;,)\]\\\\]+)")


def toplevel(path, cache={}):
    if path not in cache:
        r = subprocess.run(["git", "-C", path, "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        cache[path] = r.stdout.strip() if r.returncode == 0 else None
    return cache[path]


def existing_dir(path):
    path = os.path.expanduser(path)
    while path and path != "/" and not os.path.isdir(path):
        path = os.path.dirname(path)
    return path if path and path != "/" else None


def tooling(repo, home):
    """Git repos that are tools, not projects: ~/.nvm, ~/.claude, ~/.config/…"""
    rel = os.path.relpath(repo, home)
    return rel.startswith("..") is False and any(part.startswith(".") for part in rel.split(os.sep)) \
        or repo.startswith(("/Applications", "/opt/homebrew", "/usr", "/Library"))


def tool_paths(line):
    """Paths in what Claude did (tool inputs: files read or edited, commands run),
    not in what it was told: CLAUDE.md and memory name every repo there is."""
    if len(line) > MAX_LINE or b'"tool_use"' not in line:
        return []
    try:
        entry = json.loads(line)
    except ValueError:
        return []
    content = (entry.get("message") or {}).get("content")
    out = []
    for block in content if isinstance(content, list) else []:
        if isinstance(block, dict) and block.get("type") == "tool_use":
            for value in (block.get("input") or {}).values():
                if isinstance(value, str):
                    out += PATH.findall(value)
    return out


def recent_lines(path):
    """Lines from the end of a transcript, newest first, read in chunks: a single
    pasted image can be megabytes, so a fixed tail may hold no work at all."""
    with open(path, "rb") as f:
        end = os.path.getsize(path)
        carry, read = b"", 0
        while end > 0 and read < MAX_SCAN:
            start = max(0, end - CHUNK)
            f.seek(start)
            block = f.read(end - start) + carry
            read += end - start
            end = start
            lines = block.split(b"\n")
            carry = lines.pop(0) if start > 0 else b""
            yield from reversed(lines)
        if carry:
            yield carry


def repos_from_transcripts(workspace, home):
    out = subprocess.run([CMUX, "sessions", "list", "--json", "--all", "--workspace", workspace],
                         capture_output=True, text=True, env={**os.environ, "CMUX_QUIET": "1"}).stdout
    sessions = sorted(json.loads(out or "{}").get("sessions", []),
                      key=lambda s: s.get("updated_at_unix") or 0, reverse=True)
    paths = []
    for s in sessions[:3]:
        path = s.get("transcript_path")
        if not path or not os.path.exists(path):
            continue
        for line in recent_lines(path):
            paths += reversed(tool_paths(line))
            if len(paths) >= RECENT_PATHS:
                break
        if len(paths) >= RECENT_PATHS:
            break
    counts = collections.Counter()
    for p in paths[:RECENT_PATHS]:
        d = existing_dir(p)
        top = d and d != home and toplevel(d)
        if top and top != home and not tooling(top, home):
            counts[top] += 1
    return counts.most_common(3)


def choose(candidates, cwd):
    """Asks which guessed repo to branch; returns its path, or None for plain Claude."""
    print(f"{cwd} isn't a git repo. This workspace's Claude worked in:")
    for i, (repo, hits) in enumerate(candidates, 1):
        print(f"  {i}. {repo.replace(os.path.expanduser('~'), '~')}  ({hits} paths)")
    try:
        answer = input("Enter = 1, a number for another, n = plain Claude: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        return None
    if answer == "":
        return candidates[0][0]
    if answer.isdigit() and 1 <= int(answer) <= len(candidates):
        return candidates[int(answer) - 1][0]
    return None


def trusted(repo):
    """`claude -w` needs the repo itself trusted; a trusted parent (say ~) isn't enough."""
    try:
        with open(CLAUDE_CONFIG) as f:
            return bool(json.load(f).get("projects", {}).get(repo, {}).get("hasTrustDialogAccepted"))
    except (OSError, ValueError):
        return True   # can't tell; let claude decide


def trust(repo):
    """Sets the flag Claude's own trust dialog sets; only after you said yes."""
    with open(CLAUDE_CONFIG) as f:
        config = json.load(f)
    config.setdefault("projects", {}).setdefault(repo, {})["hasTrustDialogAccepted"] = True
    tmp = CLAUDE_CONFIG + ".worktree-tmp"
    with open(tmp, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
    os.chmod(tmp, os.stat(CLAUDE_CONFIG).st_mode)
    os.replace(tmp, CLAUDE_CONFIG)


def ignore_worktrees(repo):
    """Keeps <repo>/.claude/worktrees/ out of `git status`, locally (.git/info/exclude),
    without committing anything to the repo."""
    r = subprocess.run(["git", "-C", repo, "rev-parse", "--git-path", "info/exclude"], capture_output=True, text=True)
    if r.returncode != 0:
        return
    path = os.path.join(repo, r.stdout.strip())
    try:
        with open(path) as f:
            if ".claude/worktrees/" in f.read():
                return
    except OSError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write("\n.claude/worktrees/\n")


def main():
    cwd, home = os.getcwd(), os.path.expanduser("~")
    repo = toplevel(cwd)
    if not repo:
        candidates = repos_from_transcripts(os.environ["CMUX_WORKSPACE_ID"], home) \
            if os.environ.get("CMUX_WORKSPACE_ID") else []
        if not candidates:
            print(f"{cwd} isn't a git repo and this workspace's sessions didn't work in one; starting plain Claude.")
            os.execvp("claude", ["claude"])
        repo = choose(candidates, cwd)
        if not repo:
            os.execvp("claude", ["claude"])
    if repo != cwd:
        os.chdir(repo)
    if not trusted(repo):
        print(f"Claude hasn't been told to trust {repo} yet, and won't make a worktree there without it.")
        try:
            answer = input("Trust it, like Claude's own dialog would? Enter = yes, n = open plain Claude here: ")
        except (EOFError, KeyboardInterrupt):
            answer = "n"
        if answer.strip().lower() == "n":
            os.execvp("claude", ["claude"])
        trust(repo)
    ignore_worktrees(repo)
    os.execvp("claude", ["claude", "-w"])


if __name__ == "__main__":
    main()
