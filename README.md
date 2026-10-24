# Totally not a Kanban >_<

> **TLDR:** Just tell your AI to clone and set it up and then your next project tell the agent to start a board for it, if it didnt already.

> For Claude Code: copy `skill/totally-not-a-kanban/` into `~/.claude/skills/` and it knows how to install the board, start one per project, and keep its Status page current.

## Why use it

Run a few AI agents in parallel and you hit the same problems fast: they say "done" when nothing landed, they stall silently, they drift off task, and you lose track of who is doing what. A Kanban board just shows you cards. This one makes the agents prove it.

- **"Done" means merged.** A bounty only counts as done when its commits are on main. No more agents claiming work they never shipped.
- **Every submit gets checked.** The branch has to exist, the diff can't be empty, your tests have to pass, and a second model reviews the real diff against your acceptance criteria before anything is approved.
- **Stalled agents get caught.** A watchdog kills workers that go quiet, blocks the bounty with the log attached, and retries on a stronger model.
- **You stop babysitting.** Workers spawn on their own when a bounty is ready, one fresh agent per task, so you plan the work and the board runs it.
- **You can see everything.** A live dashboard shows what every agent is doing, what it costs, and what is stuck.
- **Check in from your phone.** Put the machine on Tailscale and open the board from your phone anywhere, with live updates and no port forwarding or public exposure.
- **Every project gets its own world.** When your agent starts a board, it designs a theme from the project itself: its palette, its art, its mood, and a set of agent names that fit (a Raspberry Pi project can name its agents after raspberry varieties and draw the board as a circuit board; a music app can look like a DJ booth). You always know which board you're on, and agents earn loot on a leaderboard for verified work only.

AI agent orchestration with teeth. Spawn workers, track bounties, verify work, ship code.

The single accountability system for every AI agent. Work that is not marked done on this board is a known gap. Workers are spawned by the board, one fresh agent per bounty, and a bounty only reaches **done** when its commits are on the project's main branch.

![Board view](screenshots/kanban.jpg)

![Leaderboard](screenshots/leaderboard.jpg)

## What it does

- **Auto-dispatch workers**: Claude and Codex agents are spawned automatically when a ready bounty is assigned to an idle slot
- **Full lifecycle**: backlog, ready, in_progress, review, approved, done, plus blocked and failed
- **Watchdog**: kills stalled workers, blocks bounties with the log attached, retries with model escalation (sonnet to opus)
- **Automated code review**: Codex reads the real diff against acceptance criteria; approvals that don't cite evidence are overruled to reject
- **Verification gates**: branch must exist, diff must be non-empty, project's CI/verify command must pass
- **Merge check**: approved bounties auto-complete to done when their commits land on main
- **Live dashboard**: real-time view of what every agent is doing, token usage, cost, lock state, memory
- **Leaderboard**: XP/loot system derived from verified work, streaks, cost tracking
- **CLI**: `bounty` command for everything (add, assign, ready, submit, live, leaderboard, etc.)
- **A unique theme per project**: the agent designs each board's look and agent names from the project itself, not a shared skin
- **Notes to live workers**: send requirements or context to a running agent mid-task
- **External leases**: model machine-wide resource locks (GPU, build locks) visible on the dashboard

## Quick Start

```bash
git clone https://github.com/KewkLW/bounty-board.git
cd bounty-board
cp config/board.example.json config/board.json
# edit config/board.json: set your slots, project, repo path
npm install
npm start
# open http://localhost:3777
```

