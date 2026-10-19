#!/bin/sh
# Installs the agent-status sidebar and its sync job for the current macOS user.
# Files are symlinked, so `git pull` in this repo updates a running install.
set -eu
REPO=$(cd "$(dirname "$0")" && pwd)
CMUX_DIR="$HOME/.config/cmux"
CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
LABEL=com.propeller.cmux-last-prompt
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$CMUX_DIR/sidebars" "$HOME/Library/LaunchAgents"
ln -sf "$REPO/sidebars/agent-status.js" "$CMUX_DIR/sidebars/agent-status.js"
ln -sf "$REPO/scripts/last-prompt-sync.py" "$CMUX_DIR/last-prompt-sync.py"
ln -sf "$REPO/scripts/claude-worktree.py" "$CMUX_DIR/claude-worktree"
mkdir -p "$CMUX_DIR/icons" "$CMUX_DIR/bin"
swiftc -O "$REPO/scripts/window-height.swift" -o "$CMUX_DIR/bin/cmux-window-height" \
  || echo "Window-height helper not built (needs Xcode command line tools); the activity card sits right under the list."
swift "$REPO/scripts/extract-claude-icon.swift" "$CMUX_DIR/icons/claude.png" \
  || echo "Claude icon not extracted (needs Xcode command line tools); the tab-bar button falls back to text."

sed "s#__HOME__#$HOME#g" "$REPO/launchd/$LABEL.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

"$CMUX" sidebar validate agent-status && "$CMUX" sidebar select agent-status
echo
echo "Done. One manual step: merge config/cmux.snippet.jsonc into $CMUX_DIR/cmux.json"
echo "(automation.socketControlMode = \"automation\" is required for the sync job), then: cmux reload-config"
