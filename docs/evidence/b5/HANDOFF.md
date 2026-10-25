# b5 HANDOFF: agent cleanup on bounty completion

## What changed
- `lib/agents.js` (new): the manifest `<board dir>/run/agents.json` (config `run_dir`, atomic temp+rename writes) and the only code path that stops agents. `stop()` re-reads `/proc/<pid>/stat` start time before SIGTERM and again before SIGKILL; a mismatch means the pid was reused, so nothing is signalled, the entry is dropped and the event is logged. SIGTERM goes to the process group only when the process leads one (board workers are `detached`); otherwise to that pid alone, so a hand-registered agent never takes its terminal's shell with it.
- `lib/board.js`: `this.agents.onTerminal(id)` after every transition to done (`checkMerged`, `closeMerged`) or failed (`fail`, the attempt-cap branch of `requeue`). It stops the bounty's board worker and every registered agent with that bounty. Orchestrator entries are skipped.
- `lib/dispatcher.js`: registers each spawned worker (pid, start time, slot, bounty, attempt). `onExit` drops the entry. `adopt()` refuses a pid whose start time no longer matches the manifest. `signal()` (kill/watchdog) goes through the manifest. A sweep timer prunes dead entries and runs the idle shutdown.
- `lib/config.js`: `run_dir` (default `run/`), `stop_grace_seconds` (default `watchdog.kill_grace_seconds`, 15), `idle_shutdown_minutes` (default 120, 0 disables).
- `lib/api.js`: `POST /api/agents/spawned`, `GET /api/agents/spawned`, `POST /api/agents/cleanup {kill, all, orchestrators}`. A worker slot can register only for a bounty and never an orchestrator. Only the orchestrator can kill.
- `bin/bounty`: `bounty agents register --pid --name [--bounty] [--kind worker|orchestrator|bridge]` (plain `bounty agents` is still the leaderboard). `bounty cleanup [--kill] [--all] [--orchestrators] [--json]`.
- README "Agent lifecycle" section, the example config keys, `run/` in .gitignore, and a rule in `skill/totally-not-a-kanban/SKILL.md`.

## Decisions to review
- `--all` does not touch orchestrator entries unless `--orchestrators` is also given, so an orchestrator can't kill itself by accident. Orchestrators are never stale.
- Idle: the clock is in memory and starts when the board starts, so a restart doesn't mass-kill. Paused counts as idle. Only entries registered longer ago than the threshold are stopped, so an agent registered a minute ago on an idle board survives.
- RSS is the process plus all its descendants (an agent's shells and MCP servers).
- The personal orchestrator skill (`~/.claude/skills/orchestrator/`) is outside this repo, so I did not edit it. It needs the same rule (register every spawned agent and bridge; `bounty cleanup` each round). Tracked as a split bounty. The `omarchy-agent` launcher could call `bounty agents register` itself.

## Tests (test/agents.test.js, real child processes)
- worker stopped on done: a lingering fake worker (`mode:linger`) is approved, merged, goes done, and its process group dies. The event log and manifest are checked.
- registered agents stopped on close-merged done and on fail. A TERM-ignoring bridge gets SIGKILL after the grace period. The orchestrator and another bounty's agent survive.
- identity: a manifest entry with a different start time is not signalled on fail, or by `cleanup --kill --all`.
- idle shutdown: an in_progress bounty keeps the board busy. Paused means idle, and the worker and bridge are stopped while the orchestrator is kept. The timer also runs inside the dispatcher, and 0 disables it.
- cleanup: the dry run stops nothing; `--kill` stops only the stale entry; `--kill --all` stops the rest, including a non-group-leader entry. An **unregistered process survives `--kill --all`**, and so does the test runner.

`npm ci && npm test`: 49 pass, 0 fail.

## CLI on a scratch board (ephemeral port)
```
$ bounty agents register --pid 1661930 --name Rook --bounty 1 --kind worker
registered worker 'Rook' pid 1661930 for #1

$ bounty agents register --pid 1661939 --name Rook-bridge --bounty 1 --kind bridge
registered bridge 'Rook-bridge' pid 1661939 for #1

$ bounty agents register --pid 1661950 --name Bishop --bounty 2 --kind worker
registered worker 'Bishop' pid 1661950 for #2

$ bounty agents register --pid 1661967 --name Marshal --kind orchestrator
registered orchestrator 'Marshal' pid 1661967

$ bounty cleanup
board idle 0 min (idle shutdown after 120 min)

Agents (3, 7 MB)
pid      name               kind         bounty              age      RSS  state                          action
1661930  Rook               worker       #1 failed            0m     2 MB  STALE: bounty #1 is failed     would stop
1661950  Bishop             worker       #2 backlog           0m     2 MB  ok                             keep
1661967  Marshal            orchestrator -                    0m     2 MB  ok                             keep

Bridge sessions (1, 2 MB)
pid      name               kind         bounty              age      RSS  state                          action
1661939  Rook-bridge        bridge       #1 failed            0m     2 MB  STALE: bounty #1 is failed     would stop

dry run: 2 would be stopped. Add --kill to stop them (--all for every non-orchestrator entry).
Only processes in the manifest are listed or signalled; register yours with `bounty agents register`.

$ bounty cleanup --kill
board idle 0 min (idle shutdown after 120 min)

Agents (3, 7 MB)
pid      name               kind         bounty              age      RSS  state                          action
1661930  Rook               worker       #1 failed            0m     2 MB  STALE: bounty #1 is failed     stop
1661950  Bishop             worker       #2 backlog           0m     2 MB  ok                             keep
1661967  Marshal            orchestrator -                    0m     2 MB  ok                             keep

Bridge sessions (1, 2 MB)
pid      name               kind         bounty              age      RSS  state                          action
1661939  Rook-bridge        bridge       #1 failed            0m     2 MB  STALE: bounty #1 is failed     stop

stopped 2 (SIGTERM now, SIGKILL after the grace period)
Only processes in the manifest are listed or signalled; register yours with `bounty agents register`.

$ bounty cleanup
board idle 0 min (idle shutdown after 120 min)

Agents (2, 5 MB)
pid      name               kind         bounty              age      RSS  state                          action
1661950  Bishop             worker       #2 backlog           0m     2 MB  ok                             keep
1661967  Marshal            orchestrator -                    0m     2 MB  ok                             keep

Bridge sessions (0, 0 MB)
  none

dry run: 0 would be stopped. Add --kill to stop them (--all for every non-orchestrator entry).
Only processes in the manifest are listed or signalled; register yours with `bounty agents register`.

unregistered pid 1661929 alive: yes
```
