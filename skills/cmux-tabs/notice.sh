#!/bin/sh
# Prints "say" for the first 3 tabs this skill opens, then "quiet", and counts each call.
# The count lives in ~/.claude/cmux-tabs-notices (one number); delete it to start over.
# If the count can't be saved, it's "quiet": better silent than the same line every time.
f=$HOME/.claude/cmux-tabs-notices
n=$(tr -cd 0-9 2>/dev/null < "$f")
n=${n:-0}
if [ "$n" -lt 3 ] && mkdir -p "$HOME/.claude" 2>/dev/null && (printf '%s\n' $((n + 1)) > "$f") 2>/dev/null; then
  echo say
else
  echo quiet
fi
