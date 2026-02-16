# GitHub Setup for Bounty Board

## Step 1: Create Private Repo on GitHub

1. Go to https://github.com/new
2. **Repository name**: `bounty-board` (or your preferred name)
3. **Description**: "Wasteland Bounty Board - AI agent task orchestration system"
4. **Private**: ✓ SELECT THIS (important!)
5. **Initialize repository**: Leave unchecked (we have existing code)
6. Click "Create repository"

---

## Step 2: You'll See Instructions Like This

```
Quick setup — if you've done this kind of thing before

…or push an existing repository from the command line

git remote add origin https://github.com/YOUR_USERNAME/bounty-board.git
git branch -M main
git push -u origin main
```

---

## Step 3: Configure Local Git & Push

Run these commands in PowerShell (from `F:/bounty-board`):

```powershell
cd F:\bounty-board

# Add remote (replace YOUR_USERNAME)
git remote add origin https://github.com/YOUR_USERNAME/bounty-board.git

# Rename master to main
git branch -M main

# Push to GitHub
git push -u origin main
```

---

## Step 4: Verify

Go to your GitHub repo URL:
```
https://github.com/YOUR_USERNAME/bounty-board
```

You should see:
- ✓ All source files
- ✓ `.gitignore` configured
- ✓ Commit history
- ✓ **PRIVATE** badge

---

## Step 5: Generate Personal Access Token (for agents)

For agents to push branches and create PRs, they'll need auth:

1. Go to https://github.com/settings/tokens
2. Click "Generate new token"
3. Name: `bounty-board-agents`
4. Scopes:
   - ✓ `repo` (full control of repos)
   - ✓ `workflow` (GitHub Actions)
5. Copy token, save it securely

---

## Step 6: Tell Me the Details

Once you've created the repo on GitHub, provide:

```
Repository URL: https://github.com/YOUR_USERNAME/bounty-board
Personal Access Token: (your token here - I won't save it, just need for agents)
```

Then I'll:
1. ✓ Push the local code to GitHub
2. ✓ Configure agents to use GitHub for PRs
3. ✓ Set up PR creation workflow
4. ✓ Update server to track PR links

---

## Security Notes

- Keep the Personal Access Token **SECRET**
- Only share it with me temporarily for setup
- Can revoke anytime if compromised
- Set token expiration (e.g., 90 days)
- Consider using GitHub Deploy Keys for read-only access if preferred

---
