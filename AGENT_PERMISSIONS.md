# Agent Permissions & Trust Levels

**Last Updated**: February 16, 2026
**Purpose**: Control which agents can work on which tasks

---

## Agent Trust Tiers

### 🟢 TIER 1: Full Trust (Code + Tasks)
- **Opus** ✓ Allowed
  - Can claim ANY bounty
  - Can code, refactor, architecture
  - No supervision needed
  - Verification: Standard review

- **Codex** ✓ Allowed
  - Can claim ANY bounty
  - Specialized in coding/research
  - No supervision needed
  - Verification: Standard review

---

### 🟡 TIER 2: Limited Trust (Requires Monitoring)
- **Gemini** ⚠️ Conditional
  - CAN code but needs close monitoring
  - Assign to: Lower-risk features, non-critical bugs
  - AVOID: Security-critical, system-critical work
  - Verification: **STRICT review required** (extra scrutiny)
  - **Flag for review**: All code changes must be checked carefully
  - Monitor for: Logic errors, edge cases, security issues

---

### 🔴 TIER 3: NO Coding (Tasks/Research Only)
- **Haiku** ❌ NEVER code
  - Can claim: Documentation, research, analysis tasks
  - CANNOT claim: Any coding bounties
  - Use for: Quick research, summaries, non-code work
  - Examples: "Summarize API docs", "Research performance patterns"

- **Sonnet** ⏸️ SUSPENDED for now
  - Currently not deployed in test phase
  - Was: OK for boilerplate/scaffolding
  - Can re-enable later if needed for high-volume low-priority work

---

## Task Assignment Rules

### Bounty Type → Allowed Agents

**Critical Bugs (S-Tier)**:
- ✓ Opus, Codex ONLY

**Important Features (A-Tier)**:
- ✓ Opus, Codex
- ⚠️ Gemini (with monitoring)

**Normal Tasks (B-Tier)**:
- ✓ Opus, Codex
- ⚠️ Gemini (with monitoring)
- ✓ Haiku (if non-code)

**Routine Work (C-Tier)**:
- ✓ Opus, Codex
- ⚠️ Gemini (with monitoring)
- ✓ Haiku (if non-code)

---

## Monitoring Gemini

### Review Requirements
When Gemini's PR comes in:
- [ ] Read ALL code changes (not just scan)
- [ ] Check for logic errors
- [ ] Verify error handling
- [ ] Check security implications
- [ ] Run tests thoroughly
- [ ] Request changes if ANY concern

### Red Flags to Watch
- Incomplete error handling
- Unsafe type conversions
- Missing input validation
- Performance issues
- Unclear variable names
- Missing comments on complex logic

### Approval Criteria for Gemini
- Code is clear and understandable
- All tests pass
- No security issues
- Performance acceptable
- Error handling complete
- Logic is sound

---

## Implementation in Bounty System

### Database Update Needed
```sql
ALTER TABLE agents ADD COLUMN trust_level TEXT DEFAULT 'tier2'
  CHECK(trust_level IN ('tier1', 'tier2', 'tier3'));

ALTER TABLE agents ADD COLUMN can_code BOOLEAN DEFAULT 0;
```

### Seed Data
```javascript
agents = [
  { id: 'opus-wsl-1', name: 'Opus-Conductor', trust_level: 'tier1', can_code: 1 },
  { id: 'codex-wsl-1', name: 'Codex-Agent', trust_level: 'tier1', can_code: 1 },
  { id: 'gemini-wsl-1', name: 'Gemini-Agent', trust_level: 'tier2', can_code: 1, needs_review: 1 },
  { id: 'haiku-wsl-1', name: 'Haiku-Agent', trust_level: 'tier3', can_code: 0 },
  { id: 'sonnet-wsl-1', name: 'Sonnet-Agent', trust_level: 'tier1', can_code: 1, active: 0 }, // Suspended
];
```

### API Validation

```javascript
// POST /api/bounties/:id/claim
if (bounty.type === 'bug' && bounty.is_code_change) {
  const agent = getAgent(agent_id);

  if (agent.trust_level === 'tier3' || !agent.can_code) {
    return 403 { error: 'Agent not permitted to code' };
  }

  if (agent.trust_level === 'tier2') {
    // Flag for strict review
    markForStrictReview(bounty.id);
  }
}
```

---

## Current Agent Status

| Agent | Trust | Can Code | Status |
|-------|-------|----------|--------|
| Opus | Tier 1 ✓ | Yes | ✓ Active |
| Codex | Tier 1 ✓ | Yes | ✓ Active |
| Gemini | Tier 2 ⚠️ | Yes* | ✓ Active (MONITOR) |
| Haiku | Tier 3 ✗ | No | ⏳ Research only |
| Sonnet | Tier 1 ✓ | Yes | ⏸️ Suspended |

---

## Spawn Instructions

### For Testing
```bash
# DO spawn:
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js opus &
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js codex &
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js gemini &

# DON'T spawn:
# - haiku (research tasks only)
# - sonnet (suspended for now)
```

### For Production
```bash
# When ready:
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js opus &
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js codex &
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js gemini &
BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js haiku &  # Research tasks
# Keep sonnet suspended unless high volume
```

---

## Reviewing Gemini's Work

### PR Review Checklist for Gemini
```markdown
## Gemini Code Review (STRICT MODE)

- [ ] Code is readable and maintainable
- [ ] No logic errors found
- [ ] Error handling is comprehensive
- [ ] Input validation is present
- [ ] No security vulnerabilities
- [ ] Performance is acceptable
- [ ] Tests pass (100% pass rate required)
- [ ] No hardcoded values
- [ ] Comments explain complex logic
- [ ] Variable names are clear

**Gemini-Specific Checks:**
- [ ] Edge cases handled
- [ ] Null checks where needed
- [ ] Type safety verified
- [ ] No silent failures
- [ ] Logging is adequate

### Decision
- [ ] APPROVE - High confidence
- [ ] REQUEST CHANGES - Issues found
- [ ] REJECT - Too many concerns
```

---

## Notes

- **Haiku**: Research/analysis agent. Great for summaries, documentation, quick info gathering.
- **Gemini**: Capable but newer. Watch carefully until trusted.
- **Sonnet**: Good backup if volume gets high. Can re-enable anytime.
- **Opus/Codex**: Trusted workhorse agents.

---
