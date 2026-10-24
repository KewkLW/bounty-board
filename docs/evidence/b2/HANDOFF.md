# Bounty #2: messages from the human, and unblock by the human (board side)

Branch `b2-r1-board-messages-from-the-human-and`. Gate: `npm ci --silent && npm test` -> 47 tests, 47 pass.

## What changed
- `lib/db.js`: new column `events.orch_read_at` (the orchestrator's read mark; `read_at`/`read_by` stay the worker's).
- `lib/board.js`: `humanNote()` stores an event of kind `human`, actor `human:<from>` (default `human`), text trimmed, 1..4000 chars. `unblock: true` on a `blocked` bounty runs `transition(..., 'ready', { actor: 'human:<from>', note: 'unblocked by the human (<from>)' })`. Not blocked (or a live worker still attached): the note is stored and the API answers 409 saying so. `humanNotes()` / `markHumanRead()` for the list and read endpoints. `notes()` (worker inbox, start/progress output, prompt) now covers kinds `message` and `human`.
- `lib/api.js`: `POST /api/bounties/:id/human-notes`, `GET /api/human-notes[?unread=1]`, `POST /api/human-notes/read {ids}`. Writes need `X-Board-Request: 1` and `Content-Type: application/json` (403 otherwise; checked before 404/400); worker slots get 403. No CORS middleware: an OPTIONS preflight gets no `Access-Control-Allow-*` headers (tested). `allow_cidrs` applies via the existing middleware (tested).
- `lib/prompt.js`: separate section `## Messages from the human (...)` with each line `(from the human, <from>)`; orchestrator notes section unchanged and excludes human notes.
- `lib/live.js`: unread-notes count includes human notes.
- `bin/bounty`: `bounty replies [--all] [--peek] [--json]`; inbox/start/progress print human notes under `=== N NEW MESSAGE(S) FROM THE HUMAN ... ===`; `bounty show` has a "Messages from the human" section; `bounty log` prints them above the transcript (not with `--raw`); the CLI sends `X-Board-Request: 1`. `replies` is orchestrator-only. Help documents it.
- `public/index.html`: drawer shows a separate sky-blue "From the human (n)" block with name, time, worker read state, orchestrator read state, multi-line text.
- README: "Messages from the human" section (endpoints, header rule, `bounty replies`), prompt list, day-to-day cheat sheet.

## Criteria -> evidence
1. Endpoints: `test/human-notes.test.js` "human-notes API": 403 without header / wrong value / text/plain / form body / worker actor, no CORS preflight headers, 404, 400 (empty, whitespace, missing, non-string, 4001 chars; 4000 ok), 200 with kind/actor, default from, 409 with note stored and `note_stored: true`, blocked -> ready with status event actor `human:kewk`, list newest first with all fields, read marks (403 without header, 400 bad ids, idempotent). "allow_cidrs applies" test.
2. Workers: "human notes reach workers": live worker gets it on `bounty inbox` and `bounty progress` under the human header; orchestrator read mark untouched by the worker; a later worker's prompt has the labelled human section, orchestrator section free of human text.
3. CLI: "bounty replies" test: unread printed (bounty, project, time, from, title, text, newest first) and marked read; `--peek` marks nothing; `--all` shows read ones; `--json`; workers refused; help text.
4. Dashboard: `test/drawer.ui.test.js` (headless /usr/bin/chromium via playwright-core) asserts the separate block and that orchestrator and human notes don't mix. Screenshot: `drawer-human-notes.png` (`BOARD_SHOTS_DIR=docs/evidence/b2 node --test test/drawer.ui.test.js`).
5. Tests + README as above.

## Notes for the orchestrator / hub (#3)
- 409 body: `{ error, note_stored: true, note, bounty: {id, status} }`. 200 body with `unblock: true` also carries `unblocked: true`.
- Extra 409 case: unblock on a blocked bounty whose worker process is still alive (it would otherwise be re-dispatched next to the live one). The note is still stored.
