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

// Every orchestrator note on this bounty (events of kind 'message'), in full: requirements and
// machine rules added after the bounty was written. Each later attempt sees all of them.
function orchestratorNotes(board, b) {
  return board.notes(b.id).map(e => `- ${e.at.slice(0, 16).replace('T', ' ')} (${e.actor || 'orchestrator'}): ${e.note}`).join('\n');
}

function machineRules(board) {
  const r = board.cfg.machine_rules || [];
  return r.length ? `\n# Machine rules (shared with other workers on this board)\n${r.map(x => `- ${x}`).join('\n')}\n` : '';
}

function renderRule(board, p) {
  const ext = board.externalsFor(p.id);
  if (ext.length) {
    return ext.map((e, i) => `${6 + i}. ${e.resource.toUpperCase()}: ${e.what}. ${e.how} The script: \`${e.script}\`. \`bounty lease ${e.resource}\` shows who holds it right now.`).join('\n');
  }
  return '6. Before any rendered/GPU run (game clients, editors, seat captures, frame timing): `bounty lease gpu` (waits until it is free), and `bounty release gpu` right after.';
}

function workerPrompt(board, b, slot, { worktree, branch }) {
  const p = board.project(b.project_id);
  const cfg = board.cfg;
  const cli = path.join(cfg.bin_dir, 'bounty');
  const crit = (b.criteria || []).map((c, i) => `${i + 1}. [${c.done ? 'x' : ' '}] ${c.text}`).join('\n') || '(none written; the description is the spec)';
  const notes = earlierNotes(board, b);
  const orch = orchestratorNotes(board, b);
  const rules = ruleDocs(p, worktree);
  const parent = b.parent_id ? board.raw(b.parent_id) : null;
  const finish = 6 + Math.max(1, board.externalsFor(p.id).length);
  return `You are ${slot.id}, a worker spawned by the Bounty Board for bounty #${b.id} (${b.ticket_id}). One fresh agent per bounty: when this bounty is submitted or blocked, your job is over and you exit.

# The bounty
- Title: ${b.title}
- Type ${b.type}, tier ${b.tier}, priority ${b.priority}, project ${p.id}${parent ? `, split from #${parent.id} "${parent.title}"` : ''}
- Attempt ${b.attempts} (earlier attempts: ${Math.max(0, b.attempts - 1)})

## Description / brief
${b.description || '(no description)'}

## Acceptance criteria (the reviewer checks each one against your diff)
${crit}
${orch ? `\n## Orchestrator notes (added after the brief was written; they win where they conflict with it)\n${orch}\n` : ''}${notes ? `\n## Notes from earlier attempts (fix what they point out)\n${notes}\n` : ''}
# Where you work
- Worktree: ${worktree} (your cwd). Branch: \`${branch}\`. Commit your work on this branch.
- Main branch: \`${p.main_branch}\` in ${p.repo}. Never merge, never push to ${p.main_branch}, never rebase other branches.
- Verify command (run it yourself before you submit): \`${p.verify_cmd || '(none configured)'}\`
${rules.length ? `\n# Project rules: read these first and follow them\n${rules.map(r => `- ${r}`).join('\n')}\n` : ''}${machineRules(board)}
# You run headless
There is no human and no next turn. When you end your turn, your process exits: an unsubmitted bounty is blocked and your background jobs die. Never stop to wait for a background job, a wakeup, a reminder or a reply; keep working (or polling) until \`bounty submit\` is accepted or you \`bounty block\`.

# Mandatory protocol: the Bounty CLI
The CLI is \`${cli}\` (also \`bounty\` on PATH). BOUNTY_ID=${b.id} and BOUNTY_SLOT=${slot.id} are already set in your environment, so the commands below act on this bounty.
1. \`bounty start\` FIRST, before anything else. It also prints any orchestrator notes waiting for you.
2. \`bounty inbox\` right after start, after each major step, and at least every 15 minutes. The orchestrator sends running workers new requirements and machine rules this way; it prints the unread notes and marks them read. A note wins over the brief where they conflict: act on it before you go on. \`bounty progress\` prints unread notes too, so read its output.
3. \`bounty progress "<what you just did / found>"\` after every meaningful step, at least every 15 minutes. It is your heartbeat: ${cfg.watchdog.stall_minutes} minutes of silence gets you killed and the bounty blocked. When an acceptance criterion is met, add \`--check <n>\` with the evidence in the note. For a command that takes longer than ~10 minutes (a build, a cook, ci, a test stack), start it in the background with its output in a file, then wait in the foreground with short polling commands (e.g. \`sleep 240; tail -5 out.log\`) and a \`bounty progress\` between polls.
4. \`bounty split "<title>" --desc "<what and why>"\` for any gap or extra work you find outside this bounty. Do not do that work here.
5. \`bounty block "<reason>"\` if you are stuck (missing information, a broken environment, a decision only a human can make), then exit.
${renderRule(board, p)}
${finish}. Finish: commit everything on \`${branch}\`, run the verify command, then \`bounty submit\`. Submit refuses a missing branch, an empty diff, or a diff that only touches notes/logs; then the verify command runs on your branch, and a reviewer reads the real diff against the acceptance criteria. If submit is refused or verify fails, fix it and submit again. Once submit is accepted, stop and exit.

You cannot mark anything approved or done; the board does that only after review and after the orchestrator merges your commits into ${p.main_branch}. Don't touch other worktrees, and don't stop processes you didn't start.
`;
}

module.exports = { workerPrompt, earlierNotes, orchestratorNotes };
