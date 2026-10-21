---
name: cmux-tabs
description: Inside cmux (CMUX_WORKSPACE_ID is set), hand a separate task to a new cmux tab with its own Claude instead of doing it in this conversation. Use whenever the user asks for something that clearly drifts from what this tab is about and would make a session of its own — another project, a separate feature or bug, a long piece of work — and then watch that tab and come back with its result. Not for small, quick things or for continuing the current topic.
---

# Separate task → a new cmux tab, on your own

This only applies inside cmux: `echo "$CMUX_WORKSPACE_ID"` prints an id. Without it, work as usual.

## When

- **New tab**: the task noticeably leaves the topic of this tab and would deserve its own session — a different project, a separate feature or bug, a long job. Don't do it here and don't ask whether to: open the tab yourself.
- **Here**: small and quick things, follow-ups, anything that continues the current topic.

## How

1. **Write a brief** to a file in your scratchpad (or `$TMPDIR`). Always with a quoted heredoc, `<<'EOF'`: in an unquoted one, backticks in the text run as commands.

   ```sh
   cat > "$BRIEF" <<'EOF'
   ...
   EOF
   ```

   The brief stands on its own — the new Claude sees nothing of this conversation:
   - the context it needs: project, paths, what was already found or decided;
   - the user's request, quoted in their own words;
   - what counts as done;
   - for code: "a branch and a PR, don't merge it yourself";
   - "answer the user briefly, in <the language the user writes in>".

2. **Open the tab** in this same workspace, without taking focus:

   ```sh
   cmux new-surface --type terminal --workspace "$CMUX_WORKSPACE_ID" --focus false \
     --command "cd <dir> && claude -w <name> \"\$(cat <brief>)\""
   ```

   - Start it as plain `claude`, never by an absolute path (`~/.nvm/.../bin/claude`): cmux's `claude` shim on PATH adds the hooks that tell the sidebar the tab is working, done or waiting. Started by path, the tab shows no state at all.
   - In a git repo use `claude -w <name>`: Claude works in its own worktree, a separate copy, so the two sessions don't edit the same files. Outside a repo, plain `claude`.
   - The command prints `OK surface:<n> pane:<n> workspace:<n>`; keep the `surface:<n>` ref.

3. **Name the tab** the way a person would: `cmux rename-tab --surface surface:<n> "<short name>"`.

4. **Tell the user in one line** which tab you opened and what it does. Then carry on with this tab's own work.

5. **The first few times, say why.** This skill is on by default, so the user may not know where this behaviour comes from. Run `sh ~/.claude/skills/cmux-tabs/notice.sh` (it counts in `~/.claude/cmux-tabs-notices`). If it prints `say`, add one more line, in the user's language, e.g.:

   > I opened this in a new tab because the Claude sidebar's tab delegation is on. To turn it off: right-click the sidebar → **Tasks in new tabs**.

   Name the menu item the way the sidebar shows it in their language: **Tasks in new tabs** in English, **Задачі в нові вкладки** in Ukrainian. If it prints `quiet` (after three times), or the script is missing, say nothing about it.

## Watch it yourself

The user shouldn't have to go and check. Start a background loop that reads the tab, e.g. `cmux read-screen --surface surface:<n> --lines 40` every minute or so, and stop when the other Claude has finished its turn (its prompt is back and empty, the work is reported). As soon as it's done, come back with the result and a proposal: merge the PR, review a diff, the next step.

- **Never paste anything into a tab that is still working.** Wait until it is done.
- **Grey text in its input field is a Claude Code suggestion, not a draft by the user.** It doesn't mean someone is typing there.

## Keep live setups out of it

A session started to test something must not touch the user's live setup: symlinks in `~/.config`, the branch checked out in the main clone, live config files. It works on separate copies only (its worktree, a temporary `HOME`, a renamed copy of a file).

Before removing a worktree, check that nothing live points into it — for example `find ~/.config ~/.claude -maxdepth 3 -type l -lname '*<worktree path>*'` and any running process started from it. Remove it only when nothing does.

## Turning this off

This skill comes with the Claude sidebar for cmux and is on by default. Right-click the sidebar and untick "Tasks in new tabs" ("Задачі в нові вкладки"); new Claude sessions stop seeing it.
