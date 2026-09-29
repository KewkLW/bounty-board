// Git facts the gates are built on. Every check reads the real repository; nothing an agent
// says is taken on trust.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
}

function tryGit(repo, args) {
  try { return { ok: true, out: git(repo, args) }; } catch (e) { return { ok: false, out: String(e.stderr || e.message) }; }
}

function branchExists(repo, branch) {
  if (!branch || /^-/.test(branch)) return false;
  return tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
}

function revParse(repo, ref) {
  const r = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.ok ? r.out.trim() : null;
}

// Files changed on the branch since it forked from main (three-dot = merge-base diff).
function changedFiles(repo, main, branch) {
  const out = git(repo, ['diff', '--name-only', `${main}...${branch}`]);
  return out.split('\n').map(s => s.trim()).filter(Boolean);
}

function diffText(repo, main, branch) {
  return git(repo, ['diff', '--stat', '--patch', `${main}...${branch}`]);
}

function diffStat(repo, main, branch) {
  return git(repo, ['diff', '--stat', `${main}...${branch}`]).trim();
}

// Commits on the branch that main doesn't have.
function commitsAhead(repo, main, branch) {
  return git(repo, ['rev-list', '--reverse', `${main}..${branch}`]).split('\n').map(s => s.trim()).filter(Boolean);
}

// Notes/logs: what faked work looked like on the old board (WORK_LOG.md appends).
const NOTE_PATTERNS = [
  /(^|\/)WORK_LOG[^/]*$/i,
  /\.(md|markdown|txt|log|rst|adoc)$/i,
  /(^|\/)(notes?|logs?|journal)\//i,
  /(^|\/)(CHANGELOG|HANDOFF|STATUS)[^/]*$/i,
];
function isNoteFile(f) { return NOTE_PATTERNS.some(re => re.test(f)); }
function notesOnly(files) { return files.length > 0 && files.every(isNoteFile); }

// Done means the work is on main. A commit counts if it is an ancestor of main, or if main
// holds an equivalent patch (rebase / cherry-pick merges change the SHA; `git cherry` compares
// patch ids).
function mergedIntoMain(repo, main, commits, branch) {
  if (!commits || commits.length === 0) return { merged: false, reason: 'no commits recorded' };
  const missing = [];
  for (const c of commits) {
    if (!revParse(repo, c)) { missing.push(c); continue; }
    if (!tryGit(repo, ['merge-base', '--is-ancestor', c, main]).ok) missing.push(c);
  }
  if (missing.length === 0) return { merged: true, how: 'ancestor' };
  // Patch-id fallback: rebase or cherry-pick merges give new SHAs with the same patch.
  const mainIds = patchIds(repo, ['log', '-p', '--no-merges', '-n', '2000', main]);
  const stillMissing = missing.filter(c => {
    if (!revParse(repo, c)) return true;
    const ids = patchIds(repo, ['show', c]);
    return ids.size === 0 || ![...ids].every(id => mainIds.has(id));
  });
  if (stillMissing.length === 0) return { merged: true, how: 'patch-equivalent' };
  // Squash merge: the whole recorded range as one patch.
  const first = commits[0], last = commits[commits.length - 1];
  if (revParse(repo, first) && revParse(repo, last)) {
    const squash = patchIds(repo, ['diff', `${first}^`, last]);
    if (squash.size === 1 && mainIds.has([...squash][0])) return { merged: true, how: 'squash' };
  }
  return { merged: false, reason: `${stillMissing.length} commit(s) not on ${main}`, missing: stillMissing };
}

function patchIds(repo, args) {
  try {
    const patch = git(repo, args);
    const out = execFileSync('git', ['-C', repo, 'patch-id', '--stable'], { input: patch, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    return new Set(out.split('\n').filter(Boolean).map(l => l.split(' ')[0]));
  } catch { return new Set(); }
}

// Run a shell command in dir; resolves {code, timedOut, tail}. Output goes to logPath.
function runLogged(cmd, dir, logPath, timeoutMin, env = {}) {
  return new Promise(resolve => {
    const fd = fs.openSync(logPath, 'a');
    fs.writeSync(fd, `$ ${cmd}\n# cwd ${dir}\n# started ${new Date().toISOString()}\n`);
    const child = spawn('bash', ['-lc', cmd], { cwd: dir, stdio: ['ignore', fd, fd], detached: true, env: { ...process.env, ...env } });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 10000);
    }, timeoutMin * 60000);
    child.on('error', err => { fs.writeSync(fd, `\n# spawn error: ${err.message}\n`); });
    child.on('close', code => {
      clearTimeout(t);
      fs.writeSync(fd, `\n# exit ${code}${timedOut ? ' (timed out)' : ''} at ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      resolve({ code, timedOut, tail: tailFile(logPath, 4000) });
    });
  });
}

function tailFile(p, n) {
  try {
    const st = fs.statSync(p);
    const start = Math.max(0, st.size - n);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

module.exports = {
  git, tryGit, branchExists, revParse, changedFiles, diffText, diffStat, commitsAhead,
  isNoteFile, notesOnly, mergedIntoMain, runLogged, tailFile,
};
