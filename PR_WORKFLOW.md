# Agent PR Review Workflow

**Purpose**: Verify that agents actually complete work by requiring code reviews through PRs

---

## Workflow Overview

```
┌─────────────────────────────────────────────────┐
│ 1. Agent Claims Bounty                          │
│    POST /api/bounties/:id/claim                 │
└────────────────┬────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────┐
│ 2. Agent Creates Feature Branch                 │
│    git checkout -b fix/TICKET_ID-description   │
└────────────────┬────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────┐
│ 3. Agent Makes Changes & Commits                │
│    git add . && git commit -m "bounty: fix..."  │
└────────────────┬────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────┐
│ 4. Agent Pushes Branch & Creates PR             │
│    git push origin fix/TICKET_ID-description   │
│    Create PR with evidence/description          │
└────────────────┬────────────────────────────────┘
                 ↓
┌─────────────────────────────────────────────────┐
│ 5. Conductor Reviews PR                         │
│    - Read code changes                          │
│    - Check commit messages                      │
│    - Verify quality                             │
│    - Run tests/verification                     │
└────────────────┬────────────────────────────────┘
                 ↓
         ┌───────┴───────┐
         ↓               ↓
    ✓ APPROVED      ✗ REJECTED
         │               │
         ↓               ↓
    Merge to main   Request changes
    Mark done       Back to in_progress
    Award XP        Agent continues
```

---

## Branching Strategy

### Branch Naming Convention
```
fix/TICKET_ID-short-description      # Bug fixes
feature/TICKET_ID-short-description  # Features
refactor/TICKET_ID-short-description # Refactoring
```

**Examples:**
- `fix/ERR_0099-memory-leak`
- `feature/TSK_2001-auth-oauth2`
- `refactor/TSK_3001-api-cleanup`

### Commit Message Format
```
bounty: TICKET_ID - brief description

Details about what was changed and why.
Include test results if applicable.
```

**Example:**
```
bounty: ERR_0099 - Fix memory leak in render loop

Root cause: Unbounded allocation in cache layer.
Solution: Implemented LRU cache with max_size=1000.

Changes:
- Modified renderer/cache.js to add eviction policy
- Added unit tests (coverage: 95%)
- Verified in staging: Memory stable at 256MB

Closes ERR_0099
```

---

## PR Template

When creating a PR, include:

```markdown
## Bounty
Closes #TICKET_ID

## What Changed
- Brief description of changes

## Why
Why was this work needed? Problem statement?

## Testing
- Unit tests: ✓ Pass (100 tests)
- Integration tests: ✓ Pass
- Manual verification: ✓ Tested in staging

## Evidence
Include screenshots, logs, or benchmark results.
```

---

## Review Checklist

Conductor should verify:

- [ ] **Code Quality**: Follows project standards
- [ ] **Commits**: Clear, descriptive commit messages
- [ ] **Tests**: Tests pass, good coverage
- [ ] **Documentation**: Updated docs if needed
- [ ] **No Breaking Changes**: Backward compatible
- [ ] **Security**: No vulnerabilities introduced
- [ ] **Performance**: No regressions
- [ ] **Addresses Issue**: Solves the bounty problem

---

## Merge & Completion

### Approved Workflow
```bash
# Conductor approves PR
→ Merge to main
→ DELETE feature branch
→ POST /api/bounties/:id/verify
  {
    "verified_by": "conductor-1",
    "approved": true,
    "pr_url": "https://..."
  }
→ Bounty marked DONE
→ Agent awarded XP
```

### Rejected Workflow
```bash
# Conductor requests changes
→ Comment on PR with feedback
→ POST /api/bounties/:id/verify
  {
    "verified_by": "conductor-1",
    "approved": false,
    "feedback": "Need to add error handling..."
  }
→ Bounty back to IN_PROGRESS
→ Agent makes changes
→ Pushes to same branch
→ PR auto-updates
→ Back to review
```

---

## Repository Setup

### Current Status
- ✓ Local git repo initialized at `F:/bounty-board`
- ✓ `.gitignore` configured
- ✓ Initial commit made
- ⏳ **WAITING**: Remote repository setup

### Next Steps

Choose one:

**Option A: GitHub (Recommended)**
```bash
# Create private repo on GitHub
# Then:
git remote add origin https://github.com/USERNAME/bounty-board.git
git branch -M main
git push -u origin main
```

**Option B: GitLab**
```bash
git remote add origin https://gitlab.com/USERNAME/bounty-board.git
git push -u origin main
```

**Option C: Local Git Server**
```bash
git remote add origin /shared/repos/bounty-board.git
git push -u origin main
```

**Option D: Gitea (Self-hosted)**
```bash
git remote add origin https://gitea.example.com/repos/bounty-board.git
git push -u origin main
```

---

## Current Repo Status

```
Repository: F:/bounty-board
Status: Initialized with .git
Commits: 3 (latest: Initial commit)
Remotes: None configured yet
Branches: master/main
.gitignore: ✓ Configured
```

---

## How This Solves Verification

**Before** (Just marking done):
```
Agent: "I completed the bounty"
Conductor: "OK, marked done. Here's your XP."
Reality: ??? (no evidence)
```

**After** (PR-based):
```
Agent: Creates branch → Makes changes → Creates PR
Conductor: Reviews code → Sees exact changes → Validates solution → Approves/Rejects
Reality: Full audit trail with diffs, commits, tests, reviews
```

**Result**: **Verifiable, trustworthy work completion** 🎯

---
