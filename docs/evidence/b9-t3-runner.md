# Bounty #9: T3 runner evidence

## Attempt 4: reconcile rejected launches without leaking slots

The attempt-3 review found that a rejected `orchestration.launchThread` left
an open attempt, live worker and manifest entry when the subsequent interrupt
also failed because the thread had never existed.

`lib/t3-workers.js` now reconciles the predetermined thread id after the stop
attempt. An authoritative `ProjectionStoreThreadNotFoundError` closes the
attempt through the ordinary `onExit` lifecycle, removes the manifest/live
entry, records the launch error in the exit/block reason and frees the slot.
An existing projection is processed normally; a running thread retains its
persisted stop reason for retry. A timeout, connection error or other failed
projection lookup does not prove absence and retains ownership. The existing
restart attachment and polling logic can continue the pending interrupt.
The other runners and reviewer paths are unchanged by this revision.

Three new fake-server regression tests exercise:

- A rejected launch into a nonexistent project, followed by a rejected stop and
  confirmed absence: ended attempt, no manifest/live entry, idle slot, and a
  successful retry with a different thread id.
- A committed launch whose acknowledgement is lost: the board reconnects,
  interrupts that same thread, closes the attempt and removes ownership.
- A lost acknowledgement plus failed interrupt and unavailable projection:
  the running thread keeps its open attempt, manifest and occupied slot until
  reconciliation recovers and the pending interrupt succeeds. No duplicate
  launch is issued.

`node --test test/t3.test.js`: **17/17 passed**, exit **0**, duration
**10246.127878 ms**. Full-suite command:
`npm test > docs/evidence/b9-t3-runner-attempt4-npm-test.txt 2>&1`.
Exit **0**, **87/87 passed**, **0 failed**, duration **73771.885083 ms**.
Full output: [b9-t3-runner-attempt4-npm-test.txt](b9-t3-runner-attempt4-npm-test.txt).
`git diff --check` also passed.

The installed E2E evidence from attempt 2 remains applicable and was accepted
by the attempt-3 reviewer for criteria 4–7. This revision uses only isolated
fake-server boards with their own temporary configs, databases and registries
on ephemeral ports. It creates no installed T3 threads/projects, changes no
installed settings, and stops/restarts no live board or installed T3 process.

## Attempt 3: runtime override and authoritative acceptance clarification

The attempt-2 rejection identified a real missing per-bounty override. This
attempt adds persistent `bounties.t3_runtime`, orchestrator-only create/PATCH
support, CLI `--t3-runtime MODE` / `default` to clear it, and applies the override
before T3 selection/launch. Null inherits the slot; an empty or unsupported mode
fails closed. Other runner branches and the reviewer are unchanged.

The rejection also requested an authoritative change outside self-authored
evidence for read-only. **That change already exists in the live bounty record**:
`bounty show 9 --json`, event **101**, actor **orchestrator**, timestamp
**2026-11-08T00:34:07.295Z** (before attempt-2 submission/review):

> Kanagawa ruling: accepted. The runtime setting takes T3's own RuntimeMode values (full-access, approval-required, auto-accept-edits, auto). A 'read-only' request must fail closed with a clear error (dispatch refused, bounty blocked with the reason), never fall back to full access. Document it in README; true read-only legs are M0.3's question, not this bounty's.

Event **102**, actor **agent-room**, independently relays Kanagawa's room message
**#30** with the same ruling. Raw live-board event records are captured in
[b9-runtime-orchestrator-ruling.json](b9-runtime-orchestrator-ruling.json).
This is an orchestrator instruction modifying the brief, not a worker-authored
exception. README and tests intentionally retain read-only refusal accordingly.

New fake-server tests cover a per-bounty `approval-required` overriding a
full-access slot, survival of a board restart, retry after clearing back to the
slot's full-access default, and worker refusal to set **or clear** the override.
They verify per-bounty read-only, unknown mode and empty mode block with zero T3
requests. CLI tests exercise add/edit/clear; API tests exercise type validation.

The installed E2E and cleanup evidence below is retained from attempt 2, where
the reviewer explicitly accepted criteria 3–6. Attempt 3 starts no installed T3
threads/projects, changes no installed settings and restarts no live board.
Only isolated fake-server boards on ephemeral ports run for this revision.

