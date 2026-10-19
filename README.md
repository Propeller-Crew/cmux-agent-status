# cmux agent status

A sidebar for [cmux](https://github.com/manaflow-ai/cmux) when most of your tabs run Claude Code: workspaces grouped by what they need from you, with the state of every agent at a glance, and your Claude usage limit on top.

- **Sections by attention**, as coloured pills: Needs you (a permission prompt or a quiz is open) · New (done, not read yet, tinted blue) · Working · Done · Sleeping (no prompt for a day).
- **Real "last time you wrote here"**, read from Claude's transcripts, so a cmux restart doesn't turn every tab into "22h".
- **Background work counts as working**: Claude ended its turn but a background command or background agents are still running and it will pick up on its own. An idle dev server doesn't count.
- **Progress of background agents** as segments ("12/16") while a batch runs.
- **Tabs under their workspace** once it has more than one, each with its own state.
- **Park a workspace**: drag it into Sleeping (or right-click → Put to sleep). It wakes when you write in it again.
- **Activity card** under the list, styled like an iPhone Live Activity, with pages (click the card or a dot; cmux sidebars get no swipe gestures):
  - **Limit**: the 5-hour Claude Code limit with a bar, when it resets and in how long, plus the weekly one, so you don't open the Claude app just to check;
  - **Today**: prompts sent, time spent in Claude, agents started, and how many days in a row you've been at it;
  - **This project**: time and prompts in the selected workspace's Claude sessions.
- **A pixel octopus** in a propeller beanie on that card: asleep when nothing happens, spinning its propeller while agents work, waving when one waits on you, celebrating fresh results.
- **Right-click → Open here**: Claude on its own git worktree, a second Claude, the local site in the Dock, an iOS simulator.
- **Tab strip buttons**: a Claude tab and a Claude-on-a-new-branch tab (`claude -w`) for running several fixes in parallel.
- **English or Ukrainian**: follows macOS; switch with right-click on the activity card or any section header.

## Install

Needs cmux ≥ 0.65 (custom sidebars beta, on by default) and Python 3 (macOS ships it).

```sh
git clone https://github.com/Propeller-Crew/cmux-agent-status ~/code/cmux-agent-status
~/code/cmux-agent-status/install.sh
```

Then two manual steps:

1. Merge `config/cmux.snippet.jsonc` into `~/.config/cmux/cmux.json` and run `cmux reload-config`.
2. For the limit card, let your Claude Code [status line](https://docs.claude.com/en/docs/claude-code/statusline) script save the limits it receives (needs `jq`):

   ```sh
   limits=$(echo "$input" | jq -c '.rate_limits // empty')
   [ -n "$limits" ] && printf '%s' "$limits" > "$HOME/.claude/rate-limits.json"
   ```

The `automation` socket mode in the snippet is required: the sync job runs from launchd, outside cmux. `config/ghostty.config` (terminal transparency and blur) is optional; it goes to `~/.config/ghostty/config`.

Update: `git pull`. The installed files are symlinks into this repo, and cmux hot-reloads the sidebar.

Back to the stock sidebar: right-click the sidebar button → Workspaces. Stop the sync job: `launchctl bootout gui/$(id -u)/com.propeller.cmux-last-prompt`.

## How it works

| Piece | Where | What |
| --- | --- | --- |
| `sidebars/agent-status.js` | `~/.config/cmux/sidebars/` | The sidebar (cmux's reactive JS runtime). Started from cmux's bundled `workspaces.js` template. |
| `scripts/last-prompt-sync.py` | `~/.config/cmux/` | Every 15 s: last prompt per workspace from the Claude transcripts, background work, agent progress, usage limits. Writes them into the workspace description (`last prompt @<epoch> · bg · zz@<epoch>`, plus `lim:… · lang:…` on one workspace), the only field an outside process can set and a sidebar can read. Leaves descriptions in any other format alone. |
| `scripts/extract-claude-icon.swift` | run by `install.sh` | Copies cmux's own Claude icon to `~/.config/cmux/icons/claude.png` for the tab-strip button. |
| `launchd/com.propeller.cmux-last-prompt.plist` | `~/Library/LaunchAgents/` | Runs the sync job. Log: `~/.config/cmux/last-prompt-sync.log`. |

Gotchas found on the way (cmux 0.65.2):

- `ProgressView()` ignores `.frame` and overflows the row; the spinner is an SF Symbol rotated on the clock tick.
- `.monospacedDigit()` and `.disabled()` don't exist in the JS runtime, and menu items can't be hidden.
- cmux reports `backgroundWorkPending` for an idle background server too, and older Claude versions never wrote `finished` into subagent meta files, so neither is trusted on its own.
- The sidebar scrolls as one piece and doesn't know the window height, so nothing can be pinned to its bottom; Sleeping starts folded to keep the activity card in view.
- cmux names a workspace after its focused tab; opening a simulator renamed it to "Simulator". The sidebar keeps the Claude tab's name.

## Licence

GPL-3.0-or-later, like cmux: `sidebars/agent-status.js` started from cmux's `workspaces.js` sidebar template.
