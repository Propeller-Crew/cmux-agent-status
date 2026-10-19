#!/usr/bin/env python3
"""Opens Claude on a new git worktree of the repo this workspace works on.

Run by the tab-strip button in a new tab. When the tab's folder is a git repo,
that's the repo. When it isn't (say, a notes vault where Claude edits code that
lives elsewhere), the repo is the one the workspace's Claude sessions touched
most in their recent transcripts. With no repo at all, plain `claude` starts.
"""
import collections
import json
import os
import re
import subprocess

CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux"
TAIL_BYTES = 3 * 1024 * 1024
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


def repo_from_transcripts(workspace, home):
    out = subprocess.run([CMUX, "sessions", "list", "--json", "--all", "--workspace", workspace],
                         capture_output=True, text=True, env={**os.environ, "CMUX_QUIET": "1"}).stdout
    sessions = sorted(json.loads(out or "{}").get("sessions", []),
                      key=lambda s: s.get("updated_at_unix") or 0, reverse=True)
    paths = []
    for s in sessions[:3]:
        path = s.get("transcript_path")
        if not path or not os.path.exists(path):
            continue
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - TAIL_BYTES))
            text = f.read().decode("utf-8", "replace")
        paths += reversed(PATH.findall(text))           # most recent first
        if len(paths) >= RECENT_PATHS:
            break
    counts = collections.Counter()
    for p in paths[:RECENT_PATHS]:
        d = existing_dir(p)
        top = d and d != home and toplevel(d)
        if top and top != home:
            counts[top] += 1
    return counts.most_common(1)[0][0] if counts else None


def main():
    cwd, home = os.getcwd(), os.path.expanduser("~")
    repo = toplevel(cwd)
    if not repo and os.environ.get("CMUX_WORKSPACE_ID"):
        repo = repo_from_transcripts(os.environ["CMUX_WORKSPACE_ID"], home)
    if not repo:
        print(f"{cwd} isn't a git repo and this workspace's sessions didn't work in one; starting plain Claude.")
        os.execvp("claude", ["claude"])
    if repo != cwd:
        print(f"Worktree of {repo}")
        os.chdir(repo)
    os.execvp("claude", ["claude", "-w"])


if __name__ == "__main__":
    main()
