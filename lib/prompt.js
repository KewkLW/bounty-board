// The worker prompt: the bounty, its criteria, what earlier attempts left behind, the project
// rules, and the mandatory CLI protocol.
const fs = require('fs');
const path = require('path');

function earlierNotes(board, b) {
  const evs = board.db.prepare(`SELECT * FROM events WHERE bounty_id = ? AND (
      (kind = 'status' AND to_status IN ('ready','blocked','failed') AND note IS NOT NULL AND note NOT IN ('created'))
      OR kind IN ('verify','review','exit'))
    ORDER BY id DESC LIMIT 12`).all(b.id).reverse();
  const lines = evs.map(e => `- ${e.at} [${e.kind}${e.to_status ? ' -> ' + e.to_status : ''}] ${String(e.note || '').slice(0, 1200)}`);
  if (b.review_notes) lines.push(`- latest review notes:\n${indent(b.review_notes, '    ')}`);
  return lines.join('\n');
}

function indent(s, pad) { return String(s).split('\n').map(l => pad + l).join('\n'); }

function ruleDocs(project, worktree) {
  const out = [];
  for (const f of ['AGENTS.md', 'CLAUDE.md']) {
    const p = path.join(worktree, f);
    if (fs.existsSync(p)) out.push(p);
  }
  for (const r of project.rules || []) out.push(r);
  return out;
}

function workerPrompt(board, b, slot, { worktree, branch }) {
  const p = board.project(b.project_id);
  const cfg = board.cfg;
  const cli = path.join(cfg.bin_dir, 'bounty');
  const crit = (b.criteria || []).map((c, i) => `${i + 1}. [${c.done ? 'x' : ' '}] ${c.text}`).join('\n') || '(none written; the description is the spec)';
  const notes = earlierNotes(board, b);
  const rules = ruleDocs(p, worktree);
  const parent = b.parent_id ? board.raw(b.parent_id) : null;
  return `You are ${slot.id}, a worker spawned by the Bounty Board for bounty #${b.id} (${b.ticket_id}). One fresh agent per bounty: when this bounty is submitted or blocked, your job is over and you exit.

# The bounty
- Title: ${b.title}
- Type ${b.type}, tier ${b.tier}, priority ${b.priority}, project ${p.id}${parent ? `, split from #${parent.id} "${parent.title}"` : ''}
- Attempt ${b.attempts} (earlier attempts: ${Math.max(0, b.attempts - 1)})

## Description / brief
${b.description || '(no description)'}

## Acceptance criteria (the reviewer checks each one against your diff)
${crit}
${notes ? `\n## Notes from earlier attempts (fix what they point out)\n${notes}\n` : ''}
# Where you work
- Worktree: ${worktree} (your cwd). Branch: \`${branch}\`. Commit your work on this branch.
- Main branch: \`${p.main_branch}\` in ${p.repo}. Never merge, never push to ${p.main_branch}, never rebase other branches.
- Verify command (run it yourself before you submit): \`${p.verify_cmd || '(none configured)'}\`
${rules.length ? `\n# Project rules: read these first and follow them\n${rules.map(r => `- ${r}`).join('\n')}\n` : ''}
# Mandatory protocol: the Bounty CLI
The CLI is \`${cli}\` (also \`bounty\` on PATH). BOUNTY_ID=${b.id} and BOUNTY_SLOT=${slot.id} are already set in your environment, so the commands below act on this bounty.
1. \`bounty start\` FIRST, before anything else.
2. \`bounty progress "<what you just did / found>"\` after every meaningful step, at least every 15 minutes. It is your heartbeat: ${cfg.watchdog.stall_minutes} minutes of silence gets you killed and the bounty blocked. When an acceptance criterion is met, add \`--check <n>\` with the evidence in the note.
3. \`bounty split "<title>" --desc "<what and why>"\` for any gap or extra work you find outside this bounty. Do not do that work here.
4. \`bounty block "<reason>"\` if you are stuck (missing information, a broken environment, a decision only a human can make), then exit.
5. Before any rendered/GPU run (game clients, editors, seat captures, frame timing): \`bounty lease gpu\` (waits until it is free), and \`bounty release gpu\` right after.
6. Finish: commit everything on \`${branch}\`, run the verify command, then \`bounty submit\`. Submit refuses a missing branch, an empty diff, or a diff that only touches notes/logs; then the verify command runs on your branch, and a reviewer reads the real diff against the acceptance criteria. If submit is refused or verify fails, fix it and submit again. Once submit is accepted, stop and exit.

You cannot mark anything approved or done; the board does that only after review and after the orchestrator merges your commits into ${p.main_branch}. Don't touch other worktrees, and don't stop processes you didn't start.
`;
}

module.exports = { workerPrompt, earlierNotes };