Validation command: `npm test > docs/evidence/b9-t3-runner-attempt3-npm-test.txt 2>&1`.
Exit **0**, **84/84 passed**, **0 failed**, duration **72237.44432 ms**.
The full output is committed in
[b9-t3-runner-attempt3-npm-test.txt](b9-t3-runner-attempt3-npm-test.txt).
`git diff --check` also passed.


## Attempt 1: installed T3 unavailable

Recorded 2026-11-07 16:25 America/Los_Angeles, host `Kewkarchy`.
Branch: `b9-m0-6-critical-a-t3-runner-for-the-bo`.

## Blocker

The required installed server at `127.0.0.1:3773` is not running/reachable.
The brief prohibits starting/restarting/killing/upgrading installed T3. Real
launch, activity, interruption and cleanup evidence cannot be collected until
Kewk restores it. No runner implementation is submitted from this attempt.

Commands and observed output:

```
$ t3 thread list --json
No running T3 Code server uses /home/kewk/.t3. Start T3 Code, then retry.
(exit 1)

$ cat /home/kewk/.t3/userdata/server-runtime.json
cat: /home/kewk/.t3/userdata/server-runtime.json: No such file or directory

$ ss -ltnp | rg '3773|t3code'
(no output)
```

A local Node `ws` connection probe against `ws://127.0.0.1:3773/ws`
also returned `connect ECONNREFUSED 127.0.0.1:3773`. The probe issued a
short-lived scoped CLI auth session and revoked it in its finally handler.
No credential values were printed or retained. No settings were edited.

No scratch board, T3 project or thread was created. No server process was
started or stopped, and no test listener was bound to any port. There is no
installed server PID to compare before/after. A draft, untested RPC client
was removed; the working implementation is unchanged. Dependencies were
installed locally with `npm ci` (71 packages); package manifests/lock unchanged.
No tests were run because this attempt stops at the environment blocker.

## Research handoff

`CLAUDE.md` is absent from this board worktree. Read the board README,
`lib/dispatcher.js`, `lib/agents.js`, `lib/api.js`, `lib/prompt.js`,
`lib/live.js`, `lib/db.js`, and `test/helpers.js`.

Relevant T3 source under `/home/kewk/build/t3kewk`:

- `apps/server/src/cli/thread.ts`: CLI discovers `userdata/server-runtime.json`,
  issues a short-lived MCP client session, calls `/mcp`, then revokes the session.
  `thread start` calls `t3_thread_launch` but lacks runtime/effort flags.
- `packages/contracts/src/orchestrationV2.ts`: RPC
  `orchestration.launchThread` accepts `title`, `modelSelection`, `runtimeMode`,
  `interactionMode`, `workspaceStrategy` and `initialMessage`. The
  `existing_worktree` strategy accepts `worktreePath` and `branch`.
  `modelSelection` has `instanceId`, `model`, `options`.
- `orchestration.getThreadProjection` returns thread, runs, provider turns,
  messages and visible turn items. Provider turns expose `tokenUsage` with
  input/output/cached token fields. Do not invent dollar costs.
- `orchestration.dispatchCommand` accepts `thread.stop` for interruption.
  `projects.mutate` accepts `project.create` / `project.delete`.
- The board currently assumes PID identity in dispatcher adoption, liveness,
  watchdog, kill and the manifest. Thread entries must avoid all process
  signalling, survive restart by thread ID, and flow through terminal/idle/
  cleanup stopping too.
- Current CLI worker identity is the `X-Bounty-Actor` header from `BOUNTY_SLOT`.
  A private per-attempt CLI wrapper can supply board URL, slot and bounty ID
  without modifying T3's environment; the prompt must direct every CLI call
  through it. Tests must prove approve/ready/done remain forbidden.

This research has not been validated against a live installed T3 server.


## Attempt 2: implementation and installed-server proof

2026-11-07, host Kewkarchy. Installed T3 was restored by Kewk before this
attempt. The orchestrator supplied the before PID **192971**, verified through
`~/.t3/userdata/server-runtime.json` and `ps -p 192971`. No `CLAUDE.md` exists
in this bounty-board worktree; the board README and source were followed.
This is the shared board repo, so the t3kewk fork's patch budget/mise gate and
instruction to merge its `main` do not apply here. No other worktree was edited,
no branch merged, and no live board was restarted.

