# Wasteland Bounty Board

The single accountability system for every agent. Work that is not marked done on this board is a known gap.
Workers are spawned by the board, one fresh agent per bounty, and a bounty only reaches **done** when its commits are on the project's main branch.

- Dashboard: `http://<tailscale-ip>:3777/` (kanban, slots, locks, pause switch, add/edit/assign), `/live`, `/roster`, `/leaderboard`
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

Work done off the board (an `external` bounty, e.g. one in flight before the board existed) never goes through submit, so it can't reach approved. When the orchestrator has merged it, `bounty close-merged ID --commit SHA [--commit SHA]... ["evidence"]` (API `POST /api/bounties/:id/close-merged {commits, evidence}`) takes it to done from any open status: every commit must exist in the project repo and be an ancestor of main (it is refused otherwise, and refused while the bounty has a live board worker or a verify running). The full SHAs join the bounty's commits, the evidence goes to `work_evidence`, and the done event records `close-merged by <actor>: <shas> on main` plus the evidence. Loot goes to a slot only if that slot's board attempt submitted commits that are on main; otherwise no one is credited. Orchestrator only.

`review`, `approved` and `done` are guarded edges: no request can set them directly. Workers (requests carrying a slot id) can't ready, assign, approve, reject, fail, pause or mark done.

## Dispatcher

- Slots in `config/board.json`: `opus-1..4` (claude, opus), `sonnet-tester` (claude, sonnet, effort low), `codex-1..2` (`codex exec`), each with model and effort, plus a global `concurrency_cap`.
- When a slot has no live worker and a `ready` bounty is assigned to it (dependencies done), the board creates the worktree with the project's command (Tribulation: `Scripts/wt.sh <task>`, which sets up the code/content split) and spawns one fresh worker. When the worker exits, the slot takes its next ready bounty; with none, it idles.
- Claude workers run `claude -p --output-format stream-json --verbose --model ... --effort ... --allowedTools ...`; Codex workers `codex exec --json`. The prompt (saved next to the log) holds the bounty, criteria, notes from earlier attempts, the project rule docs and the CLI protocol. Every attempt's log, exit code, tokens and cost ($ from Claude's result event; Codex reports tokens only) are stored and linked from the bounty.
- Watchdog: a worker silent for `watchdog.stall_minutes` (log output, heartbeats and `bounty progress` all count) is killed and the bounty blocked with the reason; a worker that exits without submitting is blocked too. The log stays attached.
- Retries: `retry.max_attempts`, and after `retry.escalate_after_failures` failures a bounty moves up a model (`escalate_model`, e.g. sonnet -> opus).
- Pause switch: `bounty pause` / `resume` or the header button. Running workers finish; nothing new spawns.
- Workers outlive a board restart (`KillMode=process`) and are re-attached when it starts.

## Live: what every agent is doing right now

`/live` (the pulse icon in the nav; phone-friendly), `GET /api/live` (JSON; `?format=text` for plain text) and `bounty live [--json] [--watch [SEC]]` show the same snapshot. Read-only; the page polls every 5 s and also reloads on board websocket events.

