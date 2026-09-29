// The reviewer: Codex (`codex exec`, read-only sandbox) reads the REAL diff of the submitted
// branch and the acceptance criteria and returns approve/reject with per-criterion evidence.
// The old reviewer approved any evidence string over 50 characters; this one never sees the
// worker's claims, only the diff and the repository.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { now, addEvent } = require('./db');
const gitx = require('./git');
const { parseUsage } = require('./dispatcher');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'notes', 'criteria'],
  properties: {
    verdict: { type: 'string', enum: ['approve', 'reject'] },
    notes: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'met', 'evidence'],
        properties: { index: { type: 'integer' }, met: { type: 'boolean' }, evidence: { type: 'string' } },
      },
    },
  },
};

function reviewPrompt(b, p, diff, stat, truncated) {
  const crit = (b.criteria || []).map((c, i) => `${i + 1}. ${c.text}`).join('\n') || '(none written: judge against the description)';
  return `You are the code reviewer for the Bounty Board. Decide whether this branch really does what the bounty asks.
Judge ONLY from the diff below and the repository (your cwd is the worker's worktree on branch \`${b.branch}\`; main is \`${p.main_branch}\`; you may read files and run read-only commands like \`git diff ${p.main_branch}...${b.branch}\`, \`git log\`, \`git show\`). Do not trust commit messages or notes as evidence: check the code.

Reject if any acceptance criterion is not met by the actual changes, if the change is fake (only notes/logs/comments, stubs that don't do the work, tests that assert nothing or were weakened), or if it clearly breaks something. Approve only when every criterion is met with concrete evidence (file:line or test name).

# Bounty #${b.id} (${b.type}, tier ${b.tier}): ${b.title}
## Description
${b.description || '(none)'}
## Acceptance criteria
${crit}

# Verify command result
\`${p.verify_cmd || '(none configured)'}\` -> ${b.ci_status || 'n/a'}

# Diff ${p.main_branch}...${b.branch}${truncated ? ' (TRUNCATED; read the rest from the repository)' : ''}
${stat}

\`\`\`diff
${diff}
\`\`\`

Reply with JSON only: {"verdict": "approve"|"reject", "notes": "<what is good / what the next worker must fix>", "criteria": [{"index": <1-based>, "met": true|false, "evidence": "<file:line or test that proves it, or what is missing>"}]} with one entry per acceptance criterion.`;
}

function extractJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*"verdict"[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

class Reviewer {
  constructor(board) {
    this.board = board;
    this.cfg = board.cfg;
    this.db = board.db;
    this.running = 0;
    this.timer = null;
    board.reviewer = this;
  }

  start() {
    // Reviews interrupted by a restart go back to the queue.
    this.db.prepare("UPDATE bounties SET review_state = 'pending' WHERE status = 'review' AND review_state = 'running'").run();
    this.timer = setInterval(() => this.pump(), 15000);
    this.timer.unref?.();
    setImmediate(() => this.pump());
  }
  stop() { clearInterval(this.timer); }

  pump() {
    if (this.running >= 1) return;
    const b = this.db.prepare(`SELECT id FROM bounties WHERE status = 'review' AND (review_state IS NULL OR review_state IN ('pending','error'))
      AND review_errors < ? ORDER BY review_at LIMIT 1`).get(this.cfg.reviewer.max_errors);
    if (!b) return;
    this.running++;
    this.review(b.id).catch(e => {
      this.db.prepare("UPDATE bounties SET review_state = 'error', review_errors = review_errors + 1 WHERE id = ?").run(b.id);
      addEvent(this.db, { bounty_id: b.id, actor: 'reviewer', kind: 'review', note: `reviewer error: ${e.message}` });
      this.board.changed('bounty', { id: b.id });
    }).finally(() => { this.running--; setImmediate(() => this.pump()); });
  }

  async review(id) {
    const b = this.board.need(id);
    const p = this.board.project(b.project_id);
    this.db.prepare("UPDATE bounties SET review_state = 'running' WHERE id = ?").run(id);
    this.board.changed('bounty', { id });
    const max = this.cfg.reviewer.max_diff_chars;
    let diff = gitx.git(p.repo, ['diff', `${p.main_branch}...${b.branch}`]);
    const truncated = diff.length > max;
    if (truncated) diff = diff.slice(0, max);
    const stat = gitx.diffStat(p.repo, p.main_branch, b.branch);
    const prompt = reviewPrompt(b, p, diff, stat, truncated);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join(this.cfg.logs_dir, `bounty-${id}-review-${stamp}.log`);
    const promptPath = logPath.replace(/\.log$/, '.prompt.md');
    const outPath = logPath.replace(/\.log$/, '.verdict.json');
    const schemaPath = path.join(this.cfg.logs_dir, 'review-schema.json');
    fs.writeFileSync(promptPath, prompt);
    fs.writeFileSync(schemaPath, JSON.stringify(SCHEMA));
    const cwd = b.worktree && fs.existsSync(b.worktree) ? b.worktree : p.repo;
    const rc = this.cfg.reviewer;
    let bin, args, runner = rc.runner;
    if (runner === 'command') { [bin, ...args] = rc.cmd; }
    else {
      bin = (this.cfg.runners.codex || {}).bin || 'codex';
      args = ['exec', '--json', '-s', 'read-only', '-C', cwd, '--output-schema', schemaPath, '-o', outPath];
      if (rc.model) args.push('-m', rc.model);
      if (rc.effort) args.push('-c', `model_reasoning_effort="${rc.effort}"`);
      args.push('-');
    }
    const attempt = this.db.prepare(`INSERT INTO attempts (bounty_id, slot, runner, model, pid, started_at, log_path, prompt_path, kind)
      VALUES (?, 'reviewer', ?, ?, NULL, ?, ?, ?, 'review')`).run(id, runner, rc.model || null, now(), logPath, promptPath);
    const attemptId = Number(attempt.lastInsertRowid);
    addEvent(this.db, { bounty_id: id, actor: 'reviewer', kind: 'review', note: `review started (${runner}); diff ${diff.length} chars${truncated ? ' truncated' : ''}; log ${logPath}` });

    const code = await new Promise(resolve => {
      const logFd = fs.openSync(logPath, 'a');
      const inFd = fs.openSync(promptPath, 'r');
      const env = { ...process.env, BOUNTY_REVIEW_OUT: outPath, BOUNTY_REPO: p.repo, BOUNTY_BRANCH: b.branch, BOUNTY_MAIN: p.main_branch };
      delete env.CLAUDECODE;
      const c = spawn(bin, args, { cwd, env, stdio: [inFd, logFd, logFd], detached: true });
      fs.closeSync(inFd); fs.closeSync(logFd);
      this.db.prepare('UPDATE attempts SET pid = ? WHERE id = ?').run(c.pid || null, attemptId);
      const t = setTimeout(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch {} }, rc.timeout_minutes * 60000);
      c.on('error', () => { clearTimeout(t); resolve(-1); });
      c.on('close', code => { clearTimeout(t); resolve(code); });
    });
    const usage = parseUsage(logPath, runner === 'codex' ? 'codex' : 'command');
    let text = '';
    try { text = fs.readFileSync(outPath, 'utf8'); } catch {}
    if (!text && runner === 'command') text = gitx.tailFile(logPath, 200000);
    const v = extractJson(text);
    this.db.prepare('UPDATE attempts SET ended_at = ?, exit_code = ?, cost_usd = ?, tokens_in = ?, tokens_out = ?, cache_read = ?, outcome = ? WHERE id = ?')
      .run(now(), code, usage.cost_usd, usage.tokens_in, usage.tokens_out, usage.cache_read, v ? v.verdict : 'error', attemptId);
    this.db.prepare('UPDATE bounties SET cost_usd = cost_usd + ?, tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?')
      .run(usage.cost_usd || 0, usage.tokens_in, usage.tokens_out, id);
    if (!v || !['approve', 'reject'].includes(v.verdict)) throw new Error(`no verdict from the reviewer (exit ${code}); log ${logPath}`);

    // Evidence rule: an approval must cover every criterion with met=true.
    const n = (b.criteria || []).length;
    const crit = Array.isArray(v.criteria) ? v.criteria : [];
    let verdict = v.verdict;
    const unmet = crit.filter(c => !c.met);
    const covered = new Set(crit.filter(c => c.met).map(c => Number(c.index)));
    const missing = [];
    for (let i = 1; i <= n; i++) if (!covered.has(i)) missing.push(i);
    let notes = String(v.notes || '').trim();
    if (verdict === 'approve' && (unmet.length || missing.length)) {
      verdict = 'reject';
      notes = `[board] approval overruled: criteria ${missing.join(', ')} not shown as met with evidence.\n` + notes;
    }
    const critText = crit.map(c => `  ${c.met ? '[x]' : '[ ]'} #${c.index}: ${c.evidence}`).join('\n');
    const full = `${verdict.toUpperCase()} (reviewer ${runner})\n${notes}${critText ? '\n' + critText : ''}`;
    // Mark the criteria the reviewer confirmed.
    if (verdict === 'approve' && n) {
      const cr = b.criteria.map((c, i) => ({ ...c, done: true, note: (crit.find(x => Number(x.index) === i + 1) || {}).evidence || c.note }));
      this.db.prepare('UPDATE bounties SET criteria = ? WHERE id = ?').run(JSON.stringify(cr), id);
    }
    addEvent(this.db, { bounty_id: id, actor: 'reviewer', kind: 'review', note: full.slice(0, 6000) });
    this.board.applyReview(id, { verdict, notes: full });
    return verdict;
  }
}

module.exports = { Reviewer, reviewPrompt, SCHEMA };
