#!/bin/sh
# Installs the Claude sidebar for cmux for the current macOS user, or updates it:
#
#   curl -fsSL https://raw.githubusercontent.com/sahneo/cmux-claude-sidebar/master/install.sh | bash
#   ./install.sh [--dry-run] [--install-cmux] [--glass | --no-glass] [--tabs | --no-tabs] [--master | --releases] [--no-launchd]
#
# Run outside a clone, it fetches the repo first (into ~/.cmux-claude-sidebar, or the
# clone an earlier install points to) and runs that copy. Without cmux, it offers
# `brew install --cask cmux`. Files are symlinked into the clone. Nothing the person
# already set is overwritten: cmux.json and Claude's settings.json only get the keys
# they don't have, after a backup.
#
# Its own clone (~/.cmux-claude-sidebar) is put on the newest release, a vX.Y.Z tag, or
# on master while there is none yet; with --master it follows master instead. Updates
# come from scripts/update.sh (the sidebar's "New version" chip runs it). A clone of
# your own (the repo you run ./install.sh from, or one an earlier install points to) is
# installed exactly as it is: no fetch, no checkout.
#
#   --dry-run       show what would change and write nothing
#   --install-cmux  install cmux with Homebrew if it's missing, without asking
#   --glass         also make the sidebar glass next to a solid terminal, without asking
#                   (--no-glass: skip it)
#   --no-tabs       turn off "Tasks in new tabs" (Claude opens a separate task in a new
#                   cmux tab; on by default, also a tick in the sidebar's right-click menu);
#                   --tabs turns it back on
#   --master        follow master, the newest and least tried (CMUX_CLAUDE_SIDEBAR_CHANNEL=master);
#                   --releases goes back to releases. The choice stays with the clone.
#   --no-launchd    don't load the background jobs (for testing in a throwaway HOME)
#   --update        what update.sh runs after moving the clone: the steps a new version
#                   can need, without questions
set -eu

REPO_URL=${CMUX_CLAUDE_SIDEBAR_REPO:-https://github.com/sahneo/cmux-claude-sidebar}
CMUX=${CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}
PY=/usr/bin/python3     # the same one the launchd job runs
CMUX_DIR=$HOME/.config/cmux
MANAGED_DIR=${CMUX_CLAUDE_SIDEBAR_DIR:-$HOME/.cmux-claude-sidebar}
CHANNEL=${CMUX_CLAUDE_SIDEBAR_CHANNEL:-}   # releases | master; empty: what the clone follows, releases at first
DRY=0 GLASS=ask TABS=keep LAUNCHD=1 INSTALL_CMUX=ask UPDATE=0
REBUILT=0               # the window watcher was built anew, so its job restarts
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
      --tabs) TABS=yes ;;
      --no-tabs) TABS=no ;;
      --no-launchd) LAUNCHD=0 ;;
      --install-cmux) INSTALL_CMUX=yes ;;
      --master) CHANNEL=master ;;
      --releases) CHANNEL=releases ;;
      --update) UPDATE=1 GLASS=no ;;
      -h|--help) say "Usage: install.sh [--dry-run] [--install-cmux] [--glass | --no-glass] [--tabs | --no-tabs] [--master | --releases] [--no-launchd]"; exit 0 ;;
      *) say "Unknown option: $a (see --help)"; exit 1 ;;
    esac
  done
  case ${CHANNEL:-releases} in
    releases|master) ;;
    *) say "CMUX_CLAUDE_SIDEBAR_CHANNEL is releases or master, not $CHANNEL"; exit 1 ;;
  esac
}

# The newest vX.Y.Z among the tag names on stdin.
newest_release() { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1; }

# A clone the installer looks after: its own copy, or one it marked with a channel. Any
# other clone is someone's working copy.
managed() {
  [ -n "$(git -C "$1" config --get cmux-sidebar.channel 2>/dev/null)" ] && return 0
  [ "$(cd "$1" && pwd -P)" = "$(cd "$MANAGED_DIR" 2>/dev/null && pwd -P)" ]
}

