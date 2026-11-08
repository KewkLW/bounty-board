# Bounty #9: installed T3 unavailable (attempt 1)

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
