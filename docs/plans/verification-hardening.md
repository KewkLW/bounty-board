# Verification hardening (2026-11-17)

Source: "How the Claude Code team thinks about verification" (claude.dev blog, 2026-11-16), checked
against what the board already did: the gates (branch, real diff, verify), a separate reviewer
against acceptance criteria with an evidence rule, attempt caps with escalation, and incidents.
This change closes the gaps the article points at. README sections: "One commit through every
gate", "Keep the checks out of reach of the change", "How the reviewer works".

## Done in this change

1. **One commit through every gate.** New columns `submitted_sha`, `verified_sha`, `reviewed_sha`.
   - Verify runs on the submitted sha. If a live worker moves its worktree during the run, that
     run is discarded and verify runs again in a detached worktree.
   - The reviewer diffs and checks out the verified sha.
   - If the branch moved after verify, the approval stands for the sha that was reviewed, and a
     FLAG event says to merge that sha.
   - The merge check keeps today's acceptance (ancestor, patch-equivalent, squash). Commits after
     the reviewed sha that reached main only raise a FLAG event.
   - A requeue clears all three shas. NULL rows (from before this change) fall back to the branch tip.
2. **Protected paths.** A per-project `protected_paths` glob list.
   - The default is `REVIEW.md`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`. `[]` turns it off.
   - Submit refuses a diff that touches one of them unless the bounty has `allow_protected`.
     Only the orchestrator can set that, at `add` or `edit`.
   - The reviewer reads `REVIEW.md` and `AGENTS.md` from main.
   - Tests that live in the branch are not covered. This is documented.
3. **Reviewer findings.** The strict-schema field `findings` holds tags of `important`, `nit` or
   `pre_existing`. Only `important` justifies a reject; `pre_existing` is noted but not held
   against the change.
4. **Verification stamp.** `bounty submit --evidence` stores the worker's QA evidence.
   `bounty trailer ID` prints `Bounty / Verified-by / Reviewed-by / QA-evidence` lines for the
   merge commit, so `git log --grep 'QA-evidence: none'` finds merges nobody checked in the real app.
5. **Worker prompt.** It adds:
   - QA in the real app, following the repo's `verify` skill if there is one;
   - the flaky-test rule: no skips, sleeps, timeout bumps or retries until green; fix the root
     cause, or delete the test with the reason written down;
   - never weaken a test;
   - no commits after submit;
   - the protected paths.
6. **A `verify` skill for this repo** (`.claude/skills/verify/SKILL.md`), to use as a template for others.

## Behaviour changes on every board after a restart

- Submit now refuses diffs that touch `REVIEW.md`, `AGENTS.md`, `CLAUDE.md` or `.claude/**`
  unless the bounty allows it. File bounties whose job is to change those with `--allow-protected`.
- The review is of the verified commit, not the branch tip. Merge the reviewed sha.

## Not done (later)

- **Reviewer recall eval.** Use reverts and later-found bugs as an answer key, and measure recall
  for raw findings, after verification, and final. `reviewed_sha` and the trailers make the data
  available.
- **A Stop hook that refuses a worker exit while unsubmitted.** Incidents already catch it, and a
  Stop hook in every worker risks loops.
- **Commit-gate modes (off/observe/enforce).** The submit gate is enforce mode. An observe mode
  for new protected-path rules could come later.
- **Property and differential tests in project repos.** For example round-tripping file formats,
  or comparing old and new implementations. File these as bounties on those boards.
