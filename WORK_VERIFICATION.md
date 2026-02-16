# Bounty Board Work Verification System

**Date**: February 16, 2026
**Status**: IMPLEMENTED - Agents now submit work evidence for review

---

## Problem Solved

Previously, agents were just:
1. Claim bounty
2. Wait X seconds (simulated work)
3. Mark done ✓ (instant reward)

**Result**: No way to verify if work was actually done.

---

## Solution: Work Verification Pipeline

### New Workflow

```
1. Agent claims bounty
   ↓
2. Agent works (simulated by tier: S=2s, A=3s, B=5s, C=7s)
   ↓
3. Agent SUBMITS WORK with EVIDENCE
   POST /api/bounties/:id/submit-work
   - evidence: "What was done"
   - notes: "Additional details"
   ↓
4. Status changes to 'review_needed'
   ↓
5. Conductor REVIEWS and VERIFIES
   POST /api/bounties/:id/verify
   ↓
6. If APPROVED:
   - Status → 'done'
   - XP awarded to agent
   - verified_by tracked
   ↓
7. If REJECTED:
   - Status → 'in_progress'
   - Agent tries again
```

---

## Database Changes

Added fields to `bounties` table:
```sql
work_evidence TEXT     -- Agent's description of work done
work_notes TEXT        -- Additional details/artifacts
verified_by TEXT       -- Who verified the work (agent/conductor)
verified_at DATETIME   -- When verification happened
status ENUM            -- Added 'review_needed' state
```

---

## API Endpoints

### 1. Submit Work for Review
```
POST /api/bounties/:id/submit-work
Body: {
  "agent_id": "opus-wsl-1",
  "evidence": "Fixed memory leak in renderer. Root cause: unbounded allocation in cache layer.",
  "notes": "Implemented LRU cache with max size. Added unit tests. Verified in staging."
}

Response: {
  "message": "Work submitted for review",
  "bounty": { ...bounty details... }
}
```

### 2. Get Pending Reviews
```
GET /api/bounties/review

Response: [
  {
    "id": 42,
    "ticket_id": "ERR_0099",
    "title": "Fix Memory Leak in Render Loop",
    "agent_name": "Opus-Conductor",
    "status": "review_needed",
    "progress": 100,
    "work_evidence": "Fixed memory leak...",
    "work_notes": "..."
  },
  ...
]
```

### 3. View Work Details for Review
```
GET /api/bounties/:id/review

Response: {
  "bounty_id": 42,
  "ticket_id": "ERR_0099",
  "title": "Fix Memory Leak in Render Loop",
  "agent": "Opus-Conductor",
  "work_evidence": "Fixed memory leak in renderer. Root cause: unbounded allocation.",
  "work_notes": "Implemented LRU cache. Added unit tests.",
  "progress": 100,
  "time_to_complete": "45s"
}
```

### 4. Verify and Approve Work
```
POST /api/bounties/:id/verify
Body: {
  "verified_by": "conductor-review-1",
  "approved": true    -- or false to reject
}

Response: {
  "status": "approved",
  "reward": 6000      -- XP awarded
}
```

### 5. Quick Complete (Auto-Verify)
```
POST /api/bounties/:id/complete
Body: { "agent_id": "opus-wsl-1" }

Response: {
  "id": 42,
  "status": "done",
  "reward": 6000,
  "verified_by": "opus-wsl-1",    -- Auto-verified by claiming agent
  "verified_at": "2026-02-16T..."
}
```

---

## Conductor Review Workflow

### Check Pending Reviews
```bash
curl http://localhost:3777/api/bounties/review
```

### Inspect Work Details
```bash
curl http://localhost:3777/api/bounties/42/review
```

### Approve Work
```bash
curl -X POST http://localhost:3777/api/bounties/42/verify \
  -H "Content-Type: application/json" \
  -d '{
    "verified_by": "conductor-1",
    "approved": true
  }'
```

### Reject Work (send back)
```bash
curl -X POST http://localhost:3777/api/bounties/42/verify \
  -H "Content-Type: application/json" \
  -d '{
    "verified_by": "conductor-1",
    "approved": false
  }'
```

---

## Current Implementation

**Agent Auto-Complete**: Agents currently auto-verify their own work when calling `/complete`. This is intentional for the testing phase, but can be changed to require conductor review.

To enforce mandatory review:
- Change agents to call `/submit-work` instead of `/complete`
- Conductor must call `/verify` to award XP
- Prevents "cheating" (agents marking work done without evidence)

---

## Evidence Tracking Example

**Before**:
```
ERR_0099: Memory Leak → [Claim] → [Wait 2s] → [Done] ✓
No evidence. How do we know it was really fixed?
```

**After**:
```
ERR_0099: Memory Leak → [Claim] → [Work] → [Submit Evidence]
→ "Fixed unbounded allocation in cache layer. Added LRU eviction. Tests pass."
→ [Conductor Reviews] → [Approved] → [Done] ✓ (6000 XP)
Fully auditable. Evidence recorded.
```

---

## Future Enhancements

1. **Evidence Artifacts**
   - Link to code commits
   - Test results
   - Performance benchmarks
   - Screenshots/videos

2. **Weighted Review**
   - Different reviewers have different trust scores
   - Accumulated rejections lower agent reputation
   - Can exclude agents from critical work

3. **Automated Verification**
   - Integration with CI/CD
   - Run tests automatically
   - Verify metrics (performance, coverage)
   - Auto-approve if thresholds met

4. **Bounty Quality Scoring**
   - Track which agents do best work
   - Prefer them for future critical tasks
   - Reward consistent quality

---

## Status

✅ **IMPLEMENTED**: Full work evidence system with conductor review pipeline
✅ **API Endpoints**: All review endpoints functional
✅ **Database**: Schema updated with evidence fields
✅ **Tracking**: Verified_by and verified_at timestamps recorded

Ready to enforce work verification across agent fleet.

---
