# Wasteland Bounty Board

The single accountability system for every agent. Work that is not marked done on this board is a known gap.
Workers are spawned by the board, one fresh agent per bounty, and a bounty only reaches **done** when its commits are on the project's main branch.

- Dashboard: `http://<tailscale-ip>:3777/` (kanban, slots, locks, pause switch, add/edit/assign), `/roster`, `/leaderboard`
- CLI: `bounty help` (`~/.local/bin/bounty` -> `bin/bounty`)
- Service: `systemctl --user status bounty-board` (unit in `systemd/`, log `logs/server.log`)
- Tests: `npm test`

Only loopback and Tailscale addresses (100.64.0.0/10) may connect (`allow_cidrs` in `config/board.json`).

## Lifecycle

```
backlog -> ready -> in_progress -> review -> approved -> done
             plus blocked (with a reason) and failed
```

| Step | Who | What the board checks |
|---|---|---|
| backlog -> ready | orchestrator (`bounty ready`, UI) | a project, and at least one acceptance criterion |
| ready -> in_progress | the worker (`bounty start`) | the dispatcher spawned it for the assigned slot |
| in_progress -> review | `bounty submit`, then the gates | the branch exists; its diff against main is not empty; the diff is not only notes/logs/WORK_LOG (docs and research bounties may be docs-only); the project verify command passes on the branch tip (result and log stored) |
| review -> approved / ready | the reviewer (Codex, `codex exec -s read-only`) | reads the real diff and the acceptance criteria; returns approve/reject with per-criterion evidence; an approval that does not show every criterion met is overruled to reject. Reject sends the bounty back to ready with the notes for a fresh worker |
| approved -> done | the merge check (every 60 s, or `bounty done`) | every recorded commit is reachable from main (or main holds the same patch: rebase, cherry-pick or squash merges count) |

Work done off the board (an `external` bounty, e.g. one in flight before the board existed) never goes through submit, so it can't reach approved. When the orchestrator has merged it, `bounty close-merged ID --commit SHA [--commit SHA]... ["evidence"]` (API `POST /api/bounties/:id/close-merged {commits, evidence}`) takes it to done from any open status: every commit must exist in the project repo and be an ancestor of main (it is refused otherwise, and refused while the bounty has a live board worker or a verify running). The full SHAs join the bounty's commits, the evidence goes to `work_evidence`, and the done event records `close-merged by <actor>: <shas> on main` plus the evidence. Loot is paid as for any done. Orchestrator only.

`review`, `approved` and `done` are guarded edges: no request can set them directly. Workers (requests carrying a slot id) can't ready, assign, approve, reject, fail, pause or mark done.

## Dispatcher

- Slots in `config/board.json`: `opus-1..4` (claude, opus), `sonnet-tester` (claude, sonnet, effort low), `codex-1..2` (`codex exec`), each with model and effort, plus a global `concurrency_cap`.
- When a slot has no live worker and a `ready` bounty is assigned to it (dependencies done), the board creates the worktree with the project's command (Tribulation: `Scripts/wt.sh <task>`, which sets up the code/content split) and spawns one fresh worker. When the worker exits, the slot takes its next ready bounty; with none, it idles.
- Claude workers run `claude -p --output-format stream-json --verbose --model ... --effort ... --allowedTools ...`; Codex workers `codex exec --json`. The prompt (saved next to the log) holds the bounty, criteria, notes from earlier attempts, the project rule docs and the CLI protocol. Every attempt's log, exit code, tokens and cost ($ from Claude's result event; Codex reports tokens only) are stored and linked from the bounty.
- Watchdog: a worker silent for `watchdog.stall_minutes` (log output, heartbeats and `bounty progress` all count) is killed and the bounty blocked with the reason; a worker that exits without submitting is blocked too. The log stays attached.
- Retries: `retry.max_attempts`, and after `retry.escalate_after_failures` failures a bounty moves up a model (`escalate_model`, e.g. sonnet -> opus).
- Pause switch: `bounty pause` / `resume` or the header button. Running workers finish; nothing new spawns.
- Workers outlive a board restart (`KillMode=process`) and are re-attached when it starts.

