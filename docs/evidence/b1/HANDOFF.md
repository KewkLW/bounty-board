# b1 / H1 Hub: one page for every running project's status

## What landed
- `lib/registry.js`: each board writes `<registry_dir>/<port>.json` (name, port, host, default_project, public_dir, accent, pid, started_at, stopped_at) with an atomic temp-file and rename. `close()` marks it stopped, but only when the same pid wrote it. Default dir: `$XDG_STATE_HOME/totally-not-a-kanban/boards` (`lib/config.js` `registry_dir`, env `BOUNTY_REGISTRY_DIR`). A dead pid counts as stopped.
- `server.js`: registers inside `listen()` once the real port is known and unregisters in `close()`. `allowList` moved to `lib/allow.js` so the hub can share it. No new config keys are needed (`name` and `accent` are optional).
- `lib/goals.js`: the status.js goal rules (gate done means reached, a done road means "Road done, exit test not recorded", the first open goal is Now) plus the note stale flag (3 h), computed on the server. `public/status.js` is unchanged because themed boards symlink it.
- `hub/server.js`: `node hub/server.js`. Port comes from `HUB_PORT`, `PORT`, `config/hub.json` or defaults to 3770. It uses the same `allow_cidrs` model (loopback and Tailscale by default). It reads the registry on every request and fetches each board in parallel with a 3 s timeout. It caches the result for 5 s. `GET /api/hub` returns boards sorted working, then idle, then offline. Each board has `url`, `online`, `stats`, `note{headline,written_at,stale}`, `goals` with roads, `working[{slot,slot_name,bounty}]`, `attention[{status,blocked_reason}]` and `recent`, plus a top-level `needs_you`.
- `hub/public/`: an All tab (Needs you, then one card per project) in the default Omarchy look (`op.css`, `op-theme.js`, `status.css` blocks). Then one tab per project in its accent color, with links to the board, its Status page and Live. Tabs use `role=tablist/tab/tabpanel` with roving tabindex and Left/Right/Up/Down/Home/End. The selected tab is kept in the hash. The page refreshes every 30 s.
- `systemd/bounty-hub.service`, `config/hub.example.json`, README "One page for every project", skill step 11.
- `playwright-core` devDependency (drives `/usr/bin/chromium`, no browser download). `.npmrc` sets `include=dev` so `npm ci` installs it even with `NODE_ENV=production`, which is set on this machine. Without it the UI test would skip.

## Tests (`npm ci && npm test`: 39 pass, 0 skipped)
- `test/hub.test.js`: registry (atomic write, bad files skipped, dead pid, mark stopped, pid guard), accent detection, a board registering on start (port 0 resolves to the real port), the real `node server.js` registering under `$XDG_STATE_HOME/totally-not-a-kanban/boards` and SIGTERM marking it stopped, goal rules, and `/api/hub` against two fake boards plus a dead port. The aggregation test also covers a board registered after the hub started (picked up without a restart), a board going offline, a clean stop, `/api/hub` against a real board, the hub config defaults, and a 403 for an outside address.
- `test/hub.ui.test.js`: headless Chromium checks tab order, Needs you with project and reason, the cards (headline, Now goal, bar, working count, red blocked count, offline last), click and arrow-key tab switching with wrap and Home, the accent and board link on a project tab, the selected tab surviving a reload, and `scrollWidth <= 390` on All and on a project tab at 390 px.
- `test/helpers.js` gives every test board a temp `registry_dir`, so tests never touch the real state dir. After the full run `~/.local/state/totally-not-a-kanban` does not exist.

## Screenshots (from the UI test with `HUB_SHOTS_DIR=docs/evidence/b1`, fixture data only)
- `hub-all-desktop.png`, `hub-project-desktop.png`, `hub-all-390.png`, `hub-project-390.png`

## Not done here
- I bound no port in 3770-3790 and did not start the hub against the live boards. The orchestrator rolls boards and starts the hub.
- The working rows come from `/api/state` (slot name, bounty, heartbeat, start time), not `/api/live`, to avoid process-tree scans across every board each 30 s. So they show no per-worker progress note.