### Approved runtime clarification

At 00:34Z Kanagawa ruled on the bounty and in room message 30:
"Runtime takes T3's RuntimeMode values; 'read-only' fails closed with a clear
error (no dispatch, blocked with reason), never silent full access."
Installed T3 accepts `full-access`, `approval-required`, `auto-accept-edits`,
`auto`; true read-only execution belongs to M0.3. The fake-server test proves
that read-only dispatch blocks explicitly and creates **no** thread.

### Implementation / criterion mapping

1. `lib/t3.js` speaks the installed Effect JSON-RPC v2 API over authenticated
   WebSocket. It uses scoped, expiring local CLI sessions, revokes them, and
   reconnects without creating another turn. `lib/t3-workers.js` launches named
   threads in the board worktree, and tracks attempts by `thread_id`. The
   existing Claude, Codex, command spawning and reviewer are retained. README
   "Setting up AI Workers" documents the configuration, auth, identity,
   lifecycle and usage limitations.
2. `test/t3.test.js` exercises a fake authenticated T3 server: provider/model/
   effort/runtime/title/worktree, worker CLI identity, forbidden ready/approve/
   done, activity heartbeat (unchanged polls cannot keep a worker alive), usage
   ledger and log mirroring, stall interrupt/block/requeue/escalation/new thread,
   normal/failed turn completion and the next queued bounty, done/failed/kill/
   idle/cleanup stopping, reattachment, connection loss, retried interruption,
   deleted threads, and a pending stop surviving restart.
3. The installed-server transcript is [b9-t3-runner-installed.txt](b9-t3-runner-installed.txt).
   The successful worker actually ran the private CLI start/inbox/progress/
   submit. Its slot actor is `t3-e2e`; its scratch worktree contains a real code
   commit (`09404cc`), and verify passed before review/merge/done. The scratch
   reviewer uses the existing test helper's command reviewer, unchanged code.
4. A second bounty calls progress `STALL_READY`, then sleeps silently. The
   watchdog is then set to a real **3-second** inactivity limit. No clock or T3
   state is falsified. It interrupts/blocks; the scratch orchestrator calls the
   board's existing `requeue`, and the dispatcher creates attempt 2 with a fresh
   thread id. Ordinary process-watchdog policy is unchanged: blocking does not
   automatically ready work; the orchestrator decides to retry.
5. Every scratch thread/project is removed in the script's finally path. The
   transcript contains `CLI_AFTER_REMOVAL []`, the project deletion and unchanged
   server PID. The scratch board uses its own config/db/run dir and explicit
   `BOUNTY_REGISTRY_DIR`; it binds port 0, yielding **32987**. It is stopped.
6. This evidence, the raw installed-server transcript, test output and repeatable
   opt-in script `scripts/b9-t3-e2e.js` are committed on the bounty branch.

### Installed run: commands, ids and timing

Commands:

```text
node scripts/b9-t3-e2e.js > /tmp/b9-installed-e2e-final.log 2>&1
# exit 0; captured verbatim in b9-t3-runner-installed.txt
```

- Start: `2026-11-08T00:42:05.184Z`, installed PID **192971**.
- Scratch: `/tmp/bb-b9-installed-4gWCgl`, board PID **234932**, port **32987**.
- Project: `8c01b4e5-793f-4014-a7a9-a428d5b2a97f` (removed).
- Success thread: `0d17334a-702b-40ce-a732-18feffaa1e0a`.
  `t3 thread list --project <scratch-project-id> --json` returned title
  **B9 Scratch #1**, provider `codex`, model `gpt-6.1-sol`, runtime `full-access`,
  status `running` (full output in transcript). Slot effort was `low` via the
  `reasoningEffort` option, and the worktree was `wt/b1-implement-multiply`.
- `00:42:24.240Z`: actor `t3-e2e` started bounty 1. Three subsequent progress
  events and the submit event carry the same actor. `/live` showed the thread
  running, readable assistant text and individual CLI/tool actions.
