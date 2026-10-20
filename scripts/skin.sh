#!/bin/sh
# Switch cmux between its usual look and System 1 (a 1984 Macintosh), without a restart.
#
#   scripts/skin.sh system1        pixel sidebar, 1-bit terminal in a pixel font
#   scripts/skin.sh system1-lite   pixel sidebar, 1-bit terminal in your usual font
#   scripts/skin.sh normal         back to the usual look (glass, your fonts and colours)
#   scripts/skin.sh status         which skin is on
#   scripts/skin.sh uninstall      normal, and ~/.config/ghostty/config exactly as before
#
# The terminal: ~/.config/ghostty/config gets one line at the end, an optional include
# of ~/.config/ghostty/cmux-skin, and this script fills that file from config/skins/
# (empty for normal, so normal is your own config untouched). Before the first change
# the config is copied to config.before-skin. The sidebar: a "skin:" token that the
# sync job carries (scripts/last-prompt-sync.py --skin). Then `cmux reload-config`.
# The sidebar's own Look menu sets the token; the sync job then calls this script with
# --terminal-only, so the terminal follows within its 15 s.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd -P)
GHOSTTY_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/ghostty"
CONFIG="$GHOSTTY_DIR/config"
BACKUP="$CONFIG.before-skin"
SKIN_FILE="$GHOSTTY_DIR/cmux-skin"
CMUX="${SKIN_CMUX:-/Applications/cmux.app/Contents/Resources/bin/cmux}"   # tests point it at /usr/bin/true
INCLUDE_COMMENT="# cmux skin (scripts/skin.sh in cmux-claude-sidebar): empty unless a skin is on."
INCLUDE_LINE="config-file = ?cmux-skin"

terminal_only=0
if [ "${1:-}" = "--terminal-only" ]; then terminal_only=1; shift; fi
name="${1:-}"

current() {
  sed -n '1s/^# cmux-skin: \([^ ]*\).*/\1/p' "$SKIN_FILE" 2>/dev/null | grep . || echo normal
}

reload() {
  if [ -x "$CMUX" ]; then "$CMUX" reload-config >/dev/null 2>&1 || echo "cmux reload-config failed; run it yourself" >&2; fi
}

case "$name" in
  status)
    echo "$(current)"
    exit 0 ;;
  uninstall)
    if [ -f "$CONFIG" ]; then
      # Drop the two lines this script appended; what's left is the config as it was.
      grep -vxF -e "$INCLUDE_COMMENT" -e "$INCLUDE_LINE" "$CONFIG" > "$CONFIG.tmp" || true
      mv "$CONFIG.tmp" "$CONFIG"
    fi
    rm -f "$SKIN_FILE"
    [ "$terminal_only" = 1 ] || python3 "$ROOT/scripts/last-prompt-sync.py" --skin normal || true
    reload
    if [ -f "$BACKUP" ] && cmp -s "$CONFIG" "$BACKUP"; then
      echo "normal; $CONFIG is byte for byte the one from before the first skin ($BACKUP)"
    else
      echo "normal; $CONFIG differs from $BACKUP (edited since?), compare them: diff $BACKUP $CONFIG"
    fi
    exit 0 ;;
  normal|system1|system1-lite) ;;
  *)
    sed -n '2,8s/^# \{0,1\}//p' "$0" >&2
    exit 2 ;;
esac

mkdir -p "$GHOSTTY_DIR"
# Saved once, before this script ever touches the config: the way back to exactly this.
if [ -f "$CONFIG" ] && [ ! -e "$BACKUP" ]; then cp -p "$CONFIG" "$BACKUP"; fi
if ! grep -qxF "$INCLUDE_LINE" "$CONFIG" 2>/dev/null; then
  # A config that doesn't end in a newline would glue the comment to its last line.
  if [ -s "$CONFIG" ] && [ -n "$(tail -c 1 "$CONFIG")" ]; then echo >> "$CONFIG"; fi
  printf '%s\n%s\n' "$INCLUDE_COMMENT" "$INCLUDE_LINE" >> "$CONFIG"
fi

# The pixel font: Departure Mono, SIL OFL 1.1, has the whole Ukrainian alphabet.
if [ "$name" = system1 ] && [ ! -f "$HOME/Library/Fonts/DepartureMono-Regular.otf" ]; then
  mkdir -p "$HOME/Library/Fonts"
  cp "$ROOT/fonts/DepartureMono-Regular.otf" "$HOME/Library/Fonts/"
fi

{
  echo "# cmux-skin: $name (written by scripts/skin.sh; switch with scripts/skin.sh normal|system1|system1-lite)"
  [ "$name" = normal ] || cat "$ROOT/config/skins/$name.ghostty"
} > "$SKIN_FILE.tmp"
mv "$SKIN_FILE.tmp" "$SKIN_FILE"

[ "$terminal_only" = 1 ] || python3 "$ROOT/scripts/last-prompt-sync.py" --skin "$name" || true
reload
echo "$name"
