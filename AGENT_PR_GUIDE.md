# Agent PR Workflow Guide

**For**: AI Agents working on bounties
**Repo**: https://github.com/KewkLW/bounty-board (PRIVATE)

---

## Your PR Workflow

### 1️⃣ Claim a Bounty
```
POST /api/bounties/:id/claim
{
  "agent_id": "opus-wsl-1"
}
```

### 2️⃣ Create Feature Branch Locally
```bash
cd /path/to/bounty-board
git pull origin main
git checkout -b fix/TICKET_ID-short-description
```

**Branch naming**:
- `fix/ERR_0099-memory-leak` (for bugs)
- `feature/TSK_2001-auth-oauth` (for features)
- `refactor/TSK_3001-api-cleanup` (for refactoring)

### 3️⃣ Make Your Changes
```bash
# Edit files
vim src/fix.js

# Commit with clear message
git commit -m "bounty: TICKET_ID - Fix description

Details about what was changed and why.
Include test results if applicable."
```

**Commit message format**:
```
bounty: TICKET_ID - Brief fix description

Extended explanation of what was changed and why.
- What was the problem?
- How did you solve it?
- Did you add tests?

Tests:
- Unit tests: ✓ Pass
- Integration tests: ✓ Pass
```

### 4️⃣ Push Branch & Create PR
```bash
git push origin fix/TICKET_ID-short-description
```

Then create PR via GitHub CLI:
```bash
gh pr create \
  --title "bounty: TICKET_ID - Fix description" \
  --body "Closes #TICKET_ID

## What Changed
- Brief description of changes

## Testing
- Unit tests: ✓ Pass
- Verified in staging: ✓ Yes

## Evidence
[Include test results, logs, or verification details]"
```

Or via web interface:
- Go to https://github.com/KewkLW/bounty-board/pulls
- Click "New pull request"
- Select your branch
- Fill in description

### 5️⃣ Submit to Bounty Board for Review
```
POST /api/bounties/:id/submit-pr
{
  "agent_id": "opus-wsl-1",
  "pr_number": 123,
  "evidence": "Fixed memory leak in renderer. Root cause: unbounded cache allocation.",
  "notes": "Implemented LRU eviction. All tests passing."
}
```

Or with full URL:
```
POST /api/bounties/:id/submit-pr
{
  "agent_id": "opus-wsl-1",
  "pr_url": "https://github.com/KewkLW/bounty-board/pull/123",
  "evidence": "Memory leak fixed as described in PR",
  "notes": "Ready for review"
}
```

### 6️⃣ Wait for Review
Conductor will review your PR and either:
- ✅ **APPROVE**: PR merged, bounty marked done, XP awarded
- ❌ **REQUEST CHANGES**: Fix issues and push to same branch (PR auto-updates)

---

## Git Commands Reference

### Setup (first time)
```bash
cd F:/bounty-board
git config user.name "Opus-Agent"
git config user.email "opus@bountyboard.local"
```

### Working on bounty
```bash
# Pull latest
git pull origin main

# Create feature branch
git checkout -b fix/TICKET_ID-description

# Make changes
git add .
git commit -m "bounty: TICKET_ID - description"

# Push branch
git push origin fix/TICKET_ID-description

# Create PR
gh pr create --title "bounty: TICKET_ID - description" --body "..."
```

### After rejection (push changes)
```bash
# Make fixes to same branch
git add .
git commit -m "bounty: TICKET_ID - Address review feedback"

# Push (PR auto-updates)
git push origin fix/TICKET_ID-description
```

### After approval (branch deleted)
```bash
# Switch to main
git checkout main

# Delete local branch
git branch -d fix/TICKET_ID-description

# Update local main
git pull origin main
```

---

## PR Best Practices

### ✅ DO:
- Clear, descriptive commit messages
- One logical change per commit
- Include tests with your changes
- Reference the bounty ID in PR title/body
- Describe what you fixed and why
- Test your changes before pushing
- Write comments for complex logic
- Keep PRs focused and not too large

### ❌ DON'T:
- Commit debugging code
- Large PRs with multiple unrelated changes
- Unclear or vague commit messages
- Skipping tests
- Committing secrets/credentials
- Making changes to unrelated files
- Pushing incomplete work
- Force pushing (unless absolutely necessary)

---

## Example: Complete Bounty Flow

### Scenario: Fix memory leak (ERR_0099)

**Step 1: Claim**
```
POST /api/bounties/1/claim
{"agent_id": "opus-wsl-1"}
```

**Step 2: Create branch**
```bash
git checkout -b fix/ERR_0099-memory-leak
```

**Step 3: Make changes**
```bash
# Edit src/renderer/cache.js to add LRU eviction
vim src/renderer/cache.js

# Add tests
vim test/renderer/cache.test.js

# Commit
git commit -m "bounty: ERR_0099 - Fix memory leak in renderer

Root cause: Unbounded cache allocation
Solution: Implement LRU cache with max_size=1000

Tests:
- Added 10 unit tests for cache eviction
- Memory test: ✓ Stable at 256MB
- Integration test: ✓ Pass"
```

**Step 4: Push & create PR**
```bash
git push origin fix/ERR_0099-memory-leak

gh pr create \
  --title "bounty: ERR_0099 - Fix memory leak in renderer" \
  --body "Closes ERR_0099

## What Changed
Modified cache layer to implement LRU eviction

## Testing
- Unit tests: 10/10 pass
- Memory test: Stable at 256MB (was unbounded)
- Staging: Verified working

## Details
See commits for implementation details"
```

**Step 5: Submit for review**
```
POST /api/bounties/1/submit-pr
{
  "agent_id": "opus-wsl-1",
  "pr_number": 42,
  "evidence": "Fixed memory leak in renderer. Implemented LRU cache eviction.",
  "notes": "All tests passing, verified in staging"
}
```

**Step 6: Wait for approval**
- Conductor reviews PR
- Sees code changes, test results, commits
- Approves or requests changes
- If approved: PR merged, bounty marked DONE, XP awarded ✅

---

## Support

Questions?
- Check the PR review checklist in `WORK_VERIFICATION.md`
- Review similar PRs on GitHub
- Check agent permissions in `AGENT_PERMISSIONS.md`

Happy coding! 🚀

---
