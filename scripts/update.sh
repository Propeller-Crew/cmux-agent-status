#!/bin/sh
# Updates an installed cmux-claude-sidebar to its newest release (a vX.Y.Z tag), then
# repeats the installer steps a new version can need, through `install.sh --update`:
# the links, the Swift helpers, the cmux.json keys it lacks (merge-cmux-config.py, which
# never overwrites yours), the launchd jobs (reloaded only when a plist changed) and
# `cmux reload-config`. Run again, it changes nothing.
#
#   sh ~/.config/cmux/update.sh [--no-launchd]
#
# Options go on to install.sh (--no-launchd: for testing in a throwaway HOME).
#
# The sidebar's "New version" chip runs it when clicked; nothing updates by itself. On
# the master channel (install.sh --master) it moves to master's newest commit instead.
# It leaves a development clone alone (one the installer doesn't manage, on another
# branch, or with local changes) and says what to do instead.
set -eu

say() { printf '%s\n' "$*"; }
stop() { say "$*"; say "Nothing was changed."; exit 1; }
# The newest vX.Y.Z among the tag names on stdin.
newest_release() { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1; }

# The clone: ~/.config/cmux/update.sh links to <clone>/scripts/update.sh.
find_repo() {
  self=$0
  while [ -L "$self" ]; do
    link=$(readlink "$self")
    case $link in /*) self=$link ;; *) self=$(dirname "$self")/$link ;; esac
  done
  REPO=$(cd "$(dirname "$self")/.." && pwd -P)
}

g() { git -C "$REPO" "$@"; }

# Only a clone the installer manages moves: its own copy, or one it marked with a channel.
check_clone() {
  command -v git >/dev/null 2>&1 || stop "git is missing: run xcode-select --install, then this again."
  g rev-parse --git-dir >/dev/null 2>&1 || stop "$REPO isn't a git clone, so there's nothing to update here."
  CHANNEL=$(g config --get cmux-sidebar.channel || true)
  managed=$(cd "${CMUX_CLAUDE_SIDEBAR_DIR:-$HOME/.cmux-claude-sidebar}" 2>/dev/null && pwd -P || true)
  if [ -z "$CHANNEL" ] && [ "$REPO" != "$managed" ]; then
    stop "The sidebar runs from your own clone, $REPO, so update.sh leaves it alone.
Update it there with git, or install the release copy with the install command from the README."
  fi
  CHANNEL=${CHANNEL:-releases}
  if [ -n "$(g status --porcelain --untracked-files=no)" ]; then
    stop "$REPO has local changes:
$(g status --short --untracked-files=no | sed 's/^/  /')
Keep them (commit or stash them yourself) or drop them (git -C $REPO checkout -- .), then run this again."
  fi
  branch=$(g symbolic-ref -q --short HEAD || true)
  if [ -n "$branch" ] && [ "$branch" != master ]; then
    stop "$REPO is on the branch $branch, not on a release. Switch it back yourself (git -C $REPO checkout master), then run this again."
  fi
}

move() {
  before=$(g rev-parse HEAD)
  from=$(g tag --points-at HEAD | newest_release)
  from=${from:-$(g rev-parse --short HEAD)}
  origin=$(g remote get-url origin)
  say "Looking for a new version at $origin"
  if ! err=$(g fetch -q --tags --force origin 2>&1); then
    stop "Couldn't reach it (no network?): $(printf '%s\n' "$err" | head -n 1)"
  fi
  if [ "$CHANNEL" = master ]; then
    g checkout -q master || stop "Couldn't switch $REPO to master."
    g merge -q --ff-only origin/master || stop "Couldn't fast-forward master in $REPO to origin/master."
    to=$(g rev-parse --short HEAD)
  else
    to=$(g tag -l 'v*' | newest_release)
    if [ -z "$to" ]; then
      say "No release yet, so it stays at $from."
      exit 0
    fi
    g checkout -q --detach "$to" || stop "Couldn't switch $REPO to $to."
  fi
  if [ "$(g rev-parse HEAD)" = "$before" ]; then
    say "Already at $to, the newest. Checking that everything is in place:"
    return 0
  fi
  say "Updated: $from -> $to"
  if [ "$(g rev-list --count "$before..HEAD")" = 0 ]; then
    say "  (from master back to the release: releases are the versions that were tried first)"
  else
    g log --no-merges --format='  - %s' "$before..HEAD" | head -n 20
  fi
  page=$(printf '%s' "$origin" | sed -e 's#^git@github.com:#https://github.com/#' -e 's#\.git$##')
  case $CHANNEL:$page in
    releases:https://github.com/*) say "  What's new: $page/releases/tag/$to" ;;
  esac
}

main() {
  for a in "$@"; do
    case $a in
      --no-launchd) ;;
      -h|--help) say "Usage: sh ~/.config/cmux/update.sh [--no-launchd]"; exit 0 ;;
      *) say "Unknown option: $a (see --help)"; exit 1 ;;
    esac
  done
  find_repo
  check_clone
  move
  # The new version's own installer, so new steps come with it. The version is picked.
  export CMUX_SIDEBAR_PICKED=1
  exec sh "$REPO/install.sh" --update "$@"
}

# Everything above only defines functions: a checkout that replaces this file mid-run
# can't change what runs.
main "$@"
