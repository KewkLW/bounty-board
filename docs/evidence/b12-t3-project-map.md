# b12: T3 project per board project (M0.7)

Follow-up to #9. A board project can now choose the T3 project its threads start in,
so a slot serving two board projects no longer starts every thread in one T3 project.

## Shape

`runners.t3.projects` in config/board.json maps board project id → T3 project id:

```json
{ "runners": { "t3": { "projects": { "bounty-board": "<t3 project id for /mnt/f/bounty-board>" } } } }
```

Precedence, resolved per dispatch in `lib/t3-workers.js` (`t3ProjectFor` + `T3Workers.spawn`),
first non-empty match wins:

1. `runners.t3.projects["<bounty's board project>"]`
2. slot `t3.project_id`
3. `runners.t3.defaults.project_id`

Empty strings count as unset at every level. Documented in README "T3 workers".

## Fail closed

With nothing resolvable, `T3Workers.spawn` throws before generating a thread id, before
the attempts row and before `orchestration.launchThread`; the dispatcher blocks the bounty with:

```
spawn failed: no T3 project for board project 'scratch': set runners.t3.projects["scratch"], the slot's t3.project_id or runners.t3.defaults.project_id
```

## Tests (fake T3 WebSocket server, test/t3.test.js)

- `T3: board project mapping wins over slot and defaults; slot wins over defaults; defaults last`
  (mapping > slot > defaults; a mapping for another project falls through; empty mapping and empty slot id fall through to defaults)
- `T3: two board projects on one slot start threads in their own T3 projects` (`scratch` → `t3-scratch`, `second` → `t3-second`)
- `T3: no resolvable T3 project blocks with a clear reason and creates no thread`
  (blocked reason asserted verbatim; zero requests to the fake server, zero threads, no live worker, no attempt row)

## npm test

Full output: `docs/evidence/b12-t3-project-map-npm-test.txt`.

```
ℹ tests 101
ℹ pass 101
ℹ fail 0
EXIT=0
```

The `spawn failed ... read-only` / `no T3 project` stack traces in the log are the expected
fail-closed paths printed by the dispatcher's `console.error`.

## For the orchestrator (not applied)

The live board config was not touched. To fix the case in the brief, add to the live
board's `runners.t3` a `projects` entry mapping `bounty-board` to the T3 project id whose
workspace is /mnt/f/bounty-board (create it with `t3 project add` if none exists). Takes
effect on the next board start; this bounty never restarts a live board.
