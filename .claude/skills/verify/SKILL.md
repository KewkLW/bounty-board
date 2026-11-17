---
name: verify
description: Verify a change to the bounty board before committing or submitting it. Runs the unit and API suite, then boots a throwaway board (own port, DB, repo; never a live board) and drives a real bounty through submit, verify, review, merge and done, then checks the pages. Use before every commit to this repo, when asked to "verify", "smoke test", "QA" or "check it works", and for any bounty whose change touches lib/, bin/, server.js or public/.
---

# Verify a bounty board change

Prove it works in a running board, not only in unit tests. Nothing here touches a live board: every
step uses its own port, DB, logs and git repo under a temp dir. Never point `BOUNTY_URL` at a live
board's port (3777, 3778, ...) while testing, and never stop a board you didn't start.

## 1. Fast checks (about 2-3 min)

```bash
npm test 2>&1 | tail -12        # node --test, one file at a time; expect "fail 0"
```

Run `npm run test:rooms` as well when `rooms/` changed. For a failure, re-run that one file
(`node --test test/<file>.test.js`) and read the first `✖`. It counts as green only at `fail 0`.
Flaky tests are not re-run until green: find the cause, or delete the test and write down why.

## 2. Smoke run of the real board (seconds)

```bash
scripts/smoke.sh                 # SMOKE GREEN / SMOKE RED; scripts/smoke.sh /tmp/x keeps the workdir
```

It boots `server.js` on a free port with the fake worker and fake reviewer from `test/`. It then:

- files one bounty;
- waits for spawn, submit, verify and review;
- checks `submitted_sha = verified_sha = reviewed_sha`;
- checks that the reviewer prompt has REVIEW.md from main;
- merges the reviewed sha with the `bounty trailer` lines and waits for `done`;
- checks that `/`, `/status.html` and `/live.html` return 200.

If the change is in a path the smoke run doesn't reach, extend `scripts/smoke.sh` rather than
checking by hand once. The smoke run is the harness: keep it fast and deterministic.

## 3. Drive what you changed

Use the smoke board for anything the script does not cover. Run `scripts/smoke.sh /tmp/bb-x`, then
start the board again on that workdir's config:

```bash
BOUNTY_CONFIG=/tmp/bb-x/board.json BOUNTY_NO_SEED=1 node server.js &   # port is in board.json
export BOUNTY_URL=http://127.0.0.1:<port> PATH="$PWD/bin:$PATH"
bounty add "..." --project smoke --slot fake-1 --criteria "..." --ready
bounty show 2; bounty log 2; bounty trailer 2
```

- `test/fake-worker.sh` reads `mode:<x>` from the bounty description to misbehave on purpose:
  `notes-only`, `no-submit`, `stall`, `crash`, `linger`, `giveup`, `leak`.
- For UI changes, look at the page. Use Playwright from any directory (`require('playwright')`,
  `chromium.launch()`), screenshot at deviceScaleFactor 1, and read the image.

## 4. Real agents (only for reviewer, runner or prompt changes)

```bash
E2E_PORT=3899 test/e2e-real.sh /tmp/bb-e2e      # one claude haiku worker + the real Codex reviewer
```

This costs real tokens and takes a few minutes. Run it when the reviewer schema or prompt, a
runner, or the worker prompt changed, because the fakes don't validate those.

## Evidence

Report what you ran and what you saw: the test counts, `SMOKE GREEN`, the bounty id and its shas,
and the page or screenshot you looked at. On the board, pass the same thing to
`bounty submit --evidence "..."`.
