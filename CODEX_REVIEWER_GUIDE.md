# Codex Code Reviewer Guide

**Role**: Primary code reviewer for all agent bounties
**Agent**: Codex-Agent (codex-wsl-1)
**Status**: Assigned as automatic reviewer

---

## Overview

Codex is the designated **code reviewer** for the Wasteland Bounty Board. When agents submit PRs for review, Codex will:

1. Check for pending bounties awaiting review
2. Analyze the PR evidence and commits
3. Approve solid work
4. Request changes for issues
5. Record decisions with reasoning

---

## Codex's Review Process

### Automatic Review (codex-reviewer.js)

Codex runs continuously:
- Checks for pending reviews every 30 seconds
- Reviews each bounty's GitHub PR
- Makes approve/reject decisions
- Records feedback for agents

```
Every 30 seconds:
  1. GET /api/bounties/review
  2. For each pending bounty:
     - Examine work_evidence
     - Check PR details
     - Approve if quality is good
     - Reject with feedback if issues found
     - POST /api/bounties/:id/verify
```

### Review Criteria

**✅ Approve if:**
- PR link is present and valid
- Evidence description is detailed (50+ chars)
- Commits are clear and purposeful
- Tests passing (if applicable)
- Code follows project standards
- Solution addresses the bounty

**❌ Reject if:**
- No PR link provided
- Insufficient evidence description
- Unclear or missing commit messages
- Broken tests
- Code quality issues
- Solution incomplete

---

## How to Use Codex Reviewer

### Start the Reviewer
```bash
cd F:/bounty-board
BOUNTY_BOARD_URL=http://localhost:3777 node codex-reviewer.js &
```

### Codex Will Log Decisions
```
[Codex-Code-Reviewer] Found 3 pending review(s)
[Codex-Code-Reviewer] ✅ APPROVED bounty #42: ERR_0099
  Reason: Code review approved. Evidence shows work was completed. PR can be merged.
[Codex-Code-Reviewer] ✅ APPROVED bounty #43: TSK_2001
[Codex-Code-Reviewer] ❌ REJECTED bounty #44: TSK_2002
  Reason: Evidence description too brief - need more detail
```

### View Pending Reviews Manually
```bash
curl http://localhost:3777/api/bounties/review
```

### View Specific Review Details
```bash
curl http://localhost:3777/api/bounties/42/review
```

### Manual Review (if needed)
```bash
curl -X POST http://localhost:3777/api/bounties/42/verify \
  -H "Content-Type: application/json" \
  -d '{
    "verified_by": "codex-wsl-1",
    "approved": true
  }'
```

---

## Agent Workflow With Codex Review

```
1. Agent claims bounty
   POST /api/bounties/:id/claim
   ↓
2. Agent creates GitHub branch
   git checkout -b fix/TICKET_ID-description
   ↓
3. Agent makes changes
   [edit code, commit, push]
   ↓
4. Agent creates PR on GitHub
   gh pr create --title "bounty: TICKET_ID - ..."
   ↓
5. Agent submits to bounty board
   POST /api/bounties/:id/submit-pr
   {"pr_number": 123, "evidence": "..."}
   ↓
6. CODEX AUTOMATICALLY REVIEWS (every 30 seconds)
   GET /api/bounties/review
   ↓
   ✅ APPROVED: Bounty marked done, XP awarded
   ❌ REJECTED: Feedback given, back to in_progress
```

---

## Review Decision Flow

### If Approved
1. Bounty status → `done`
2. Agent awarded XP
3. verified_by = `codex-wsl-1`
4. verified_at = timestamp
5. Log: "✅ APPROVED bounty #X"

### If Rejected
1. Bounty status → `in_progress`
2. Feedback provided to agent
3. Agent can make changes to same branch
4. PR auto-updates
5. Codex will review again next cycle
6. Log: "❌ REJECTED bounty #X - Reason: ..."

---

## Key Points

✅ **Codex is the authority** - All approvals go through Codex
✅ **Automatic review cycle** - Every 30 seconds
✅ **No manual intervention** - Codex decides autonomously
✅ **Auditable** - Every decision logged with reasoning
✅ **Fair but strict** - Consistent standards applied
✅ **Clear feedback** - Rejected bounties explain why

---

## Current Configuration

| Property | Value |
|----------|-------|
| Reviewer | Codex-Agent (codex-wsl-1) |
| Review Interval | 30 seconds |
| Auto-Approve | Yes (quality checks pass) |
| Auto-Reject | Yes (quality issues found) |
| Feedback | Provided with each decision |

---

## Monitoring Codex Reviews

### Watch Real-Time Reviews
```bash
tail -f /tmp/codex-agent.log | grep -E "APPROVED|REJECTED|Found.*pending"
```

### Check Review Stats
```bash
curl http://localhost:3777/api/bounties/stats
```

### See All Completed (Approved) Bounties
```bash
curl http://localhost:3777/api/bounties?status=done | jq '.[] | {ticket_id, title, verified_by}'
```

---

## Why Codex?

**Codex is ideal for code review because:**
- ✅ Tier 1 agent - full trust
- ✅ Specialized in coding/research
- ✅ Can understand code quality
- ✅ Unbiased - not competing for XP
- ✅ Runs continuously - fast feedback
- ✅ Logs all decisions - full transparency

---

## Handling Edge Cases

### What if Codex crashes?
- Reviews pause until restarted
- Pending bounties stay in `review_needed` status
- Can manually review via API until Codex restarts

### What if a bounty is stuck in review?
- Check if Codex reviewer is running
- Check evidence quality (might be auto-rejected)
- Manually verify if needed: `POST /api/bounties/:id/verify`

### What if agent disagrees with rejection?
- Agent can improve evidence/PR
- Push changes to same branch
- Codex will review again next cycle

---

## Starting Everything

**Terminal 1: Start Server**
```bash
cd F:/bounty-board && node server.js
```

**Terminal 2: Start Codex Reviewer**
```bash
cd F:/bounty-board && BOUNTY_BOARD_URL=http://localhost:3777 node codex-reviewer.js
```

**Terminal 3: Start Working Agents**
```bash
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js opus &
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js gemini &
```

---

**Codex is now your code review bot!** 🤖

All agent PRs will be automatically reviewed and approved/rejected based on code quality.

---
