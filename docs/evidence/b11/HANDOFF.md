# b11: Sentinel, a read-only health scan across every board

## What landed
- `lib/sentinel.js`: discovery (registry + `--board`), tolerant board.json resolution, read-only scan, signals, signatures, redaction, change fingerprint, `--check-install`.
- `lib/sentinel-report.js`: self-contained `report.html` (inline CSS, CSP `default-src 'none'`, no scripts).
- `bin/bounty sentinel ...`: runs locally and never calls a board server.
- `systemd/bounty-sentinel.service` (oneshot) + `systemd/bounty-sentinel.timer` (`OnCalendar=hourly`, `Persistent=true`), `%h` paths only. `systemd-analyze --user verify` is clean. README section "Sentinel".
- `test/sentinel.test.js` (11 tests) + `test/sentinel-fixtures.js` (seeded fixture boards). `scripts/sentinel-shot.js` (headless screenshot that fails on any non-file:// request).

## Decisions worth knowing
- **Exit codes.** Every scan exits 0, including when boards are unreadable (each becomes a `board_unreadable` issue). A refused `--out` or a bad `--since` is not a scan, so it exits 2 and writes nothing.
- **Read-only, not immutable.** `new Database(db, {readonly: true, fileMustExist: true, timeout: 1500})`, three `.all()` reads with no transaction, then an immediate close.
  - A *closed* board (no `-wal` and no `-shm`) would get both sidecars created by SQLite on a read-only open. So it is read from a temp copy instead.
  - If the db changes or a `-wal` appears during the copy, the original is opened read-only instead. The full-scan test asserts that both board dirs keep the same file list, sizes and mtimes, with nothing added.
- **Issue counts.** Recomputed from the sources on every full scan. Only `first_seen` carries over from the previous `issues.json`, and a quiet issue stays at count 0.
- **History.** One line is appended per run. A full scan's line holds last-24-h figures; an unchanged run appends `{at, unchanged: true, boards}`, having read nothing. The report's trend takes one point per UTC day: every run counts in `runs`, and the figures come from that day's last full scan.
- **Fingerprint.** It covers each db and its non-empty `-wal`, every logs-dir file, and the set of boards found. It does not cover registry file mtimes, because a board rewrites its entry about every minute while its orchestrator is online. I measured this on the live registry: one entry's mtime moved 60 s in 45 s, while an idle board's did not move.
- **Signals.** Slots listed in `board.json` that never ran still count as idle while work waited. A bounty claimed outside the dispatcher (`ready → in_progress` with no spawn) ends a queue wait. A registry entry without `board_dir` is a `board_unreadable` issue (`NO_BOARD_DIR`).
- **No-orchestrator time.** The db keeps no presence history, so this comes from the registry's presence (`since`) at scan time, clipped to the window. Across runs it is tracked by `no_orchestrator_with_work` in `history.ndjson`.
- **Fast path limit.** A silent open attempt does not change any source, so it only resurfaces at the next full scan or with `--force`. This is by design (criterion 5).

## Commands and counts

Gate:
```
npm ci --silent && npm test      -> tests 115, pass 115, fail 0
node --test test/sentinel.test.js -> 13 pass
```

### Scratch QA (`scratch-qa.txt`)
Two fixture boards with seeded failures. Board A was held open by a separate writer process in WAL mode (`wal_autocheckpoint=0`), with 3 extra attempts that existed only in the WAL.
```
bounty sentinel --registry-dir /tmp/b11-qa/registry --out /tmp/b11-qa/out --since 72
  -> 2 boards readable; 8 issues from 18 occurrences; attempts 13, broken 9 (stall kills 2, exits w/o submit 7),
     verify failures 2, reviewer errors 2, retry-cap 2, stale open 2, no-orchestrator boards 1; exit 0
     the 3 WAL-only attempts were seen (issue "exit without submit: exit code <n>", count 3, runner codex)
bounty sentinel ... (again)            -> "no source db, WAL or log changed ...; nothing read"
bounty sentinel ... --force --json     -> full scan, same counts
bounty sentinel ... --out /tmp/b11-qa/board-a/logs/sentinel -> refused, exit 2
writer, after the scans: wal_checkpoint(TRUNCATE) -> {"busy":0}; the 3 WAL rows are in the main db afterwards
```

Headless report checks (`node scripts/sentinel-shot.js REPORT PNG`, Playwright on /usr/bin/chromium):
- `report-scratch.png`: 8 issue rows, 2 board sections, 0 external requests.
- `report-scratch-days.png`: 4 runs at now-3d to now (in-process `run({now})`), showing the day-over-day bars and table. Because the fixture rows are fixed in time, the earlier days are synthetic: they demonstrate the trend rendering, not real history.

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