# Puts a managed clone on its channel: the newest release, master while there is none
# yet, or master's newest commit with --master. The channel stays in the clone's git
# config (cmux-sidebar.channel), for the next run and for update.sh.
pick_version() {
  d=$1
  command -v git >/dev/null 2>&1 || return 0
  ch=${CHANNEL:-$(git -C "$d" config --get cmux-sidebar.channel || true)}
  ch=${ch:-releases}
  if [ "$DRY" = 1 ]; then
    tag=$(git -C "$d" ls-remote --tags --refs origin 'v*' 2>/dev/null | sed 's#.*refs/tags/##' | newest_release)
    if [ "$ch" = releases ] && [ -n "$tag" ]; then say "  would install release $tag"; else say "  would install master's newest commit"; fi
    return 0
  fi
  if [ -n "$(git -C "$d" status --porcelain --untracked-files=no)" ]; then
    say "  it has local changes, so it's installed as it is"
    return 0
  fi
  git -C "$d" config cmux-sidebar.channel "$ch"
  if ! git -C "$d" fetch -q --tags --force origin; then
    say "  couldn't reach $(git -C "$d" remote get-url origin), so it's installed as it is"
    return 0
  fi
  tag=$(git -C "$d" tag -l 'v*' | newest_release)
  if [ "$ch" = releases ] && [ -n "$tag" ]; then
    if git -C "$d" checkout -q --detach "$tag"; then say "  release $tag"; return 0; fi
  elif git -C "$d" checkout -q master && git -C "$d" merge -q --ff-only origin/master; then
    if [ "$ch" = master ]; then say "  master, at $(git -C "$d" log -1 --format=%h)"; else say "  no release yet, so master's newest commit"; fi
    return 0
  fi
  say "  couldn't switch it, so it's installed as it is"
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
  if [ -n "$dir" ] && ! managed "$dir"; then
    say "Installing from your own clone, as it is: $dir"
  elif [ "$DRY" = 1 ] && [ -z "$dir" ] && [ ! -d "$MANAGED_DIR/.git" ]; then
    tmp=$(mktemp -d)
    say "Dry run: fetching a temporary copy of the repo into $tmp"
    git clone -q "$REPO_URL" "$tmp/cmux-claude-sidebar"
    dir=$tmp/cmux-claude-sidebar
    pick_version "$dir"
  else
    verb=Updating
    [ "$DRY" = 0 ] || verb="Dry run: would update"
    if [ -n "$dir" ]; then
      say "$verb the copy an earlier install uses: $dir"
    elif [ -d "$MANAGED_DIR/.git" ]; then
      dir=$MANAGED_DIR
      say "$verb $dir"
    else
      dir=$MANAGED_DIR
      say "Downloading cmux-claude-sidebar into $dir"
      git clone -q "$REPO_URL" "$dir"
    fi
    pick_version "$dir"
  fi
  export CMUX_SIDEBAR_PICKED=1
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

# Links an installed file to the clone, unless it already is.
link() {
  [ "$(readlink "$2" 2>/dev/null)" = "$1" ] && return 0
  run ln -sf "$1" "$2"
  LINKED="$LINKED $(basename "$2")"
}

link_files() {
  step "Sidebar files (symlinks into ~/.config/cmux)"
  run mkdir -p "$CMUX_DIR/sidebars" "$CMUX_DIR/icons" "$CMUX_DIR/bin"
  LINKED=""
  link "$REPO/sidebars/agent-status.js" "$CMUX_DIR/sidebars/agent-status.js"
  link "$REPO/scripts/last-prompt-sync.py" "$CMUX_DIR/last-prompt-sync.py"
  link "$REPO/scripts/claude-worktree.py" "$CMUX_DIR/claude-worktree"
  link "$REPO/scripts/claude-statusline.py" "$CMUX_DIR/claude-statusline.py"
  link "$REPO/scripts/update.sh" "$CMUX_DIR/update.sh"
  if [ -z "$LINKED" ]; then
    say "  all in place"
  elif [ "$DRY" = 0 ]; then
    say "  linked:$LINKED"
  fi
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
    REBUILT=1
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

# Optional: a glass sidebar the desktop shows through, next to a solid terminal. The glass
# is cmux's sidebar material; Ghostty's config (cmux reads it) keeps the terminal opaque.
# An earlier install's "glass terminal" block stays: the new block comes after it and wins.
glass() {
  if [ "$GLASS" = ask ]; then
    printf '\n'
    if ask "Also make the sidebar glass (the desktop shows through it, the terminal stays solid)?"; then GLASS=yes; else GLASS=no; fi
  fi
  if [ "$GLASS" != yes ]; then
    say "  no glass (add it any time: install.sh --glass)"
    return 0
  fi
  step "Glass sidebar"
  g=$HOME/.config/ghostty/config
  marker="# cmux-claude-sidebar: glass sidebar, solid terminal"
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
  # The soft themes the block names; a theme of the same name the person has stays.
  for t in cmux-soft-light cmux-soft-dark; do
    if [ -e "$HOME/.config/ghostty/themes/$t" ]; then
      say "  kept your ~/.config/ghostty/themes/$t"
    else
      run mkdir -p "$HOME/.config/ghostty/themes"
      run cp "$REPO/config/themes/$t" "$HOME/.config/ghostty/themes/$t"
    fi
  done
  # A theme picked in cmux's Settings → Themes lives in cmux's own Ghostty file, read after
  # ~/.config/ghostty/config, and wins over the soft one.
  cg="$HOME/Library/Application Support/com.cmuxterm.app/config.ghostty"
  if [ -f "$cg" ] && grep -q '^theme *=' "$cg" && ! grep -q 'cmux-soft-light' "$cg"; then
    todo "For the soft terminal colours, change the theme line in $cg to: theme = light:cmux-soft-light,dark:cmux-soft-dark (cmux's Settings → Themes wrote it, and it wins over ~/.config/ghostty/config)"
  fi
  # menu lets the most desktop through while the text stays readable (with the 0.15 tint
  # from the snippet); active keeps the glass when the window isn't focused, where
  # followWindow turns the sidebar flat gray.
  run defaults write com.cmuxterm.app sidebarBlendMode -string behindWindow
  run defaults write com.cmuxterm.app sidebarMaterial -string menu
  run defaults write com.cmuxterm.app sidebarState -string active
}

# On by default: the skill in skills/cmux-tabs, which has Claude open a separate task in a
# new cmux tab of its own. The sync job links it into ~/.claude/skills unless the sidebar's
# right-click menu has it unticked; --no-tabs / --tabs set that tick from here.
tabs_skill() {
  step "Tasks in new tabs"
  case $TABS in
    no) run "$PY" -I "$REPO/scripts/last-prompt-sync.py" --tabs off
        [ "$DRY" = 1 ] || say "  off (tick it again: right-click the sidebar → Tasks in new tabs)" ;;
    yes) run "$PY" -I "$REPO/scripts/last-prompt-sync.py" --tabs on
         [ "$DRY" = 1 ] || say "  on: Claude opens a separate task in a new cmux tab" ;;
    *) say "  on unless you untick it: Claude opens a separate task in a new cmux tab."
       say "  To turn it off: right-click the sidebar → Tasks in new tabs (or install.sh --no-tabs)." ;;
  esac
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
  # An update keeps whichever sidebar the person has picked.
  if [ "$UPDATE" = 1 ]; then
    if "$CMUX" reload-config >/dev/null 2>&1; then
      say "  cmux reloaded its settings and the sidebar"
    else
      say "  couldn't reach cmux (is it open?)"
      todo "Open cmux, then run: cmux reload-config"
    fi
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
# A job is (re)loaded only when its plist changed or it isn't loaded; the scripts it runs
# are symlinks, so it picks up a new version by itself. The window watcher is a built
# binary, so a rebuild restarts it.
launch_jobs() {
  step "Background jobs (launchd)"
  for label in com.propeller.cmux-last-prompt com.propeller.cmux-window-watch; do
    if [ "$label" = com.propeller.cmux-window-watch ] && [ "$DRY" = 0 ] && [ ! -x "$CMUX_DIR/bin/cmux-window-watch" ]; then
      continue
    fi
    plist=$HOME/Library/LaunchAgents/$label.plist
    if [ "$DRY" = 1 ]; then
      say "  would write $plist and load it, unless it's already loaded as it is"
      continue
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    want=$(sed "s#__HOME__#$HOME#g" "$REPO/launchd/$label.plist")
    loaded=1
    if [ "$LAUNCHD" = 1 ] && ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then loaded=0; fi
    if [ -f "$plist" ] && [ "$(cat "$plist")" = "$want" ] && [ "$loaded" = 1 ]; then
      if [ "$label" = com.propeller.cmux-window-watch ] && [ "$REBUILT" = 1 ] && [ "$LAUNCHD" = 1 ]; then
        launchctl kickstart -k "gui/$(id -u)/$label" >/dev/null && say "  $label restarted (its binary was rebuilt)"
      else
        say "  $label unchanged"
      fi
      continue
    fi
    printf '%s\n' "$want" > "$plist"
    if [ "$LAUNCHD" = 1 ]; then
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$plist"
      say "  $label running"
    else
      say "  wrote $plist (not loaded: --no-launchd)"
    fi
  done
}

