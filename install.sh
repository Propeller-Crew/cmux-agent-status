#!/bin/sh
# Installs the Claude sidebar for cmux for the current macOS user, or updates it:
#
#   curl -fsSL https://raw.githubusercontent.com/sahneo/cmux-claude-sidebar/master/install.sh | bash
#   ./install.sh [--dry-run] [--install-cmux] [--glass | --no-glass] [--no-launchd]
#
# Run outside a clone, it fetches the repo first (into ~/.cmux-claude-sidebar, or the
# clone an earlier install points to) and runs that copy. Without cmux, it offers
# `brew install --cask cmux`. Files are symlinked, so running this again, or
# `git pull` in the clone, updates a running install. Nothing the person already set
# is overwritten: cmux.json and Claude's settings.json only get the keys they don't
# have, after a backup.
#
#   --dry-run       show what would change and write nothing
#   --install-cmux  install cmux with Homebrew if it's missing, without asking
#   --glass         also make the terminal glass, without asking (--no-glass: skip it)
#   --no-launchd    don't load the background jobs (for testing in a throwaway HOME)
set -eu

REPO_URL=${CMUX_CLAUDE_SIDEBAR_REPO:-https://github.com/sahneo/cmux-claude-sidebar}
CMUX=${CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}
PY=/usr/bin/python3     # the same one the launchd job runs
CMUX_DIR=$HOME/.config/cmux
DRY=0 GLASS=ask LAUNCHD=1 INSTALL_CMUX=ask
TODO=""                 # what's left for the person, printed at the end

say() { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
todo() { TODO="$TODO
  - $*"; }
# Runs a command, or only shows it in a dry run.
run() { if [ "$DRY" = 1 ]; then say "  would run: $*"; else "$@"; fi; }

parse_args() {
  for a in "$@"; do
    case $a in
      --dry-run) DRY=1 ;;
      --glass) GLASS=yes ;;
      --no-glass) GLASS=no ;;
      --no-launchd) LAUNCHD=0 ;;
      --install-cmux) INSTALL_CMUX=yes ;;
      -h|--help) say "Usage: install.sh [--dry-run] [--install-cmux] [--glass | --no-glass] [--no-launchd]"; exit 0 ;;
      *) say "Unknown option: $a (see --help)"; exit 1 ;;
    esac
  done
}

# The repo this script sits in, if it was run from a clone (not piped from curl).
find_repo() {
  case $0 in
    *install.sh) ;;
    *) return 1 ;;
  esac
  d=$(cd "$(dirname "$0")" && pwd)
  [ -f "$d/sidebars/agent-status.js" ] || return 1
  REPO=$d
}

# Piped from curl: reuse the clone an earlier install links to, or fetch one, then run its install.sh.
fetch_and_rerun() {
  command -v git >/dev/null 2>&1 || { say "git is missing: run xcode-select --install, then this again."; exit 1; }
  dir=""
  link=$(readlink "$CMUX_DIR/sidebars/agent-status.js" 2>/dev/null || true)
  if [ -n "$link" ]; then
    d=$(dirname "$(dirname "$link")")
    if [ -f "$d/install.sh" ] && git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then dir=$d; fi
  fi
  if [ "$DRY" = 1 ]; then
    if [ -z "$dir" ]; then
      tmp=$(mktemp -d)
      say "Dry run: fetching a temporary copy of the repo into $tmp"
      git clone -q --depth 1 "$REPO_URL" "$tmp/cmux-claude-sidebar"
      dir=$tmp/cmux-claude-sidebar
    fi
  elif [ -n "$dir" ]; then
    say "Updating the copy an earlier install uses: $dir"
    if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
      say "  it has local changes, so it's installed as it is"
    else
      git -C "$dir" pull -q --ff-only || say "  couldn't fast-forward it, so it's installed as it is"
    fi
  else
    dir=${CMUX_CLAUDE_SIDEBAR_DIR:-$HOME/.cmux-claude-sidebar}
    if [ -d "$dir/.git" ]; then
      say "Updating $dir"
      git -C "$dir" pull -q --ff-only
    else
      say "Downloading cmux-claude-sidebar into $dir"
      git clone -q "$REPO_URL" "$dir"
    fi
  fi
  exec sh "$dir/install.sh" "$@"
}

# A y/N question. Piped from curl, stdin is the script itself, so the answer comes
# from the terminal; with no terminal the answer is no.
ask() {
  printf '%s [y/N] ' "$1"
  ans=$( (exec </dev/tty && read -r a && printf '%s' "$a") 2>/dev/null || true)
  [ -n "$ans" ] || printf '\n'
  case $ans in [yY]*) return 0 ;; *) return 1 ;; esac
}