- **Per slot**: idle or working; the bounty (#, title, type, tier, priority), attempt number, pipeline status (in progress / verify queued with its place in line / verifying with the current `ci.sh` stage and N/M / in review / approved, waiting for merge / blocked), elapsed time, tokens and $ (the real $ once Claude's result event lands; before that `~$` is an estimate from the tokens at a rate calibrated on that model's finished attempts), the latest `bounty progress` note and its age, unread orchestrator notes, the last actions parsed from the worker log (`Bash: ...`, `Edit: <path>`, `Todo 3/5: ...`; a `>` marks a tool call still running), the last assistant text line, how long the log has been silent (flagged "possibly stuck" past `live.stuck_minutes`, default 15), the worker's own `ci.sh` runs and their stage, notable child processes, and lock state: **waiting** on the UE render lock or the UE stack gate (a `flock` in the worker's process tree whose descriptor points at the lock, a "waiting" line in its CI log, or a stack-gate holder in `state=admitting` waiting for memory) and **holding** either lock.
- **Machine**: both lock holders from `/run/user/$UID/tribulation/ue-render.holder` and `ue-stack.holder` (owner, kind, what, since; a holder file without the flock is shown as stale), MemAvailable.
- **Off the board**: the tester (`tribulation-playtest.service`/`.timer`: running or not, next and last run, the last line of the newest cycle log in `/mnt/ue/testlab/daemon-logs`) and every top-level `Scripts/ci.sh` on the machine, classed as board verify (a child of the board process), a worker's own run (`BOUNTY_SLOT` in its environment) or other (e.g. the orchestrator's main-branch CI), with its path and current stage (from the log its stdout goes to, else from the `tee Saved/CI/<stage>.log` child).
- **Queue**: each slot's next startable bounty and its other ready bounties (with unfinished dependencies), unassigned ready work, and bounties done or failed in the last 24 h.
- **Cost**: logs are followed incrementally (a byte offset per file; only appended bytes are read after the first pass), the process table is one `ps`, and a snapshot is cached for 2 s however many viewers there are. Stage positions come from the `quick_stages`/`all_stages` arrays in the checkout's `Scripts/ci.sh` (`--quick`, `--full`, `--only`, `--skip` are honoured).
- Config (optional) `live`: `{ "lock_dir", "stuck_minutes", "recent_hours", "tester": { "service", "timer", "log_dir" } }`. Parsers: `lib/live.js`; tests: `test/live.test.js`.

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

## Agents = the configured slots

The only agents are the dispatcher slots in `config/board.json` (`opus-1..4`, `sonnet-tester`, `codex-1..2`). At every start the board runs a re-runnable migration that deletes every other agent row (the Feb-2026 crew such as `opus-wsl-1` or `agent-codex-1`, and the seed/mock agents) together with its `agent_status` / `agent_events` rows; old bounties keep those names as plain text in `claimed_by`. An agent row can only be created for a configured slot: `POST /api/agents {id}` and `board.registerAgent` refuse any other id (403), and `GET /api/agents/<non-slot>` is a 404.

## Loot, levels, streaks: derived from verified work

Nothing on the leaderboard is a stored counter. `board.ledger()` replays history:

- **Done**: a slot earns a bounty's reward only when the bounty reached done through the merge check or `close-merged` (commits on the project's main). The credit goes to the slot whose attempt produced the work: the slot that last submitted the branch, and the attempt running at that submit (`bounties.credited_slot` / `credited_attempt`, set when it goes done). `close-merged` credits a slot only if the commits that slot submitted are on main; work done off the board (an external bounty with no slot submit) credits nobody.
- **Failure**: every other finished worker attempt of a slot (rejected, verify failed, blocked by the watchdog, exited without submit) resets the streak and costs half the base reward. The latest attempt of a bounty still in the gates, review or approved is pending, not a failure.
- **Reward**: by type and tier (bug S/A/B/C = 5000/2500/1000/250, other types 5000/2000/750/150), x1.25 when done on the first try, x(1 + 0.1 per streak) capped at x2.
- **Cost**: the real $ from the slot's attempts (Claude's result event; Codex reports tokens only).
- The `legacy` project never counts. Header stats (`/api/state` stats, `bounty status`) leave legacy out: status counts, loot = the slots' derived loot, spent.

The `agents` table's counters are only a cache, rebuilt from the ledger on every bounty change and at start (a test checks they match). `/api/agents`, `/api/agents/leaderboard`, the roster, the leaderboard and the dashboard slot cards show the slots only, with loot, done, failed, streak and cost; a slot with no verified work shows zero. CLI: `bounty leaderboard`.

Tier names: bug = Kill Order / Wanted: Dead / Bounty Posted / Pest Control; task = Black Ops / Merc Contract / Salvage Run / Scrap Work.

## History

The February 2026 board broke because agents faked work (appending to WORK_LOG.md) and the old reviewer approved any evidence string longer than 50 characters. Its 57 bounties are kept under the `legacy` project (tick "legacy" on the dashboard) with their old agent names as text; its agents and their inflated loot were deleted (September 2026), and legacy work never counts toward loot. The gates above exist so that cannot happen again.