# What the clone is at, for the summary: a release, or a branch and commit.
version_label() {
  v=$(git -C "$REPO" tag --points-at HEAD 2>/dev/null | newest_release)
  if [ -n "$v" ]; then
    say "$v"
  else
    say "$(git -C "$REPO" symbolic-ref -q --short HEAD 2>/dev/null || echo detached) at $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '?')"
  fi
}

summary() {
  printf '\n'
  if [ "$DRY" = 1 ]; then
    say "Dry run: nothing was changed."
  elif [ "$UPDATE" = 1 ]; then
    # The sync job sees the new version on its next run, so that run happens now.
    [ "$LAUNCHD" = 0 ] || launchctl kickstart "gui/$(id -u)/com.propeller.cmux-last-prompt" >/dev/null 2>&1 || true
    say "Up to date: $(version_label). This tab can be closed."
  elif command -v git >/dev/null 2>&1 && managed "$REPO"; then
    say "Done: $(version_label). When a new release is out, the sidebar shows a \"New version\" chip:"
    say "click it, or run: sh ~/.config/cmux/update.sh"
  else
    say "Done, from your own clone as it is ($(version_label)). Update it there with git."
  fi
  if [ -n "$TODO" ]; then
    say "Left for you:$TODO"
  fi
}

main() {
  parse_args "$@"
  find_repo || fetch_and_rerun "$@"
  # Run from inside its own copy (~/.cmux-claude-sidebar/install.sh): the version first,
  # then that version's installer.
  if [ "$UPDATE" = 0 ] && [ -z "${CMUX_SIDEBAR_PICKED:-}" ] && command -v git >/dev/null 2>&1 && managed "$REPO"; then
    step "Version"
    before=$(git -C "$REPO" rev-parse HEAD)
    pick_version "$REPO"
    if [ "$(git -C "$REPO" rev-parse HEAD)" != "$before" ]; then
      export CMUX_SIDEBAR_PICKED=1
      exec sh "$REPO/install.sh" "$@"
    fi
  fi
  check_tools
  link_files
  build_helpers
  merge_config
  statusline
  [ "$UPDATE" = 1 ] || glass
  tabs_skill
  activate
  launch_jobs
  summary
}

# Everything above only defines functions, so a download cut short runs nothing.
main "$@"