# cmux itself comes from its own Homebrew cask (it updates itself), never bundled here.
install_cmux() {
  say "cmux isn't installed (looked for $CMUX)."
  if ! command -v brew >/dev/null 2>&1; then
    say "Install Homebrew (https://brew.sh), then: brew install --cask cmux"
    say "Or download cmux from https://cmux.com. Then run this again."
    exit 1
  fi
  if [ "$INSTALL_CMUX" != yes ] && ! ask "Install it now with: brew install --cask cmux?"; then
    say "Install it with: brew install --cask cmux (or from https://cmux.com), then run this again."
    exit 1
  fi
  if [ "$DRY" = 1 ]; then
    say "  would run: brew install --cask cmux"
    say "Dry run stops here: the rest needs cmux installed."
    exit 0
  fi
  brew install --cask cmux || { say "brew couldn't install cmux (see above)."; exit 1; }
  [ -x "$CMUX" ] || { say "cmux was installed, but not at $CMUX. Set CMUX_BIN to its cmux binary and run this again."; exit 1; }
  todo "Open cmux once (it was just installed)"
}

check_tools() {
  [ -x "$CMUX" ] || install_cmux
  v=$("$CMUX" --version 2>/dev/null | awk '{print $2}')
  case $v in
    0.[0-9].*|0.[1-5][0-9].*|0.6[0-4].*)
      say "cmux $v is too old: custom sidebars need 0.65 or newer. Update cmux, then run this again."
      exit 1 ;;
  esac
  if ! "$PY" -c "" >/dev/null 2>&1; then
    say "Python 3 is missing (it comes with Xcode's command line tools): run xcode-select --install, then this again."
    exit 1
  fi
  say "cmux ${v:-(version unknown)}, installing from $REPO"
}

link_files() {
  step "Sidebar files (symlinks into ~/.config/cmux)"
  run mkdir -p "$CMUX_DIR/sidebars" "$CMUX_DIR/icons" "$CMUX_DIR/bin"
  run ln -sf "$REPO/sidebars/agent-status.js" "$CMUX_DIR/sidebars/agent-status.js"
  run ln -sf "$REPO/scripts/last-prompt-sync.py" "$CMUX_DIR/last-prompt-sync.py"
  run ln -sf "$REPO/scripts/claude-worktree.py" "$CMUX_DIR/claude-worktree"
  run ln -sf "$REPO/scripts/claude-statusline.py" "$CMUX_DIR/claude-statusline.py"
  [ "$DRY" = 1 ] || say "  linked"
}

# Built only when missing or older than the source, so an update run stays quick.
build_helpers() {
  step "Window watcher and Claude icon"
  bin=$CMUX_DIR/bin/cmux-window-watch
  if [ -x "$bin" ] && [ "$bin" -nt "$REPO/scripts/window-watch.swift" ]; then
    say "  window watcher is up to date"
  elif [ "$DRY" = 1 ]; then
    say "  would build $bin"
  elif swiftc -O "$REPO/scripts/window-watch.swift" -o "$bin" 2>/dev/null; then
    say "  built the window watcher"
  else
    say "  window watcher not built (needs Xcode command line tools); the activity card sits right under the list"
  fi
  icon=$CMUX_DIR/icons/claude.png
  if [ -f "$icon" ]; then
    say "  Claude icon is there"
  elif [ "$DRY" = 1 ]; then
    say "  would extract cmux's Claude icon into $icon"
  elif swift "$REPO/scripts/extract-claude-icon.swift" "$icon" >/dev/null 2>&1; then
    say "  extracted the Claude icon"
  else
    say "  Claude icon not extracted (needs Xcode command line tools); the tab-strip button shows text"
  fi
}

merge_config() {
  step "cmux settings (adds what's missing to ~/.config/cmux/cmux.json)"
  rc=0
  if [ "$DRY" = 1 ]; then
    "$PY" -I "$REPO/scripts/merge-cmux-config.py" "$REPO/config/cmux.snippet.jsonc" "$CMUX_DIR/cmux.json" --dry-run || rc=$?
  else
    "$PY" -I "$REPO/scripts/merge-cmux-config.py" "$REPO/config/cmux.snippet.jsonc" "$CMUX_DIR/cmux.json" --cmux "$CMUX" || rc=$?
  fi
  case $rc in
    0) ;;
    2) todo "Fix the cmux.json setting marked NEEDS A FIX above, then run: cmux reload-config" ;;
    3) todo "Merge $REPO/config/cmux.snippet.jsonc into $CMUX_DIR/cmux.json by hand, then run: cmux reload-config" ;;
    *) todo "cmux rejected the merged cmux.json, so the previous one was restored. Merge $REPO/config/cmux.snippet.jsonc by hand" ;;
  esac
}