- `/live` heartbeat: `00:43:18.231Z`. T3 supplied a context snapshot (28,367
  tokens used); the live turn ledger was still `pending`, explicitly separate.
- `00:43:18.156Z`: verify passed and gates entered review.
- `00:43:18.173Z`: command reviewer approved.
- `00:43:18.735Z`: scratch merge check marked done; at `.737Z`, the manifest
  requested T3 interrupt. The attempt ended at `.805Z`, outcome **done**, T3 run
  **interrupted**, no PID. It recorded **109,122 input / 992 output**, cache-read
  subset **81,152**, cost **null**. Input already includes cache subsets.
- Stall thread: `791fdce5-1bae-4b64-9ee9-e66deab5739d` (B9 Scratch #2).
  `00:43:26.677Z`: actor `t3-e2e` progress `STALL_READY`.
  `00:43:31.027Z`: watchdog blocked and interrupted the thread. At `.313Z`, its
  attempt ended with T3 run `interrupted`, 26,626 input / 248 output tokens.
- `00:43:31.352Z`: existing requeue made the bounty ready.
  At `.547Z`, attempt 2 spawned thread **fe0ae18d-bf04-491d-b578-8fc624b0f2cc**.
  The test explicitly killed this retry through the dispatcher after launch.
- All three threads removed, CLI list returned `[]`, scratch project removed.
- Finish: `2026-11-08T00:43:32.997Z`, installed PID **192971**, unchanged.

An earlier implementation run at 00:36:29Z–00:37:12Z also passed on scratch port
37187 (threads a5fba646-0eab-46e4-a443-12a442734eee,
543d66eb-8c59-4eb4-819f-390eecceb83d,
87873ba6-7f69-408b-a7dc-e53a9810fd07; project
08df4698-1d4c-446b-b561-a616d7fb7e2b). All were removed. The second run verifies
the improved delta log mirror, readable /live actions and final auth handling.

Cleanup checks after both runs:

```text
$ ss -ltnp | rg ':(37187|32987)\b'
(no output)
$ node <read-only ps filter for this test's node processes>
(no output: no test/t3.test.js process remains)
$ cat ~/.t3/userdata/server-runtime.json
# pid: 192971; port: 3773; startedAt: 2026-11-08T00:28:40.536Z
```

The machine already has live services listening in 3770–3799, including T3 at
3773; none is from these tests. No test binds that range, 3396, 3754, 8000,
8080 or 8300. Test boards/fake servers use ephemeral ports. No installed T3
files or provider settings were edited, no server started/stopped/upgraded,
no rendered/GPU runs or screenshots taken. Auth credentials are never written
into evidence, attempt logs, prompts or manifests.

### Identity and accounting limits

The private executable supplies the same board URL, bounty id and slot header
as the old process env did. Existing board actor checks remain authoritative;
the fake test runs it with deliberately wrong ambient env and verifies that
start/progress reach the correct slot and ready/approve/done fail. This retains
the existing trusted-local-header model, not a new security sandbox.

T3 exposes per-turn main-agent tokens, not dollars. Attempt and live dollar
costs are null; the pre-existing bounty aggregate dollar field starts at zero.
Context snapshots are not spend and are never summed across turns. Interrupted
turn ledgers can be partial; usage status is exposed, rather than invented costs
or totals. Usage reaches live attempt data, then rolls into bounty totals once
when its thread turn ends, including after board restart.

### Verification

The pre-change existing suite passed **70/70**. The complete suite after the
initial implementation passed **78/78** (69.65 s), including eight new T3 tests.
The additional pending-stop/restart test then passed with **9/9 T3 tests**.
Final post-commit `npm test` output is recorded below and in the accompanying
`b9-t3-runner-npm-test.txt`.

Post-commit verification (implementation commit `bb0af95`):

```text
$ npm test
> bounty-board@1.0.0 test
> node --test --test-concurrency=1 test/

ℹ tests 79
ℹ suites 0
ℹ pass 79
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 70110.178136
(exit 0)
```

Full output: [b9-t3-runner-npm-test.txt](b9-t3-runner-npm-test.txt).
`git diff --check` also passed. No reviewer code was changed.
