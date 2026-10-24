---
name: its-not-a-kanban
description: Set up and run "It's not a Kanban", a bounty board that dispatches AI coding agents and only counts work as done when it is merged. Use when the user says to set up the board, start a board for a project, file or track work on a board, orchestrate agents, or asks "where are we at" on a project that has a board. Also use at the start of any multi-step project the user wants tracked, if it has no board yet.
---

# It's not a Kanban

A board per project. Workers are spawned by the board, one fresh agent per bounty. A bounty reaches **done** only when its commits are on the project's main branch. The user checks progress on the board's **Status** page (goals) and **Live** page (agents), from any device on their Tailscale network, instead of asking you.

Repo: `https://github.com/KewkLW/bounty-board`. Its `README.md` is the reference for every config key, CLI verb and gate; read the sections named below before acting.

## 1. First-time install (once per machine)

1. Clone the repo somewhere stable (e.g. `~/bounty-board`), `npm install`, `npm test`.
2. Put the CLI on PATH: symlink `bin/bounty` into a directory on PATH.
3. Check what the workers need: `claude` and/or `codex` on PATH and logged in. The reviewer runs `codex exec`; if Codex is not available, say so to the user before relying on automated review.
4. Do not start a board yet. Boards are per project (section 2).

## 2. Start a board for a project

Do this before any work on the project starts. Never file a project's work on another project's board.

1. **Board dir** outside the repo, e.g. `~/boards/<project>/` with `data/`, `logs/`, `run/`.
2. **Config** `board.json` from `config/board.example.json`:
   - a free `port` (check with `ss -ltn`; every board needs its own),
   - `default_project`, `concurrency_cap`, `db_path`, `logs_dir`, `public_dir` (step 4),
   - `slots`: each slot gets a stable, unique `name` from a theme that fits the project. Names never change for the project's life.
   - `machine_rules`: the project's hard rules (private repo, no secrets, ports to avoid, how to run tests, where evidence goes). Every worker prompt carries them.
3. **Service**: a user unit per board from `systemd/bounty-board.service` with `Environment=BOUNTY_CONFIG=<board dir>/board.json` and `Environment=BOUNTY_NO_SEED=1`. Keep `KillMode=process` so a restart never kills workers. Enable it, then `pause` dispatch until work is filed.
4. **Themed UI, designed from the project**: copy the repo's `public/` into the board dir and give it a look that comes from the project itself: its palette, logo or art, typography, mood, page titles, and slot portraits that match the slot names (colors in `op.css` / `op-theme.js`, portraits in `avatars.js`). Read the project's README, assets and UI first and design from them; a recolor of the default is not a theme. Mandatory, not polish: the user should know which board they are on at a glance. Keep any art you take from the project local to the board (never push someone's art to a public repo). Keep `status.js` and `status.css` symlinked to the repo's copies so fixes reach every board.
5. **CLI wrapper**: a tiny script `<prefix>-bounty` that exports `BOUNTY_URL=http://127.0.0.1:<port>` and execs `bin/bounty`.
6. **Project**: `<prefix>-bounty project add <id> --repo <path> --main <branch> --verify "<test command>" --wt-cmd "git worktree add {path} -b {branch} {main}" --wt-path "<worktree dir>/{branch}"`. The verify command is the merge gate; pick one that really fails on broken code.
7. **Goals** (README, "The Status page"): write `public/status-goals.json` from the project's plan. Each goal has a one-line `goal`, an exit `test` someone can check, a `road` (bounty ids) or `road_prefix`, and a `gate` bounty (the acceptance run). If there is no plan, ask the user what "done" means before inventing goals.
8. **Note**: write `public/status-notes.json` (`written_at`, `headline`, `body`).
9. **Phone access**: tell the user the tailnet URL (`http://<machine>.<tailnet>.ts.net:<port>/status.html`). `allow_cidrs` already admits Tailscale addresses; never widen it to the public internet.
10. Open `/status.html` and `/live` yourself and check they render, then tell the user the URLs.

## 3. Filing work

- One bounty = one reviewable change. Title prefix with the goal id (`M2.3 ...`) so the Status page can build each goal's road.
- Acceptance criteria are what the reviewer checks against the real diff: observable, one thing each, specific (README, "Writing good acceptance criteria").
- Work already done off the board (by you or the user) is logged too: file it, then `close-merged ID --commit SHA "evidence"`. External work credits no slot.
- Anything waiting on the user (a login, a dashboard, hardware): file it and `block` it with the exact step they need to do. It then shows under "Needs attention".

## 4. Every round while work is running

- Answer blocks and questions in workers' progress notes with `note`.
- Read every reject; fix criteria drift on your side, let real faults re-run.
- Merge through the verify gate; never mark done by hand what is not on main.
- **Rewrite `status-notes.json`** (it is flagged stale after 3 hours) and keep `status-goals.json` true. A goal is reached only when its exit test is captured: set `state: "reached"` with `when` and `evidence`, or mark its gate bounty done. A road that is all done without that stays "exit test not recorded" on purpose.
- When the user asks "where are we at", answer from the Status page and point them to it.

## Names, everywhere

Every agent has a specific, stable name plus the project tag for the project's whole life, so the user can tell agents apart on the board, in telemetry and in their terminals.

- **Board slots**: the `name` in `board.json` (the board refuses an unnamed slot). It shows on every page and rides on telemetry as `agent.name` next to `project` and `bounty.id`. Slot workers run headless, so the board is where their name shows.
- **Hand-launched agents and the orchestrator** (interactive sessions in a terminal): launch with `AGENT_NAME=<name> AGENT_PROJECT=<project> AGENT_ROLE=agent|orchestrator` in the environment and have the terminal's status line print them, one color for agents and another for orchestrators. A Claude Code status line (`statusLine` in `settings.json`) can do it:
  ```bash
  #!/usr/bin/env bash
  # Claude Code status line: show the agent's name and project, purple for orchestrators, green for agents.
  cat >/dev/null   # the session JSON on stdin is not needed here
  [ -z "$AGENT_NAME" ] && exit 0
  color=32; [ "$AGENT_ROLE" = orchestrator ] && color=35
  printf '\033[1;%sm%s\033[0m %s' "$color" "$AGENT_NAME" "${AGENT_PROJECT:+· $AGENT_PROJECT}"
  ```
- A bare, unnamed agent is a bug: name it before it does any work. Pick the project's name list when you start its board (a theme that fits the project) and take new names from it.

## Rules

- You orchestrate; workers write the task code. Doing the work yourself skips the gates that make "done" mean something.
- Never mark a bounty done or a goal reached without evidence on main or a recorded run.
- One board per project, its own port, unit, CLI, theme and goals.
- Keep secrets, signing material and real user data out of bounties, evidence and the board's public files.
