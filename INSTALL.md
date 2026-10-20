# Installing the Claude sidebar for cmux (instructions for Claude Code)

You're installing a custom sidebar for [cmux](https://cmux.com) for the person you're working with. `install.sh` does the work and never overwrites their settings; your job is to check, show them the plan, ask the one or two questions below, run it and verify. Keep your messages short and in the person's language.

## 1. Check what's there

- **cmux ≥ 0.65**: `/Applications/cmux.app/Contents/Resources/bin/cmux --version` (or `cmux --version`).
  - Missing: ask the person whether to install it with Homebrew (`brew install --cask cmux`; cmux updates itself afterwards). Only with a yes, run it, or pass `--install-cmux` to the installer in step 4. No Homebrew: point them to https://brew.sh or https://cmux.com and stop until cmux is installed.
  - Older than 0.65: ask them to update cmux first (custom sidebars need 0.65).
- **Python 3**: `/usr/bin/python3 --version`. If macOS offers to install the command line tools, let the person accept; they're also what builds two optional helpers (the window watcher and the Claude icon). Without them the sidebar still works.
- **git**: `git --version` (comes with the same command line tools).

## 2. Get the repo

If `~/.config/cmux/sidebars/agent-status.js` is already a symlink, the sidebar is installed. To update it, run `sh ~/.config/cmux/update.sh` (if the install is the person's own clone, it says so and leaves it alone) and go to step 5. Without `~/.config/cmux/update.sh` (an install from before releases), continue with the clone the symlink points to (`readlink` it, two folders up). Otherwise:

```sh
git clone https://github.com/sahneo/cmux-claude-sidebar ~/.cmux-claude-sidebar
```

`install.sh` puts this clone on the latest release (a `vX.Y.Z` tag), or on master while there is none. Only if the person asks for the newest unreleased code, add `--master` to the commands below.

## 3. Show the plan

```sh
~/.cmux-claude-sidebar/install.sh --dry-run --no-glass
```

It writes nothing. Summarise the output for the person in a few lines: which keys get added to `~/.config/cmux/cmux.json` ("added …"), which of their own values stay ("kept yours …"), anything marked `NEEDS A FIX`, and what happens with the Claude Code status line.

Then ask:

1. **Glass terminal?** A translucent terminal with blur (adds `config/ghostty.config` to `~/.config/ghostty/config`, and sets the cmux sidebar material). Default no.
2. Only if the dry run says they have **their own status line** that doesn't save the limits: may you add the two lines it shows to their status line script? The limit card stays empty without them. Show the exact lines and the file before editing; back the file up first.

## 4. Install

```sh
~/.cmux-claude-sidebar/install.sh --glass      # or --no-glass
```

Add `--install-cmux` only if the person agreed to install cmux in step 1. Pass `--glass` or `--no-glass` so the script doesn't stop to ask: you're not at a terminal it can read from.

What it does: symlinks the sidebar and its scripts into `~/.config/cmux`; builds the window watcher and extracts cmux's Claude icon (skipped without Xcode tools); adds the missing keys from `config/cmux.snippet.jsonc` to `cmux.json` (backup `cmux.json.bak-<time>` next to it, and the previous file comes back if cmux rejects the result); sets a minimal Claude Code status line that saves the usage limits if there's none (backup of `~/.claude/settings.json`); reloads cmux and selects the sidebar; loads two launchd jobs (`com.propeller.cmux-last-prompt`, `com.propeller.cmux-window-watch`).

If it reports `NEEDS A FIX` (`automation.socketControlMode` isn't `"automation"`): explain that the background sync job talks to cmux from outside the app and needs it, and with a yes change just that value (`cmux config set automation.socketControlMode automation`, which keeps the rest of the file).

## 5. Verify

```sh
cmux config validate
cmux sidebar validate agent-status
launchctl print gui/$(id -u)/com.propeller.cmux-last-prompt | grep state
```

All three should succeed. If cmux wasn't running, ask the person to open it, then run `cmux reload-config && cmux sidebar select agent-status`.

## 6. Report back

In a few lines: that the sidebar is on; which keys were added to `cmux.json` and where the backups are; whether the limit card will fill in (it does after the next Claude reply, once the status line has run); and anything from the installer's "Left for you" list. Tell them that when a new release is out, the sidebar shows a "New version" chip above the activity card: a click updates, a right-click shows what's new.

## Undo

- Back to the stock sidebar: right-click the sidebar button → Workspaces.
- Stop the jobs: `launchctl bootout gui/$(id -u)/com.propeller.cmux-last-prompt` and `launchctl bootout gui/$(id -u)/com.propeller.cmux-window-watch`, then delete their plists from `~/Library/LaunchAgents`.
- Settings: restore `~/.config/cmux/cmux.json.bak-<time>` and `~/.claude/settings.json.bak-<time>` (or remove the added keys), then `cmux reload-config`.