Set up a project (if you didn't use `seed_project` in config):
```bash
bounty project add my-project \
  --repo /path/to/repo \
  --main main \
  --verify "npm test" \
  --wt-cmd "git worktree add {path} -b {branch} {main}" \
  --wt-path "worktrees/{task}"
```

Add your first bounty:
```bash
bounty add "Fix the login bug" \
  --desc "Users can't log in after password reset" \
  --criteria "Password reset flow completes successfully" \
  --criteria "Existing sessions are preserved" \
  --type bug --tier B --slot opus-1 --ready
```

The dispatcher spawns a fresh Claude worker for opus-1. The worker reads the bounty, writes code, runs tests, and submits. The board verifies, the reviewer checks the diff against your criteria, and once approved and merged, the bounty is done.

## How it works

```
backlog -> ready -> in_progress -> review -> approved -> done
             plus blocked (with a reason) and failed
```

| Step | Who | What the board checks |
|---|---|---|
| backlog to ready | orchestrator (`bounty ready`, UI) | a project, and at least one acceptance criterion |
| ready to in_progress | the worker (`bounty start`) | the dispatcher spawned it for the assigned slot |
| in_progress to review | `bounty submit`, then the gates | the branch exists; its diff against main is not empty; the diff is not only notes/logs (docs and research bounties may be docs-only); the project verify command passes on the branch tip (result and log stored) |
| review to approved / ready | the reviewer (Codex, `codex exec -s read-only`) | reads the real diff and the acceptance criteria; returns approve/reject with per-criterion evidence; an approval that does not show every criterion met is overruled to reject. Reject sends the bounty back to ready with the notes for a fresh worker |
| approved to done | the merge check (every 60 s, or `bounty done`) | every recorded commit is reachable from main (or main holds the same patch: rebase, cherry-pick or squash merges count) |

Work done off the board (an `external` bounty, e.g. one in flight before the board existed) never goes through submit, so it can't reach approved. When the orchestrator has merged it, `bounty close-merged ID --commit SHA [--commit SHA]... ["evidence"]` (API `POST /api/bounties/:id/close-merged {commits, evidence}`) takes it to done from any open status: every commit must exist in the project repo and be an ancestor of main (it is refused otherwise, and refused while the bounty has a live board worker or a verify running). Loot goes to a slot only if that slot's board attempt submitted commits that are on main; otherwise no one is credited. Orchestrator only.

`review`, `approved` and `done` are guarded edges: no request can set them directly. Workers (requests carrying a slot id) can't ready, assign, approve, reject, fail, pause or mark done.

## Setting up AI Workers

### Slot configuration

Slots are your worker capacity. Each slot in `config/board.json` defines an agent that can run one bounty at a time:

```json
{
  "slots": [
    {
      "id": "opus-1",
      "name": "Alpha",
      "runner": "claude",
      "model": "opus",
      "effort": "high"
    },
    {
      "id": "sonnet-scout",
      "name": "Scout",
      "runner": "claude",
      "model": "sonnet",
      "effort": "low"
    },
    {
      "id": "codex-1",
      "name": "Delta",
      "runner": "codex",
      "model": null,
      "effort": "high"
    }
  ]
}
```

Every slot **must** have a unique `name`. The name is the agent's identity for the project's life: it shows on the dashboard, is sent to the telemetry receiver as `agent.name` next to `project`, `bounty.id`, `bounty.slot` and `bounty.attempt`, and appears on the leaderboard. Keep names stable; renaming starts a new series.

The only agents are the dispatcher slots in `config/board.json`. At every start the board runs a re-runnable migration that deletes any agent row not matching a configured slot. An agent row can only be created for a configured slot: `POST /api/agents {id}` and `board.registerAgent` refuse any other id (403), and `GET /api/agents/<non-slot>` is a 404.

Optional fields:
- `bin`: override the CLI binary (e.g. a different Claude account)
- `disabled_until`: ISO timestamp; the slot takes no work until then
- `worktree_root`: build worktrees on a different drive

### Claude workers

Claude workers run:
```
claude -p --output-format stream-json --verbose --model <model> --effort <effort> --allowedTools <tools>
```

Configure the runner in `board.json`:
```json
"runners": {
  "claude": {
    "bin": "claude",
    "allowed_tools": "Bash,Read,Grep,Glob,Edit,Write,MultiEdit,TodoWrite,WebSearch,WebFetch"
  }
}
```

The `allowed_tools` list controls what the Claude agent can do. The board spawns a fresh `claude` process for each bounty attempt.

### Codex workers

Codex workers run `codex exec --json`. Configure the runner:
```json
"runners": {
  "codex": {
    "bin": "codex",
    "args": ["--dangerously-bypass-approvals-and-sandbox"]
  }
}
```

### The worker protocol

Every spawned worker gets a prompt containing the bounty, its acceptance criteria, notes from earlier attempts, project rule docs, and the CLI protocol:

```
bounty start                       # first (prints any waiting orchestrator notes)
bounty inbox                       # unread orchestrator notes, marked read
bounty progress "note" [--check N] # heartbeat, at least every 15 min
bounty split "title" --desc "..."  # gaps found go to backlog as children
bounty block "reason"              # stuck: block and exit
bounty submit                      # commit on the branch first; gates + review follow
```

The prompt also carries `machine_rules` from `config/board.json` and every orchestrator note on the bounty.

### Writing good acceptance criteria

The Codex reviewer reads the real `git diff` against your criteria. Write criteria that are:

- **Observable in the diff**: "The login endpoint returns 200 on valid credentials" is checkable. "The UX feels better" is not.
- **One thing per criterion**: the reviewer evaluates each line independently
- **Specific**: "All tests pass" is better than "code works". "The `UserAuth.login()` method handles expired tokens" is better still.

Bad: "Fix the bug and make sure everything works"
Good:
```
- [ ] The reset-password handler sets the new hash before invalidating the token
- [ ] Existing sessions are not destroyed on password change
- [ ] Tests cover the happy path and the expired-token edge case
```

### How the reviewer works

After a worker submits and the verify command passes, the Codex reviewer:
1. Reads the full `git diff` between the bounty's branch and main
2. Reads every acceptance criterion
3. Returns approve or reject with per-criterion evidence from the diff
4. An approval that doesn't cite evidence for every criterion is overruled to reject

Configure the reviewer:
```json
"reviewer": {
  "runner": "codex",
  "timeout_minutes": 25,
  "max_diff_chars": 160000,
  "max_errors": 3
}
```

### Watchdog and retries

The watchdog kills workers that go silent:
- `stall_minutes`: how long a worker can be silent before it's killed (default 30)
- Log output, heartbeats (`bounty progress`), and tool calls all count as activity
- Killed workers get their bounty blocked with the log attached

Retry and escalation:
```json
"retry": {
  "max_attempts": 4,
  "escalate_after_failures": 2,
  "escalate_model": {
    "haiku": "sonnet",
    "sonnet": "opus"
  }
}
```

After 2 failures on sonnet, the bounty escalates to opus. Fresh worker, fresh attempt, with notes from all prior failures in the prompt.

### The prompt system

Each worker's prompt is assembled from:
1. The bounty title, description, and acceptance criteria
2. Notes from all prior attempts (what failed, reviewer feedback)
3. Machine rules from `config/board.json`
4. Orchestrator notes sent via `bounty note`, and messages from the human (the hub reply box, `POST /api/bounties/:id/human-notes`) in their own section
5. The CLI protocol (how to report progress, submit, block)

The full prompt is saved alongside each attempt's log for debugging.

## Dashboard

- Dashboard: `http://localhost:3777/` (kanban, slots, locks, pause switch, add/edit/assign)
- Live: `/live` (what every agent is doing right now)
- Status: `/status.html` (goals, the orchestrator's note, what is moving; see "The Status page")
- Roster: `/roster` (the slots and their stats)
- Leaderboard: `/leaderboard` (loot from verified work)
- CLI: `bounty help` (symlink `bin/bounty` to your PATH)
- Service: install `systemd/bounty-board.service` as a user unit
- Hub: `node hub/server.js` on :3770, one page for every running board (see "One page for every project")
- Tests: `npm test`

Only addresses in `allow_cidrs` may connect. The default allows loopback and Tailscale ranges (100.64.0.0/10).

## Dispatcher

Slots are defined in `config/board.json` with a model and effort level, plus a global `concurrency_cap`. When a slot has no live worker and a `ready` bounty is assigned to it (dependencies done), the board creates a worktree and spawns one fresh worker. When the worker exits, the slot takes its next ready bounty; with none, it idles.

- **Pause switch**: `bounty pause` / `resume` or the header button. Running workers finish; nothing new spawns.
- Workers outlive a board restart (`KillMode=process`) and are re-attached when it starts.

## Live: what every agent is doing right now

`/live` (the pulse icon in the nav), `GET /api/live` (JSON; `?format=text` for plain text) and `bounty live [--json] [--watch [SEC]]` show the same snapshot. Read-only; the page polls every 5 s and also reloads on board websocket events.

- **Per slot**: idle or working; the bounty (#, title, type, tier, priority), attempt number, pipeline status, elapsed time, tokens and cost (the real $ once the result event lands; before that `~$` is an estimate), the latest `bounty progress` note, unread orchestrator notes, the last actions parsed from the worker log, the last assistant text line, how long the log has been silent (flagged "possibly stuck" past `live.stuck_minutes`), the worker's own CI runs and their stage, notable child processes, and lock state.
- **Machine**: external lock holders, MemAvailable.
- **Queue**: each slot's next startable bounty and its other ready bounties, unassigned ready work, and bounties done or failed in the last 24 h.
- **Cost**: logs are followed incrementally (only appended bytes are read), the process table is one `ps`, and a snapshot is cached for 2 s.
- Config (optional) `live`: `{ "lock_dir", "stuck_minutes", "recent_hours", "tester": { "service", "timer", "log_dir" } }`.

## External leases

For projects that need machine-wide resource locks (e.g. GPU, build server), configure `external_leases` in `config/board.json`:

```json
"external_leases": {
  "gpu": {
    "what": "GPU render lock",
    "lock_file": "/run/user/1000/render.lock",
    "holder_file": "/run/user/1000/render.holder",
    "projects": ["my-project"]
  }
}
```

Workers take and release the lock via the configured script. The dashboard shows who holds it. Other resources use the board's own TTL lease table: exclusive, renewable, released on expiry or when the holder's worker dies.

## Notes to live workers

`bounty note ID "text"` (API `POST /api/bounties/:id/notes {text}`, or the note box in the dashboard drawer) tells a running worker something new: a changed requirement, a machine rule. Notes are `message` events in the bounty history with a read mark. The worker gets unread ones from `bounty inbox`, and in the output of `bounty start` and `bounty progress`; each gets marked read by whoever received it. Every later attempt gets all notes in its prompt. `bounty inbox ID --peek` (`GET /api/bounties/:id/inbox`) shows what a worker hasn't read yet without marking it; `bounty inbox ID --all` lists all notes with read state.

## Messages from the human

The person running the board can answer a worker or the orchestrator without a terminal: the hub's "Needs you" list has a reply box and a Done button on every item, and both call this API on the item's board. A message from the human is an event of kind `human` (actor `human:<from>`) in the bounty history. It shows in the dashboard drawer in its own "From the human" block (apart from orchestrator notes), in `bounty show` and at the top of `bounty log`. The live worker gets it like an orchestrator note (`bounty inbox`, `start`, `progress`, under a `FROM THE HUMAN` header), and every later worker gets all of them in its prompt under "Messages from the human". The orchestrator has its own read mark, so a worker reading a message doesn't hide it from `bounty replies`.

| Endpoint | Body | Result |
|---|---|---|
| `POST /api/bounties/:id/human-notes` | `{ "text": "1..4000 chars", "from": "name (default human)", "unblock": true }` | `{ note, bounty: {id, status} }`. With `unblock: true` a `blocked` bounty moves to `ready` (the status event's actor is `human:<from>`). 400 empty or too long text, 404 unknown bounty, 409 when unblock is asked but the bounty is not blocked: the note is still stored, and the 409 body says so (`note_stored: true`, plus `note` and `bounty`) |
| `GET /api/human-notes[?unread=1]` | | the human notes, newest first: `id, bounty_id, title, project, text, from, created_at, read` (`read` = the orchestrator has seen it) |
| `POST /api/human-notes/read` | `{ "ids": [noteId, ...] }` | `{ marked }`: marks those read for the orchestrator |

Both writes need the header `X-Board-Request: 1` and `Content-Type: application/json`, or they get 403. A page on another origin can't send either without a CORS preflight, and the board answers no preflight, so a random web page can't post as the human. Worker slots get 403 too. `allow_cidrs` applies as for the rest of the API.

```bash
bounty replies            # unread messages from the human (bounty, project, time, from, text); marks them read
bounty replies --peek     # the same, nothing marked read
bounty replies --all      # read ones too (marks the unread among them read; add --peek to mark nothing)
bounty replies --json
```

## Orchestrator day to day

```bash
bounty status                          # slots, locks, counts
bounty list [--project P] [--status ready,blocked]
bounty add "Title" --desc "..." --criteria "..." --type bug --tier B --slot opus-1 [--ready]
bounty add --file task.md              # "# Title", "## Acceptance criteria" with - [ ] lines
bounty edit 12 --criteria "..."        # criteria are required before ready; --project P moves it
bounty note 12 "new requirement"       # reaches the live worker and later attempts
bounty replies                         # what the human answered from the hub (marks it read)
bounty assign 12 opus-2 && bounty ready 12
bounty show 12 / bounty log 12         # history, attempts, logs, review notes
bounty approve 12 | bounty reject 12 "what to fix"
# merge the approved branch into main yourself; the board marks it done
bounty close-merged 59 --commit 8ae0fb5 "evidence"   # external work, no submit/review
```

Without `--project`, `bounty add` uses `default_project` from config, or the only non-legacy project if there is exactly one.

Projects are generic: `bounty project add ID --repo PATH --main main --wt-cmd CMD --wt-path TPL --verify CMD`.

## Loot, levels, streaks

Nothing on the leaderboard is a stored counter. `board.ledger()` replays history:

- **Done**: a slot earns a bounty's reward only when the bounty reached done through the merge check or `close-merged` (commits on main). The credit goes to the slot whose attempt produced the work.
- **Done**: credit goes to the slot whose attempt produced the work: the slot that last submitted the branch, and the attempt running at that submit (`bounties.credited_slot` / `credited_attempt`, set when it goes done). `close-merged` credits a slot only if the commits that slot submitted are on main; work done off the board credits nobody.
- **Failure**: every other finished worker attempt of a slot (rejected, verify failed, blocked by the watchdog, exited without submit) resets the streak and costs half the base reward. The latest attempt of a bounty still in the gates, review or approved is pending, not a failure.
- **Reward**: by type and tier (bug S/A/B/C = 5000/2500/1000/250, other types 5000/2000/750/150), x1.25 when done on the first try, x(1 + 0.1 per streak) capped at x2.
- **Cost**: the real $ from the slot's attempts (Claude's result event; Codex reports tokens only).
- The `legacy` project never counts. Header stats (`/api/state` stats, `bounty status`) leave legacy out: status counts, loot = the slots' derived loot, spent.

The `agents` table's counters are only a cache, rebuilt from the ledger on every bounty change and at start (a test checks they match). `/api/agents`, `/api/agents/leaderboard`, the roster, the leaderboard and the dashboard slot cards show the slots only, with loot, done, failed, streak and cost; a slot with no verified work shows zero.

Tier names: bug = Kill Order / Wanted: Dead / Bounty Posted / Pest Control; task = Black Ops / Merc Contract / Salvage Run / Scrap Work.

## Per-project theming

Each project gets its own board instance with its own themed UI, designed by the agent that starts the board from the project itself (its colors, art, logo, tone, and a fitting name list for the agents). The included default theme uses the Tokyo Night palette with a dark, grunge-overlaid aesthetic; it is the starting point the agent restyles, never the finished look.

To create a themed board:
1. Copy `public/` to your project's board directory
2. Set `public_dir` in that board's `config/board.json` to point at it
3. Restyle the CSS (colors, backgrounds, fonts) and edit `avatars.js` to give each slot a portrait and color palette
4. Each project gets its own port, systemd unit, and CLI wrapper with `BOUNTY_URL` set

The theme files:
- `op.css`: all visual styling (colors, panels, bar, dock, handset frame)
- `op-theme.js`: Tailwind config (color tokens, shadows, fonts)
- `avatars.js`: per-slot portraits, color swatches, fallback avatars
- `status.html`: copy it from your themed `live.html` (header and nav); symlink `status.js` and `status.css` from the default `public/`
- `img/`: backgrounds, favicon, slot portraits in `img/portrait/`
- `index.html`, `live.html`, `roster.html`, `leaderboard.html`: the four pages

See the "A board per project" philosophy: every new board must get its own themed UI. This is mandatory, not polish.

## The Status page: goals and the orchestrator's note

`/status.html` is the page to check instead of asking. It shows the project's goals with the bounties that lead to each one, the orchestrator's latest note, what is running, what needs attention, and what finished in the last 24 hours. It refreshes every 30 seconds and reads the board API live, plus two files the orchestrator keeps in the board's public folder:

`status-goals.json`:
```json
{ "goals": [
  { "id": "M1", "name": "Walk around town", "goal": "what it is, in a sentence",
    "test": "the exit test, in words someone can check",
    "state": "open", "when": null, "evidence": null,
    "gate": 43, "road_prefix": "M1." }
] }
```
- `road` (a list of bounty ids) or `road_prefix` (every bounty whose title starts with it) is the path to the goal.
- `state` is `open`, `reached` or `closed` (not opened yet). A goal shows as reached only when the orchestrator records it (`state: "reached"` with `when` and `evidence`) or its `gate` bounty (the acceptance run) is done. A road that is all done without that shows as "road done, exit test not recorded".
- The first open goal is marked **Now**.

`status-notes.json`:
```json
{ "written_at": "2026-10-24T11:00:00-07:00",
  "headline": "one line: where things stand",
  "body": ["paragraphs, **bold** and `code` allowed"] }
```
The orchestrator rewrites this every round. A note older than three hours is flagged as stale on the page.

A themed board copies `status.html` from its own `live.html` (header, fonts and nav) and symlinks `status.js` and `status.css` from the default `public/`.

## A board per project

Each project gets its own board instance, never a shared one: its own config directory, port, systemd user unit (`Environment=BOUNTY_CONFIG=...` and `BOUNTY_NO_SEED=1`), CLI wrapper exporting `BOUNTY_URL`, and project entry. With two or more running, start the hub (see "One page for every project").

## One page for every project

With more than one board running, the hub gives you one page for all of them so you never have to remember ports.

```bash
node hub/server.js          # http://localhost:3770
```

- **All** tab first: one card per project with the orchestrator's headline, the Now goal and its progress bar, how many workers are on it, a red count of bounties waiting on you and a muted count of other blocked bounties. **Needs you** at the top lists every bounty waiting on a person across all projects with its project and the reason (the first 5, then **Show all**). Offline and idle boards sort last.
- **Needs you is only for people.** A blocked bounty counts when its reason contains one of the hub's `human_markers` (case-insensitive): `waiting on`, `needs a human`, `blocked on a human`, `needs the user`. Add your own in `config/hub.json`, e.g. with your name, `"human_markers": ["Your Name"]`; they add to the defaults. Everything else that is blocked (a worker crash, a note from one agent to another) shows under **Blocked** in its project's tab and in the muted count on its card, never in Needs you. So when an agent blocks on you, it should write one of the markers in the reason.
- Long text never floods the page: block reasons and the orchestrator's note show 2 lines with a **Show more** button.
- **Reply from the page.** Every Needs you item (on the All tab, and under **Waiting on you** in its project's tab) has a text box, **Send** and **Done, unblock it**. Enter in the box sends. Done sends your text, or "Done" when the box is empty, and unblocks the bounty; it leaves Needs you on the next refresh. After a send the item shows what you sent and when. If it fails, the error shows under the box and your text stays in it. The text you are typing survives the 30 s refresh. Replies are signed with `human_name` from `config/hub.json` (default `human`).
- Then one tab per project with that board's full status (note, goals with their roads, working, needs attention, finished in 24 h) in the board's accent color, and links to the board, its Status page and Live. Tabs work with the arrow keys, Home and End.
- The page refreshes every 30 seconds and fits a phone.

**How boards are found.** Every board writes `$XDG_STATE_HOME/totally-not-a-kanban/boards/<port>.json` (default `~/.local/state/...`) when it starts: name, port, default project, public dir, accent, pid. The write is atomic (temp file and rename). A clean exit marks the file stopped. The hub reads that directory on every request, so a board started later shows up without restarting the hub; a board that does not answer, or whose process is gone, shows as offline. Stopped boards drop off after 7 days. Existing board configs need no changes. Optional keys in `board.json`: `name` (else the default project's name, else the project id title-cased, `my-garden` as "My Garden"), `accent` (else `--accent` or `--blue` from the board's `op.css`) and `orchestrator` (the name of the agent orchestrating this board, for `on_reply`). `BOUNTY_REGISTRY_DIR` moves the directory for boards and hub alike.

The hub server fetches each board's `/api/bounties`, `/api/bounties/stats`, `/api/state`, `status-goals.json` and `status-notes.json` over loopback (a browser could not read the other ports) and serves one aggregated JSON at `GET /api/hub`.

**Replies go through the hub.** The page never talks to a board directly. It posts `POST /api/reply` with JSON `{port, bounty_id, text, unblock}` and the header `X-Hub-Request: 1` (without it, or without `Content-Type: application/json`, the hub answers 403, so a link or a form on another site cannot send one). The hub only accepts the port of a registered board (404 otherwise) and forwards to that board's `POST /api/bounties/:id/human-notes` with `{text, from: human_name, unblock}` and `X-Board-Request: 1`. The board's answer comes back as is (`{note, bounty:{id,status}}`, 400 empty, 404 unknown bounty), plus `saved` and `delivered`. A 409 (unblock on a bounty that is no longer blocked) still stored the note, so the page shows it as saved with that warning. A board that does not answer is a 502.

**Delivering a reply live: `on_reply`.** Saving the note on the board is enough for a worker that reads `bounty inbox`. To also push it to a running agent right away, set `on_reply` in `config/hub.json` to a command as an argv array. It runs without a shell, so nothing in the text is ever interpreted:

```json
"on_reply": ["/path/to/your/relay", "--to", "{orchestrator}", "[{board} #{id} {title}] {text}"]
```

Placeholders, filled in each argument in one pass (a `{id}` typed in the text stays as typed): `{board}` (board name), `{project}` (the bounty's project, else the board's default), `{port}`, `{id}`, `{title}`, `{text}`, `{unblock}` (`true` or `false`), `{orchestrator}` (`orchestrator` from that board's `board.json`, copied into its registry entry; empty when unset). The hook runs after the board stored the note, and the hub waits for it up to `hook_timeout_ms` (default 15000, then it is killed). A non-zero exit, a timeout or a missing program never fails the reply: the page shows "saved on the board, not delivered live". No `on_reply` means save only. `reply_timeout_ms` (default 5000) bounds the call to the board.

**Config.** Port from `HUB_PORT`, `PORT`, or `port` in `config/hub.json` (copy `config/hub.example.json`; `HUB_CONFIG` points elsewhere), default 3770. `allow_cidrs` works as on the boards: loopback and Tailscale ranges by default.

**As a service.** `systemd/bounty-hub.service` is a user unit:
```bash
cp systemd/bounty-hub.service ~/.config/systemd/user/   # edit the paths
systemctl --user daemon-reload && systemctl --user enable --now bounty-hub
```

**On your phone over Tailscale.** Open `http://<machine>.<tailnet>.ts.net:3770/`. The board links on the page use the same host name, so they work from the phone too. Never widen `allow_cidrs` to the public internet.

## History

The February 2026 board broke because agents faked work (appending to WORK_LOG.md) and the old reviewer approved any evidence string longer than 50 characters. Its 57 bounties are kept under the `legacy` project with their old agent names as text; its agents and their inflated loot were deleted, and legacy work never counts toward loot. The gates above exist so that cannot happen again.
