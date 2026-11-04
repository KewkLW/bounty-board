# b8: Chat tab and worker reports

## What changed
- `lib/room.js` (new): resolves the room (`board.json` `room` {id, url, as?}, else the `AGENT ROOM:` machine rule, else none), the poster name (same rule as `roomctl board-sync`'s board member: `name`, else title-cased `default_project`, else `Board <port>`, sanitized to a room name), the outcome of an ended attempt, the message text, and `RoomClient` (POST `/api/r/<id>/post` with `X-Room-Request: 1`; joins once on a 403 "not joined"; 5 s timeout; every failure logged as `[room] ...`, never thrown).
- `lib/config.js`: `cfg.room_resolved`. `lib/board.js`: `board.room` (a `RoomClient`).
- `lib/dispatcher.js`: `onExit` (the one place every worker attempt ends: exit, watchdog kill, orchestrator kill, gone after restart) calls `reportToRoom` after its own transitions. `willDispatch(slot)` repeats `tick()`'s checks for one slot (paused, benched, busy, cap, `nextFor`): true means no "what's next".
- `lib/api.js`: `GET /api/room`. `server.js`: `/chat`.
- `public/chat.html` (new): the room page in a full-height iframe between a thin bar and the dock; a loopback room URL is rewritten to `location.hostname` (tailnet). No `referrerpolicy` on the frame: roomd allows a 100.64.0.0/10 parent by its Referer.
- `public/chat-tab.js` (new) + a Chat link after Status in the dock of index, live, status, roster, leaderboard (hidden until `/api/room` names a room).
- README: "Chat tab and worker reports" (setting, message format, outcomes, idle rule, failure handling); theming list mentions chat.html.

## Acceptance criteria
1. `room` setting, rule fallback, none: `test/room.test.js` "room resolution"; `/api/room` null case in "no room configured". Attempt 3 (review fix): chat.html's own Chat dock link starts hidden and is shown only once `/api/room` returns a room; `test/chat.ui.test.js` asserts it hidden on `/chat.html` without a room and visible with one.
2. Chat tab on all five pages, next to Status; chat.html full height at 1280x900 and 390x844; tailnet host: `test/chat.ui.test.js` (asserts link visible and right after Status on each page, iframe src, frame content, iframe box between bar and dock, dock fits 390 px, `roomSrc` rewrite for a `*.ts.net` name and a 100.x IP; hidden on every page without a room). Screenshots: `chat-desktop.png`, `chat-phone.png` (fake room page), `chat-real-roomd-*.png` (a scratch roomd, below).
3. One message per ended attempt, from the board's member name, to the orchestrator, idle tail only when nothing will be dispatched; posted through the room HTTP API; failure logged, board unaffected: `test/room.test.js` board tests (crash then a good bounty on one slot: first has no "what's next", second has it; exactly 2 posts; a 500 room leaves the board dispatching and answering). Attempt 2 (review fix): the idle check is `Dispatcher.plan()`, the same ordered plan `tick()` dispatches from (slot order, cap, a bounty claimed by an earlier slot is not counted for a later one); regression test "idle tail follows the tick plan" covers an earlier slot taking the last place under the cap, an earlier slot taking the same unassigned bounty, and the not-idle case.
4. Unit tests with a fake room server: text for every outcome (submitted, verifying, verify failed, exited, exited by signal, failed exit N, never started, blocked with reason, log path stripped, failed), idle/not idle, no room = no request, 500 and unreachable tolerated, join-on-first-post.
5. README section "Chat tab and worker reports".
6. Coordination: tested against agent-rooms **4425b36** ("Board Chat tabs: frameable room pages, the board as a room member"). Scratch run (not in `npm test`): roomd from that commit on 127.0.0.1:3497 with a temp rooms dir and delivery stubbed (`AGENT_ROOMS_AGENT_SEND=/bin/true`), `roomctl create` + `theme-done` + `board-sync` on a scratch board.json (it wrote `"room": {"id": "scratch-room", "url": "http://127.0.0.1:3497/r/scratch-room/"}` and joined "Scratch Board"), then a board from that config with the fake worker:
   ```
   room #6 Scratch Board: @Conductor Alpha (fake-1) finished #1 crashes: failed (never ran bounty start).
   room #7 Scratch Board: @Conductor Alpha (fake-1) finished #2 Add mul() with a test: submitted. Alpha is idle: what's next?
   desktop room page 200 csp: frame-ancestors 'self' http://127.0.0.1:* http://localhost:* http://*.ts.net:* https://*.ts.net:* xfo: none
   desktop framed page shows the report: true | members incl. Scratch Board: true
   phone room page 200 csp: ... (same) | framed page shows the report: true | members incl. Scratch Board: true
   ```
   The scratch roomd was stopped by its recorded pid; no live room was posted to.
7. `npm ci --silent && npm test`: 81 tests, 81 pass, 0 fail on attempt 2 (includes test/room.test.js and test/chat.ui.test.js).

## Decisions
- A verify that fails after the worker exited already got "submitted, verifying"; the requeue posts nothing more (one message per attempt).
- The board posts over loopback on the room URL's port even when the URL names the tailnet host.
- Orchestrator: `board.json` `orchestrator`, else the room's admin (`GET /api/r/<id>`).