## The GPU lease = the UE render lock

For Tribulation, `gpu` is not a board lock: it mirrors the machine-wide UE render flock (`/run/user/$UID/tribulation/ue-render.lock` and its holder file, from `Scripts/lib/ue-render-lock.sh`). One rendered UE instance at a time; workers take it with that script; `bounty lease gpu` and the dashboard show who holds it. Other resources (and projects without an external lock) use the board's own TTL lease table: exclusive, renewable, released on expiry or when the holder's worker dies or its bounty leaves in_progress.

## Worker protocol (the prompt repeats it)

```
bounty start                       # first (prints any waiting orchestrator notes)
bounty inbox                       # unread orchestrator notes, marked read; after start, each major step, every ~15 min
bounty progress "note" [--check N] # heartbeat, at least every 15 min (also prints unread notes)
bounty split "title" --desc "..."  # gaps found go to backlog as children
bounty block "reason"              # stuck: block and exit
bounty submit                      # commit on the branch first; gates + review follow
```

The prompt also carries `machine_rules` from `config/board.json` (one rendered UE instance, `free -g` before heavy jobs, test ports below 32768, don't kill what you didn't start) and every orchestrator note on the bounty.

## Notes to live workers

`bounty note ID "text"` (API `POST /api/bounties/:id/notes {text}`, or the note box in the dashboard drawer) tells a running worker something new: a changed requirement, a machine rule. Notes are `message` events in the bounty history with a read mark. The worker gets unread ones from `bounty inbox`, and in the output of `bounty start` and `bounty progress`; each gets marked read by whoever received it. Every later attempt gets all notes in its prompt. `bounty inbox ID --peek` (`GET /api/bounties/:id/inbox`) shows what a worker hasn't read yet without marking it; `bounty inbox ID --all` lists all notes with read state.

## Orchestrator day to day

```
bounty status                          # slots, locks, counts
bounty list [--project tribulation] [--status ready,blocked]
bounty add "Title" --desc "..." --criteria "..." --criteria "..." --type bug --tier B --project tribulation --slot opus-1 [--ready]
bounty add --file task.md              # "# Title", "## Acceptance criteria" with - [ ] lines
bounty edit 12 --criteria "..."        # criteria are required before ready; --project P moves it
bounty note 12 "new requirement"       # reaches the live worker (inbox/progress) and later attempts
bounty assign 12 opus-2 && bounty ready 12
bounty show 12 / bounty log 12         # history, attempts, logs, review notes
bounty approve 12 | bounty reject 12 "what to fix"
# merge the approved branch into main yourself; the board marks it done
bounty close-merged 59 --commit 8ae0fb5 "evidence"   # external work you merged yourself (no submit/review)
bounty import tribulation              # re-runnable; only adds what's new
```

Without `--project`, `bounty add` uses `default_project` from `config/board.json` (`tribulation`), or the only non-legacy project if there is exactly one; otherwise it is refused at creation with the list of projects.

Projects are generic (`bounty project add ID --repo PATH --main main --wt-cmd CMD --wt-path TPL --verify CMD`); `tribulation` is seeded.

## Loot, levels, streaks

Kept from the original board. Reward by type and tier (bug S/A/B/C = 5000/2500/1000/250, other types 5000/2000/750/150), x1.25 when done on the first try, x(1 + 0.1 per streak) capped at x2. A failed attempt (reject, verify failure, watchdog block) resets the streak and costs half the reward. Loot is paid when the bounty is done (merged), to the slot that did the work. Tier names: bug = Kill Order / Wanted: Dead / Bounty Posted / Pest Control; task = Black Ops / Merc Contract / Salvage Run / Scrap Work.

## History

The February 2026 board broke because agents faked work (appending to WORK_LOG.md) and the old reviewer approved any evidence string longer than 50 characters. Its 57 bounties and the agents' loot are kept under the `legacy` project (tick "legacy" on the dashboard). The gates above exist so that cannot happen again.
