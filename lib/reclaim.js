// Reclaim finished bounties' worktrees.
//
// Every bounty gets its own worktree, and a Rust or C++ build in it leaves gigabytes of build
// output (target/, Intermediate/) behind. Nothing removed them after the merge, so a project's
// finished worktrees piled up: 39 of them held 189 GB on Kewk's root drive (2026-11-13).
//
// A sweep removes the worktree of a done bounty once all of these hold, and otherwise leaves it:
//   - the bounty has been done for worktree_reclaim.after_minutes, so its agents are long stopped;
//   - no board worker is alive for it, and no process on this machine has its cwd inside it;
//   - it is a linked worktree of the project's repo (never the repo itself);
//   - `git status` shows nothing at all: no changes, no untracked files (ignored files such as
//     target/ are build output and go with it);
//   - its HEAD is on main (an ancestor, or an equivalent patch), so no commit is lost.
// The removal is `git worktree remove` without --force, so git itself refuses a dirty tree too.
// The branch stays. A worktree on another drive (slot.worktree_root) is removed at its real
// path, and the symlink at the usual path goes with it.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const gitx = require('./git');
const { addEvent } = require('./db');

function realpath(p) { try { return fs.realpathSync(p); } catch { return null; } }

// Paths of this repo's linked worktrees (realpaths), from `git worktree list --porcelain`.
function linkedWorktrees(repo) {
  const r = gitx.tryGit(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return new Set();
  const paths = r.out.split('\n').filter(l => l.startsWith('worktree ')).map(l => realpath(l.slice(9))).filter(Boolean);
  return new Set(paths.slice(1)); // the first entry is the main working tree
}

// Whether any process has its working directory inside dir. Linux /proc only; elsewhere, unknown
// counts as busy so nothing is removed.
function cwdInside(dir, procRoot = '/proc') {
  let pids;
  try { pids = fs.readdirSync(procRoot).filter(n => /^\d+$/.test(n)); } catch { return true; }
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  for (const pid of pids) {
    let cwd;
    try { cwd = fs.readlinkSync(path.join(procRoot, pid, 'cwd')); } catch { continue; }
    if (cwd === dir || cwd.startsWith(prefix)) return true;
  }
  return false;
}

function run(repo, args) {
  return new Promise(resolve => {
    execFile('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, out: String(err ? (stderr || err.message) : stdout) }));
  });
}

// Why the worktree of bounty b must stay, or null when it can go.
function keepWhy(board, b, p, opts) {
  const wt = b.worktree;
  if (!wt || !fs.existsSync(wt)) return 'gone';
  const real = realpath(wt);
  if (!real) return 'gone';
  if (real === realpath(p.repo)) return 'it is the project repo';
  if (!linkedWorktrees(p.repo).has(real)) return 'not a linked worktree of the project repo';
  const doneAt = Date.parse(b.completed_at || b.updated_at || '') || 0;
  if (Date.now() - doneAt < opts.after_minutes * 60000) return 'done too recently';
  if (board.dispatcher && board.dispatcher.isAlive(b.id)) return 'a board worker is alive';
  if (opts.cwdInside(real)) return 'a process is working inside it';
  const st = gitx.tryGit(real, ['status', '--porcelain', '--untracked-files=all']);
  if (!st.ok) return `git status failed: ${st.out.trim().slice(0, 200)}`;
  const dirty = st.out.split('\n').filter(Boolean);
  if (dirty.length) return `${dirty.length} uncommitted or untracked file(s)`;
  const head = gitx.revParse(real, 'HEAD');
  if (!head) return 'no HEAD';
  const merged = gitx.mergedIntoMain(p.repo, p.main_branch, [head], b.branch);
  if (!merged.merged) return `HEAD ${head.slice(0, 10)} is not on ${p.main_branch}`;
  return null;
}

class Reclaimer {
  constructor(board, opts = {}) {
    this.board = board;
    this.opts = { cwdInside, ...board.cfg.worktree_reclaim, ...opts };
    this.running = null;
    this.told = new Map(); // bounty id -> last keep reason recorded, so a kept tree is noted once
  }

  sweep() {
    if (this.running) return this.running;
    this.running = this._sweep().finally(() => { this.running = null; });
    return this.running;
  }

  async _sweep() {
    const { db } = this.board;
    const rows = db.prepare("SELECT id FROM bounties WHERE status = 'done' AND worktree IS NOT NULL AND project_id != 'legacy' ORDER BY id").all();
    const out = [];
    for (const { id } of rows) {
      const b = this.board.raw(id);
      const p = b && this.board.project(b.project_id);
      if (!p) continue;
      const why = keepWhy(this.board, b, p, this.opts);
      if (why === 'gone') continue;
      if (why) {
        // Timing reasons pass on their own; only a lasting reason is worth an event, once.
        if (!/too recently|worker is alive|working inside/.test(why) && this.told.get(id) !== why) {
          this.told.set(id, why);
          addEvent(db, { bounty_id: id, actor: 'board', kind: 'reclaim', note: `worktree kept: ${why} (${b.worktree})` });
        }
        out.push({ id, kept: why });
        continue;
      }
      const real = realpath(b.worktree);
      const r = await run(p.repo, ['worktree', 'remove', real]);
      if (!r.ok) {
        addEvent(db, { bounty_id: id, actor: 'board', kind: 'reclaim', note: `worktree remove failed: ${r.out.trim().slice(0, 300)}` });
        out.push({ id, error: r.out.trim() });
        continue;
      }
      try { if (fs.lstatSync(b.worktree).isSymbolicLink()) fs.unlinkSync(b.worktree); } catch {}
      addEvent(db, { bounty_id: id, actor: 'board', kind: 'reclaim', note: `worktree removed after merge: ${b.worktree} (branch ${b.branch} kept)` });
      out.push({ id, removed: b.worktree });
    }
    if (out.some(o => o.removed)) this.board.changed('bounty', {});
    return out;
  }
}

module.exports = { Reclaimer, keepWhy, cwdInside, linkedWorktrees };
