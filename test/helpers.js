// Test helpers: throwaway git repos, temp configs, a server on a random port.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { load } = require('../lib/config');
const { createServer } = require('../server');

const ROOT = path.resolve(__dirname, '..');

function tmpdir(tag) { return fs.mkdtempSync(path.join(process.env.BOUNTY_TEST_TMP || os.tmpdir(), `bb-${tag}-`)); }

function sh(cwd, cmd) { return execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }

// A tiny repo with main, a verify script (node --test) and one source file.
function makeRepo(dir, { verify = 'pass' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false');
  fs.writeFileSync(path.join(dir, 'math.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
  fs.writeFileSync(path.join(dir, 'math.test.js'), "const t = require('node:test'); const a = require('node:assert'); const m = require('./math');\nt.test('add', () => a.strictEqual(m.add(2, 3), 5));\n");
  fs.writeFileSync(path.join(dir, 'verify.sh'), verify === 'pass'
    ? '#!/bin/bash\nset -e\nnode --test\n'
    : '#!/bin/bash\necho "verify: failing on purpose"\nexit 1\n');
  fs.chmodSync(path.join(dir, 'verify.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'README.md'), '# scratch\n');
  sh(dir, 'git add -A && git commit -q -m init');
  return dir;
}

function writeConfig(dir, over = {}) {
  const cfg = {
    port: 0, host: '127.0.0.1', allow_cidrs: ['127.0.0.0/8', '::1/128'],
    db_path: path.join(dir, 'board.db'), logs_dir: path.join(dir, 'logs'), registry_dir: path.join(dir, 'registry'),
    concurrency_cap: 3, tick_seconds: 1,
    watchdog: { stall_minutes: 30, check_seconds: 1, kill_grace_seconds: 1 },
    retry: { max_attempts: 4, escalate_after_failures: 2, escalate_model: { haiku: 'sonnet', sonnet: 'opus' } },
    leases: { default_ttl_minutes: 45 }, merge_check_seconds: 1, verify_concurrency: 1,
    reviewer: { runner: 'command', cmd: ['bash', path.join(ROOT, 'test', 'fake-reviewer.sh')], timeout_minutes: 2, max_errors: 3 },
    runners: {},
    slots: [
      { id: 'fake-1', name: 'Alpha', runner: 'command', model: 'sonnet', cmd: ['bash', path.join(ROOT, 'test', 'fake-worker.sh')] },
      { id: 'fake-2', name: 'Bravo', runner: 'command', model: 'opus', cmd: ['bash', path.join(ROOT, 'test', 'fake-worker.sh')] },
    ],
    ...over,
  };
  const p = path.join(dir, 'board.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

async function startBoard(tag, { over = {}, dispatch = true, verify = 'pass' } = {}) {
  const dir = tmpdir(tag);
  const repo = makeRepo(path.join(dir, 'repo'), { verify });
  const cfgPath = writeConfig(dir, over);
  process.env.BOUNTY_NO_SEED = '1';
  const cfg = load(cfgPath);
  const s = createServer(cfg, { dispatch });
  const port = await s.listen();
  const origClose = s.close;
  s.close = async () => {
    for (const w of s.dispatcher.live.values()) { try { process.kill(-w.pid, 'SIGKILL'); } catch {} }
    s.dispatcher.stop(); s.reviewer.stop();
    await new Promise(r => setTimeout(r, 300));
    await origClose();
  };
  const url = `http://127.0.0.1:${port}`;
  s.board.upsertProject({ id: 'scratch', repo, main_branch: 'main', worktree_cmd: 'git worktree add {path} -b {branch} {main}',
    worktree_path: path.join(dir, 'wt', '{task}'), verify_cmd: './verify.sh', verify_timeout_min: 2 });
  const call = async (method, p, body, actor = 'orchestrator') => {
    const r = await fetch(url + '/api' + p, { method, headers: { 'content-type': 'application/json', 'x-bounty-actor': actor }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  return { dir, repo, cfg, s, board: s.board, url, call };
}

async function waitFor(fn, ms = 20000, step = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise(r => setTimeout(r, step));
  }
  throw new Error('waitFor timed out; last=' + JSON.stringify(last));
}

module.exports = { tmpdir, sh, makeRepo, writeConfig, startBoard, waitFor, ROOT };