statusline() {
  step "Claude usage limits for the activity card (Claude Code status line)"
  rc=0
  dry=""
  [ "$DRY" = 1 ] && dry=--dry-run
  "$PY" -I "$REPO/scripts/setup-statusline.py" "$HOME/.claude/settings.json" \
    "$PY -I \"$CMUX_DIR/claude-statusline.py\"" $dry || rc=$?
  case $rc in
    0) ;;
    2) todo "For the limit card, add the two lines shown above to your status line script" ;;
    *) todo "For the limit card, set Claude Code's status line as shown above" ;;
  esac
}

# Optional: a translucent terminal with blur, through Ghostty's config (cmux reads it).
glass() {
  if [ "$GLASS" = ask ]; then
    printf '\n'
    if ask "Also make the terminal glass (translucent with blur)?"; then GLASS=yes; else GLASS=no; fi
  fi
  if [ "$GLASS" != yes ]; then
    say "  no glass (add it any time: install.sh --glass)"
    return 0
  fi
  step "Glass terminal"
  g=$HOME/.config/ghostty/config
  marker="# cmux-claude-sidebar: glass terminal"
  if [ -f "$g" ] && grep -qF "$marker" "$g"; then
    say "  already in $g"
  elif [ "$DRY" = 1 ]; then
    say "  would add $REPO/config/ghostty.config to $g"
  else
    mkdir -p "$(dirname "$g")"
    if [ -f "$g" ]; then
      cp "$g" "$g.bak-$(date +%Y%m%d-%H%M%S)"
      say "  added to the end of $g (backup next to it)"
    else
      say "  created $g"
    fi
    { printf '\n%s\n' "$marker"; cat "$REPO/config/ghostty.config"; } >> "$g"
  fi
  run defaults write com.cmuxterm.app sidebarBlendMode -string behindWindow
  run defaults write com.cmuxterm.app sidebarMaterial -string sidebar
}

activate() {
  step "Turning the sidebar on"
  if [ "$DRY" = 1 ]; then
    say "  would run: cmux reload-config, cmux sidebar validate agent-status, cmux sidebar select agent-status"
    return 0
  fi
  if ! out=$("$CMUX" sidebar validate agent-status 2>&1); then
    say "$out" | sed 's/^/  /'
    todo "The sidebar didn't validate (see above). Run: cmux sidebar validate agent-status"
    return 0
  fi
  if "$CMUX" reload-config >/dev/null 2>&1 && "$CMUX" sidebar select agent-status >/dev/null 2>&1; then
    say "  agent-status is now cmux's sidebar"
  else
    say "  couldn't reach cmux (is it open?)"
    todo "Open cmux, then run: cmux reload-config && cmux sidebar select agent-status"
  fi
}

# The jobs go last: they talk to cmux over its socket, which the merged settings open up.
launch_jobs() {
  step "Background jobs (launchd)"
  for label in com.propeller.cmux-last-prompt com.propeller.cmux-window-watch; do
    if [ "$label" = com.propeller.cmux-window-watch ] && [ "$DRY" = 0 ] && [ ! -x "$CMUX_DIR/bin/cmux-window-watch" ]; then
      continue
    fi
    plist=$HOME/Library/LaunchAgents/$label.plist
    if [ "$DRY" = 1 ]; then
      say "  would write $plist and load it"
      continue
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    sed "s#__HOME__#$HOME#g" "$REPO/launchd/$label.plist" > "$plist"
    if [ "$LAUNCHD" = 1 ]; then
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$plist"
      say "  $label running"
    else
      say "  wrote $plist (not loaded: --no-launchd)"
    fi
  done
}

summary() {
  printf '\n'
  if [ "$DRY" = 1 ]; then
    say "Dry run: nothing was changed."
  else
    say "Done. Update any time by running the same command again."
  fi
  if [ -n "$TODO" ]; then
    say "Left for you:$TODO"
  fi
}

main() {
  parse_args "$@"
  find_repo || fetch_and_rerun "$@"
  check_tools
  link_files
  build_helpers
  merge_config
  statusline
  glass
  activate
  launch_jobs
  summary
}

# Everything above only defines functions, so a download cut short runs nothing.
main "$@"
