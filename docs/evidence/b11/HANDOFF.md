# b11: Sentinel, a read-only health scan across every board

## What landed
- `lib/sentinel.js`: discovery (registry + `--board`), tolerant board.json resolution, read-only scan, signals, signatures, redaction, change fingerprint, `--check-install`.
- `lib/sentinel-report.js`: self-contained `report.html` (inline CSS, CSP `default-src 'none'`, no scripts).
- `bin/bounty sentinel ...`: runs locally and never calls a board server.
- `systemd/bounty-sentinel.service` (oneshot) + `systemd/bounty-sentinel.timer` (`OnCalendar=hourly`, `Persistent=true`), `%h` paths only. `systemd-analyze --user verify` is clean. README section "Sentinel".
- `test/sentinel.test.js` (19 tests) + `test/sentinel-fixtures.js` (seeded fixture boards). `scripts/sentinel-shot.js` (headless screenshot that fails on any non-file:// request).

## Decisions worth knowing
- **Exit codes.** Every scan exits 0, including when boards are unreadable (each becomes a `board_unreadable` issue). A refused `--out` or a bad `--since` is not a scan, so it exits 2 and writes nothing.
- **Read-only, not immutable.** `new Database(db, {readonly: true, fileMustExist: true, timeout: 1500})`, three `.all()` reads with no transaction, then an immediate close.
  - A *closed* board (no `-wal` and no `-shm`) would get both sidecars created by SQLite on a read-only open. So it is read from a temp copy instead.
  - If the db changes or a `-wal` appears during the copy, the original is opened read-only instead. The full-scan test asserts that both board dirs keep the same file list, sizes and mtimes, with nothing added.
- **Issue counts.** Recomputed from the sources on every full scan. Only `first_seen` carries over from the previous `issues.json`, and a quiet issue stays at count 0.
- **History.** One line is appended per run. A full scan's line holds last-24-h figures; an unchanged run appends `{at, unchanged: true, boards}`, having read nothing. The report's trend takes one point per UTC day: every run counts in `runs`, and the figures come from that day's last full scan.
- **Fingerprint.** It covers each db and its non-empty `-wal`, every logs-dir file, and the set of boards found. It does not cover registry file mtimes, because a board rewrites its entry about every minute while its orchestrator is online. I measured this on the live registry: one entry's mtime moved 60 s in 45 s, while an idle board's did not move.
- **Signals.** Slots listed in `board.json` that never ran still count as idle while work waited. A bounty claimed outside the dispatcher (`ready → in_progress` with no spawn) ends a queue wait. A registry entry without `board_dir` is a `board_unreadable` issue (`NO_BOARD_DIR`).
- **Queue waits across `--since`.** `readBoard` also reads each bounty's last `status` and last `spawn` event before the window (one grouped query). A wait that began before the window and ended in it counts with its full length; a wait that ended before the window does not count.
- **Idle while ready (attempt 2 fix).** The ready time is the union of every wait, clipped to the window, so two bounties waiting together count once. Each slot's idle minutes are that union minus its own attempts. `ready_waiting_min` is the union itself, and `board_idle_with_ready_min` is the part of it with no slot running.
- **No-orchestrator time (attempt 2 fix).** This is the overlap of two things. Pending time is the union of each bounty's ready/in_progress/blocked spells, taken from its status timeline including the state before the window. Offline time comes from the presence's `since`. A board with no orchestrator registered at all counts as offline for the whole window rather than unknown, and its issue reads "no orchestrator registered". Work ready for 5 minutes under an orchestrator offline for 3 h reports 5 minutes. (Attempt 3 replaced the offline side; see below.)
- **Fast path and elapsed time (attempt 2 fix).** A full scan stores a watch list in `state.json`: the open attempts not yet stale, the stall threshold and whether the orchestrator was online. An unchanged run re-checks that list from log stats and the presence only. If an attempt has crossed the threshold, or the orchestrator came online or went offline, the run becomes a full scan and reports `rescan_reason`. Otherwise it reads nothing.

- **No-orchestrator time over the whole window (attempt 3 fix).** Offline time is now a timeline built from dated presence transitions, not only the current spell:
  - the board's own presence notes in its events: `orchestrator '<n>' registered, pid N` (online) and `orchestrator '<n>' (pid N) is offline: its process is gone` (offline);
  - the last such note before the window (one extra `LIMIT 1` query in `readBoard`), which says how the window opened;
  - the sentinel's own observations, kept in `state.json` under `presence` (one `{t, online}` per change, recorded on full and unchanged runs, pruned after 30 days). These cover boards too old to write the notes, and spells while a board was down;
  - the presence now: an online one's `since`, an offline one's `last_seen`.

  Before the first transition the opposite state is assumed. With no dated transition at all, the state now holds for the whole window: an offline presence without a usable `since` (7 older live entries) counts as offline throughout. `minutes_without` is the overlap of pending time and offline time, even when an orchestrator is online now; `offline_min` is reported alongside it. The report's board line shows those minutes for an online board too.
- **Verify crash signatures (attempt 3 fix).** A crash's text is its real message (`verify crashed: ENOSPC ...` vs `verify crashed: SqliteError: database is locked` are two issues). A failure's text is its last error-like output line, else its head line (exit code and command, normalized).
- **Report on the fast path (attempt 3 fix).** A full scan stores its summary in `state.json`. An unchanged run reads no rows, but rebuilds `report.html` from that summary, the stored `issues.json` and `boards.json`, and the history up to now. The header then reads "last full scan X · checked Y, no source changed since", and the trend counts the unchanged run.

## Commands and counts

Gate:
```
npm ci --silent && npm test      -> attempt 3: tests 121, pass 121, fail 0 (attempt 2: 118)
node --test test/sentinel.test.js -> 19 pass (3 new in attempt 2: overlap and --since boundary; no-orchestrator overlap and an unregistered orchestrator; fast-path time progression.
   attempt 3: offline spells earlier in the window while online now (notes, the note before the window, the sentinel's own log, a presence without since);
   verify crash signatures; readBoard's prior presence query on a real db; the fast-path test now expects 41 and 53 min (offline spells kept across
   online/offline changes between scans, where attempt 2 gave 0 and 12); the unchanged-sources test checks report.html is rebuilt)
```

### Scratch QA (`scratch-qa.txt`)
Two fixture boards with seeded failures. Board A was held open by a separate writer process in WAL mode (`wal_autocheckpoint=0`), with 3 extra attempts that existed only in the WAL.
```
bounty sentinel --registry-dir /tmp/b11-qa/registry --out /tmp/b11-qa/out --since 72
  -> 2 boards readable; 9 issues from 19 occurrences; attempts 13, broken 9 (stall kills 2, exits w/o submit 7),
     verify failures 2, reviewer errors 2, retry-cap 2, stale open 2, no-orchestrator boards 2 (A: offline 60 min;
     B: no orchestrator registered, 600 min of pending work); ready work waited 270 min per board; exit 0
     the 3 WAL-only attempts were seen (issue "exit without submit: exit code <n>", count 3, runner codex)
bounty sentinel ... (again)            -> "no source db, WAL or log changed ...; nothing read"
bounty sentinel ... --force --json     -> full scan, same counts
bounty sentinel ... --out /tmp/b11-qa/board-a/logs/sentinel -> refused, exit 2
writer, after the scans: wal_checkpoint(TRUNCATE) -> {"busy":0}; the 3 WAL rows are in the main db afterwards
(attempt 2: re-run with the fixed signals; scratch-qa.txt lists file names only, with no owner columns)
```

Headless report checks (`node scripts/sentinel-shot.js REPORT PNG`, Playwright on /usr/bin/chromium):
- `report-scratch.png`: 9 issue rows, 2 board sections, 0 external requests (re-rendered in attempt 2).
- `report-scratch-days.png`: 4 runs at now-3d to now (in-process `run({now})`), showing the day-over-day bars and table. This is the attempt-1 render: the per-board orchestrator line uses the older wording, while `report-scratch.png` is current. Because the fixture rows are fixed in time, the earlier days are synthetic: they demonstrate the trend rendering, not real history.

### Cross-check of the classifier against direct SQL (live boards, read-only)
I ran independent read-only SQL counts over the same 72 h window on every readable live board and compared them with the sentinel's `boards.json`. The script and its output stayed in /tmp.
```
attempts with outcome 'blocked (exited%' (minus watchdog kills)  vs exits_without_submit
events actor=watchdog note 'watchdog:%'                         vs stall_kills
events kind=verify note 'verify FAILED%' / 'verify crashed%'    vs verify_failures
-> boards checked 17, mismatches 0 (totals: exits 20, stalls 0, verify failures 26); queue waits measured n=497 in total
```

### Live registry, read-only
`--out` was a temp dir outside the repo. The output and screenshot stay there and are not committed.
```
bounty sentinel --registry-dir $XDG_STATE_HOME/totally-not-a-kanban/boards --out <tmp>/out --json
  -> exit 0, ~5.2 s; boards 18 (17 readable, 1 unreadable: a stopped registry entry whose db is gone -> DB_MISSING issue)
     22 issues from 72 occurrences; attempts 498 in 72 h; broken 35; exits w/o submit 20; verify failures 26;
     stall kills 0; reviewer errors 0; retry-cap 0; stale open 0; boards with pending work and no orchestrator online 10
     issue causes: verify_failed 26, exit_without_submit 20, worker_exit_error 11, no_orchestrator 10, never_started 4, board_unreadable 1
second run, ~1.3 s, exit 0: a full scan again (live boards' WALs and logs change between runs, as expected)
after the fixes (fingerprint without registry mtimes): a full scan with the same totals (497 attempts, 35 broken, 22 issues);
  two runs right after it: unchanged false (a log had grown), then unchanged true (nothing read), both exit 0
node scripts/sentinel-shot.js <tmp>/out/report.html <tmp>/report-live.png
  -> 22 issue rows, 18 board sections, 0 external requests
```

**Live screenshot (described here, not committed).** A dark page with the KPI row and the ranked issue table: the top rows are verify failures and exits without submit, with signatures, slots, runners, models and redacted samples. Below it is one day-over-day bar per metric, since this is the first live run, then 18 board sections with counters, queue wait, cost per slot per day, idle-slot minutes and silent open attempts. The unreadable board shows in red with DB_MISSING.

### Attempt 2: live registry re-run, read-only, `--out` in a temp dir outside the repo
```
bounty sentinel --out <tmp>/out --json   (three runs in a row)
  run 1 -> exit 0, full scan: boards 18 (17 readable, 1 unreadable), 22 issues from 71 occurrences, attempts 490, broken 34,
           exits w/o submit 20, verify failures 26, stall kills 0, stale open 0, boards with pending work and no orchestrator 10
           issue causes: verify_failed 26, exit_without_submit 20, worker_exit_error 11, no_orchestrator 10, never_started 3, board_unreadable 1
  run 2 -> exit 0, full scan (a live log had grown), same totals; the run's own stamps put a full 18-board scan, including the new prior-state query, at about 2 s
  run 3 -> exit 0, unchanged: nothing read
  presence: 17 readable boards have a presence, 2 online; queue waits n=490; ready-wait union 23413 min summed over boards,
  of which 19691 min had no slot running; no-orchestrator overlap 40188 min summed over boards
node scripts/sentinel-shot.js <tmp>/out/report.html <tmp>/report-live.png -> 22 issue rows, 18 board sections, 0 external requests
```
The live screenshot stays outside the repo. It has the same layout as before, and each board line now reads "no orchestrator online/registered; N pending now; M min of pending work with none online in the window · ready work waited X min, with no slot running for Y min of it".

### Attempt 3: scratch QA (`scratch-qa-3.txt`) and live re-run
Two fixture boards. Board A has presence notes (registered 400 min ago, offline 240 min ago, registered again 120 min ago by a stand-in `sleep` process I started and killed afterwards), plus three `verify crashed` events (2 ENOSPC, 1 database locked). Board B has no orchestrator registered.
```
bounty sentinel --registry-dir /tmp/b11-qa3/registry --out /tmp/b11-qa3/out --since 72   (twice)
  run 1 -> full scan: 10 issues from 19 occurrences; verify failures 5; boards with work and no orchestrator now 1 (B)
           A: online now, minutes_without 4040 (before the first registration plus the 240..120 spell), offline_min 4040
           B: no orchestrator registered, minutes_without 600 (its pending time)
           verify_crashed: 2 issues (count 2 "enospc: no space left on device, write", count 1 "sqliteerror: database is locked")
  run 2 -> unchanged, nothing read; report.html rebuilt: header "last full scan <run 1> · checked <run 2>", trend runs 2
node scripts/sentinel-shot.js /tmp/b11-qa3/out/report.html docs/evidence/b11/report-scratch.png
  -> 10 issue rows, 2 board sections, 0 external requests (rendered from the fast-path report)
```
Live registry, read-only, `--out` in a temp dir outside the repo, three runs:
```
each run -> exit 0, about 0.5-0.7 s, full scan (live worker logs grow between runs): boards 18 (17 readable, 1 unreadable),
            23 issues from 73 occurrences, attempts 490, broken 34, exits w/o submit 20, verify failures 28, stall kills 0, stale open 0,
            boards with pending work and no orchestrator now 10
issue causes: verify_failed 28, exit_without_submit 20, worker_exit_error 11, no_orchestrator 10, never_started 3, board_unreadable 1
presence: 17 known, 2 online, 7 without a usable since; no-orchestrator overlap 40506 min summed over boards (attempt 2's model: 40188),
  offline 67491 min summed; state.json keeps a presence log for all 18 boards
node scripts/sentinel-shot.js <tmp>/out/report.html <tmp>/report-live.png -> 23 issue rows, 18 board sections, 0 external requests
```
A first attempt-3 live run showed 14585 min: 7 offline presences without a `since` had been read as online all window. The second rule above fixes that, and a test covers it. The live screenshot stays outside the repo; its layout matches the scratch one.
