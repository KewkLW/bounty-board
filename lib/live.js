// The Live view: what every slot's worker is doing right now, what verifies and CI runs are on
// which stage, who holds the UE render lock and the UE stack gate, the tester, the queue.
// Read-only. Everything here is cheap to recompute: logs are followed incrementally (only the
// bytes appended since the last poll are read), the process table is one `ps`, and a snapshot
// is cached for a couple of seconds so many viewers cost the same as one.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

// ---------------------------------------------------------------- incremental log follower
// follow(path, makeState, feed) keeps a byte offset per file and feeds only new complete lines
// to feed(state, line). A file that shrinks or is replaced (new inode) starts over.
class Follower {
  constructor({ chunk = 1 << 20, maxInitial = Infinity, evictMs = 15 * 60000 } = {}) {
    this.chunk = chunk; this.maxInitial = maxInitial; this.evictMs = evictMs;
    this.files = new Map();
  }

  follow(file, makeState, feed, { maxInitial = this.maxInitial } = {}) {
    let st;
    try { st = fs.statSync(file); } catch { this.files.delete(file); return null; }
    let e = this.files.get(file);
    if (!e || e.ino !== st.ino || st.size < e.offset) {
      const start = Math.max(0, st.size - maxInitial);
      e = { ino: st.ino, offset: start, partial: '', skipFirst: start > 0, state: makeState() };
      this.files.set(file, e);
    }
    e.touched = Date.now();
    e.state.mtimeMs = st.mtimeMs;
    e.state.size = st.size;
    if (st.size > e.offset) {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(this.chunk, st.size - e.offset));
        while (e.offset < st.size) {
          const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - e.offset), e.offset);
          if (n <= 0) break;
          e.offset += n;
          const text = e.partial + buf.toString('utf8', 0, n);
          const lines = text.split('\n');
          e.partial = lines.pop();
          if (e.partial.length > 4 << 20) e.partial = ''; // a runaway line; drop it
          for (const line of lines) {
            if (e.skipFirst) { e.skipFirst = false; continue; }
            try { feed(e.state, line); } catch {}
          }
        }
      } finally { fs.closeSync(fd); }
    }
    return e.state;
  }

  evict() {
    const t = Date.now();
    for (const [k, e] of this.files) if (t - (e.touched || 0) > this.evictMs) this.files.delete(k);
  }
}

// ---------------------------------------------------------------- worker logs (stream-json)
const trunc = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function relPath(p, cwd) {
  p = String(p || '');
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  return p;
}

// One-line summary of a tool call, e.g. "Bash: Scripts/ci.sh --quick" or "Edit: Source/X.cpp".
function summarizeTool(name, input, cwd) {
  const i = input || {};
  switch (name) {
    case 'Bash': {
      const cmd = String(i.command || '').split('\n').map(s => s.trim()).filter(Boolean);
      const first = cmd[0] || '';
      return `Bash: ${trunc(cmd.length > 1 ? `${first} …(+${cmd.length - 1} lines)` : first, 140)}`;
    }
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit':
      return `${name}: ${trunc(relPath(i.file_path || i.notebook_path || i.path, cwd), 140)}`;
    case 'Grep': return `Grep: ${trunc(i.pattern, 80)}${i.path ? ' in ' + trunc(relPath(i.path, cwd), 60) : ''}`;
    case 'Glob': return `Glob: ${trunc(i.pattern, 100)}`;
    case 'TodoWrite': {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const cur = todos.find(t => t.status === 'in_progress');
      const done = todos.filter(t => t.status === 'completed').length;
      return `Todo ${done}/${todos.length}${cur ? ': ' + trunc(cur.activeForm || cur.content, 110) : ''}`;
    }
    case 'WebFetch': return `WebFetch: ${trunc(i.url, 120)}`;
    case 'WebSearch': return `WebSearch: ${trunc(i.query, 120)}`;
    case 'Task': case 'Agent': return `${name}: ${trunc(i.description || i.prompt, 120)}`;
    default: return `${name}: ${trunc(JSON.stringify(i), 120)}`;
  }
}

function newWorkerState() {
  return {
    actions: [], lastText: null, lastEventAt: null, pending: new Set(), seenMsg: new Map(),
    usage: { tokens_in: 0, tokens_out: 0, cache_read: 0, cache_write: 0, cost_usd: null },
    result: null, cwd: null, lines: 0, outChars: 0,
  };
}

const MAX_ACTIONS = 8;
function pushAction(st, a) {
  st.actions.push(a);
  if (st.actions.length > MAX_ACTIONS) st.actions.shift();
}

// Feed one line of a claude stream-json or codex --json log.
function feedWorkerLine(st, line) {
  st.lines++;
  if (!line || line[0] !== '{') {
    const m = line && line.match(/^# cwd (.+)$/);
    if (m) st.cwd = m[1].trim();
    return;
  }
  // Tool results can be huge; only the id matters, so don't JSON.parse user events.
  if (line.startsWith('{"type":"user"')) {
    for (const m of line.matchAll(/"tool_use_id":"([^"]+)"/g)) st.pending.delete(m[1]);
    const ts = line.match(/"timestamp":"([^"]+)"/);
    if (ts) st.lastEventAt = ts[1];
    return;
  }
  let ev; try { ev = JSON.parse(line); } catch { return; }
  if (ev.timestamp) st.lastEventAt = ev.timestamp;
  const at = ev.timestamp || null;
  if (ev.type === 'system' && ev.subtype === 'init' && ev.cwd) st.cwd = ev.cwd;
  if (ev.type === 'assistant' && ev.message) {
    const m = ev.message;
    if (m.usage && m.id) {
      // Every content block of a message repeats its usage, and output_tokens grows as it
      // streams: count each message once, at its latest figures.
      const cur = { tokens_in: m.usage.input_tokens || 0, tokens_out: m.usage.output_tokens || 0,
        cache_read: m.usage.cache_read_input_tokens || 0, cache_write: m.usage.cache_creation_input_tokens || 0 };
      const prev = st.seenMsg.get(m.id);
      for (const k of Object.keys(cur)) st.usage[k] += cur[k] - (prev ? prev[k] : 0);
      if (prev) st.seenMsg.delete(m.id);
      st.seenMsg.set(m.id, prev ? { ...cur, tokens_out: Math.max(cur.tokens_out, prev.tokens_out) } : cur);
      if (prev && prev.tokens_out > cur.tokens_out) st.usage.tokens_out += prev.tokens_out - cur.tokens_out;
      if (st.seenMsg.size > 200) st.seenMsg.delete(st.seenMsg.keys().next().value);
    }
    for (const c of m.content || []) {
      // Claude's stream-json carries output_tokens from the start of each message only; count
      // the visible output too so a running worker's output (and $) can be estimated.
      if (c.type === 'text' && c.text) st.outChars += c.text.length;
      else if (c.type === 'tool_use') st.outChars += JSON.stringify(c.input || {}).length;
      if (c.type === 'text' && c.text && c.text.trim()) {
        const lines = c.text.trim().split('\n').map(s => s.trim()).filter(Boolean);
        st.lastText = { text: trunc(lines[lines.length - 1], 240), at };
      } else if (c.type === 'tool_use') {
        pushAction(st, { at, tool: c.name, summary: summarizeTool(c.name, c.input, st.cwd), id: c.id });
        if (c.id) { st.pending.add(c.id); if (st.pending.size > 50) st.pending.delete(st.pending.values().next().value); }
      }
    }
  } else if (ev.type === 'result') {
    st.result = { subtype: ev.subtype, cost_usd: ev.total_cost_usd ?? null, turns: ev.num_turns ?? null };
    if (typeof ev.total_cost_usd === 'number') st.usage.cost_usd = ev.total_cost_usd;
    const ru = ev.usage || {};
    if (ru.input_tokens != null) {
      st.usage.tokens_in = ru.input_tokens || 0; st.usage.tokens_out = ru.output_tokens || 0;
      st.usage.cache_read = ru.cache_read_input_tokens || 0; st.usage.cache_write = ru.cache_creation_input_tokens || 0;
    }
    if (ev.result) st.lastText = { text: trunc(String(ev.result).trim().split('\n').pop(), 240), at };
  } else if (ev.type === 'item.started' && ev.item && ev.item.type === 'command_execution') {
    // codex --json
    pushAction(st, { at, tool: 'exec', summary: `exec: ${trunc(ev.item.command, 140)}`, id: ev.item.id });
    if (ev.item.id) st.pending.add(ev.item.id);
  } else if (ev.type === 'item.completed' && ev.item) {
    const it = ev.item;
    if (it.type === 'command_execution') {
      if (it.id && st.pending.has(it.id)) st.pending.delete(it.id);
      else pushAction(st, { at, tool: 'exec', summary: `exec: ${trunc(it.command, 140)}`, id: it.id });
    } else if (it.type === 'agent_message' && it.text) {
      st.lastText = { text: trunc(String(it.text).trim().split('\n').pop(), 240), at };
    } else if (it.type === 'file_change') {
      const files = (it.changes || []).map(c => relPath(c.path, st.cwd)).join(', ');
      pushAction(st, { at, tool: 'edit', summary: `Edit: ${trunc(files, 140)}`, id: it.id });
    }
  } else if (ev.type === 'turn.completed' && ev.usage) {
    st.usage.tokens_in += ev.usage.input_tokens || 0; st.usage.tokens_out += ev.usage.output_tokens || 0;
    st.usage.cache_read += ev.usage.cached_input_tokens || 0;
  }
}

// The public view of a worker state: last actions (newest last) with a running flag.
function workerView(st, n = 5) {
  if (!st) return null;
  return {
    actions: st.actions.slice(-n).map(a => ({ at: a.at, tool: a.tool, summary: a.summary, running: !!(a.id && st.pending.has(a.id)) })),
    last_text: st.lastText, last_event_at: st.lastEventAt, result: st.result,
    usage: { ...st.usage, tokens_out_est: st.usage.cost_usd != null ? st.usage.tokens_out : Math.max(st.usage.tokens_out, Math.round(st.outChars / 3.5)) },
    log_mtime: st.mtimeMs ? new Date(st.mtimeMs).toISOString() : null, log_bytes: st.size || 0,
  };
}

function parseWorkerLog(text) {
  const st = newWorkerState();
  for (const l of String(text).split('\n')) feedWorkerLine(st, l);
  return st;
}

// ---------------------------------------------------------------- CI logs (Scripts/ci.sh)
// ci.sh prints "==> [stage]" before each stage and a STAGE/RESULT/DURATION table at the end;
// the board's runLogged adds "$ cmd", "# started" and "# exit N". The lock scripts print
// "ue-render-lock: waiting ..." / "ue-stack-gate: waiting ..." while they wait.
function newCiState() {
  return { cmd: null, started: null, stages: [], current: null, results: {}, inSummary: false, exit: null, wait: null, lines: 0 };
}

function feedCiLine(st, line) {
  st.lines++;
  let m;
  if (st.lines <= 3 && (m = line.match(/^\$ (.+)$/))) { st.cmd = m[1].trim(); return; }
  if ((m = line.match(/^# started (\S+)/))) { st.started = m[1]; return; }
  if ((m = line.match(/^==> \[([A-Za-z0-9_.-]+)\]\s*$/))) {
    st.stages.push(m[1]); st.current = m[1]; st.inSummary = false; st.wait = null; return;
  }
  if (/^STAGE\s+RESULT\s+DURATION/.test(line)) { st.inSummary = true; return; }
  if (st.inSummary && (m = line.match(/^(\S+)\s+(PASS|FAIL)\s+(\S+)/))) { st.results[m[1]] = { result: m[2], duration: m[3] }; return; }
  if ((m = line.match(/^# exit (\S+)/))) { st.exit = m[1]; return; }
  if ((m = line.match(/(ue-render-lock|ue-stack-gate|ue-stack):\s*(waiting.*)$/i))) {
    st.wait = { lock: /render/i.test(m[1]) ? 'render' : 'stack', text: trunc(m[2], 200) };
    return;
  }
  if (st.wait && /(ue-render-lock|ue-stack-gate|ue-stack):.*(acquired|admitted|joined|gave up|got)/i.test(line)) st.wait = null;
}

function parseCiLog(text) {
  const st = newCiState();
  for (const l of String(text).split('\n')) feedCiLine(st, l);
  return st;
}

// Stage lists from ci.sh itself (bash arrays), so the page can say "stage 5/9".
const planCache = new Map();
function ciStageLists(script) {
  let st; try { st = fs.statSync(script); } catch { return null; }
  const c = planCache.get(script);
  if (c && c.mtimeMs === st.mtimeMs) return c.lists;
  const src = fs.readFileSync(script, 'utf8');
  const arr = name => {
    const m = src.match(new RegExp(`^${name}=\\(([\\s\\S]*?)\\)`, 'm'));
    return m ? m[1].split(/\s+/).filter(w => w && !w.startsWith('"') && !w.startsWith('$')) : null;
  };
  const lists = { all: arr('all_stages'), quick: arr('quick_stages') };
  planCache.set(script, { mtimeMs: st.mtimeMs, lists });
  return lists;
}

// The stages a ci.sh command line selects (--quick default, --full, --only, --skip).
function ciPlan(lists, args) {
  if (!lists || !lists.all) return null;
  const a = Array.isArray(args) ? args : String(args || '').split(/\s+/).filter(Boolean);
  let profile = 'quick'; const only = [], skip = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--full') profile = 'full';
    else if (x === '--quick') profile = 'quick';
    else if (x === '--only' || x === '--skip') { (x === '--only' ? only : skip).push(...String(a[++i] || '').split(',')); }
    else if (x.startsWith('--only=')) only.push(...x.slice(7).split(','));
    else if (x.startsWith('--skip=')) skip.push(...x.slice(7).split(','));
  }
  const cand = only.length ? only : profile === 'full' ? lists.all : (lists.quick || lists.all);
  return lists.all.filter(s => cand.includes(s) && !skip.includes(s));
}

function ciView(st, plan) {
  if (!st) return null;
  const done = st.exit != null || Object.keys(st.results).length > 0;
  const idx = plan && st.current ? plan.indexOf(st.current) : -1;
  return {
    cmd: st.cmd, started: st.started, stage: done ? null : st.current, stages_done: st.stages.length ? st.stages.length - (done ? 0 : 1) : 0,
    position: idx >= 0 ? idx + 1 : null, total: plan ? plan.length : null,
    finished: done, exit: st.exit, results: st.results, waiting: st.wait,
    log_mtime: st.mtimeMs ? new Date(st.mtimeMs).toISOString() : null,
  };
}

// ---------------------------------------------------------------- lock holder files
// key=value lines (Scripts/lib/ue-render-lock.sh, ue-stack-gate.sh); JSON is accepted too.
function parseHolder(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  let h;
  try { h = JSON.parse(raw); } catch {
    h = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
      if (m) h[m[1].toLowerCase()] = m[2].trim();
    }
    if (!Object.keys(h).length) return { text: raw.trim() };
  }
  const out = { ...h };
  if (out.pid != null && out.pid !== '') out.pid = Number(out.pid);
  if (typeof out.pids === 'string') out.pids = out.pids.split(/\s+/).filter(Boolean).map(Number);
  if (out.keeper != null && out.keeper !== '') out.keeper = Number(out.keeper);
  const epoch = Number(out.started_epoch || 0) || (out.started ? Math.floor(Date.parse(out.started) / 1000) : 0);
  out.since_s = epoch ? Math.max(0, Math.floor(Date.now() / 1000) - epoch) : null;
  return out;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function lockHeld(lockFile) {
  if (!fs.existsSync(lockFile)) return false;
  const r = spawnSync('flock', ['-n', lockFile, 'true'], { timeout: 3000 });
  if (r.error) return null;
  return r.status !== 0;
}

function readLock(dir, name) {
  const lock = path.join(dir, `${name}.lock`);
  const holderFile = path.join(dir, `${name}.holder`);
  let holder = null;
  try { holder = parseHolder(fs.readFileSync(holderFile, 'utf8')); } catch {}
  const held = lockHeld(lock);
  if (holder) {
    holder.pid_alive = holder.pid ? pidAlive(holder.pid) : null;
    holder.keeper_alive = holder.keeper ? pidAlive(holder.keeper) : null;
  }
  return { name, lock_file: lock, holder_file: holderFile, held, holder, stale: !!holder && held === false };
}

function memInfo() {
  const out = {};
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = line.match(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)/);
      if (m) out[m[1]] = Math.round(Number(m[2]) / 1024); // MB
    }
  } catch {}
  return { total_mb: out.MemTotal ?? null, available_mb: out.MemAvailable ?? null, swap_total_mb: out.SwapTotal ?? null, swap_free_mb: out.SwapFree ?? null };
}

// ---------------------------------------------------------------- process table
function parsePs(text) {
  const procs = new Map();
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), etimes: Number(m[3]), args: m[4] });
  }
  const kids = new Map();
  for (const p of procs.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  return { procs, kids };
}

function psSnapshot() {
  return new Promise(resolve => {
    execFile('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { maxBuffer: 16 << 20, timeout: 5000 }, (err, out) => resolve(parsePs(err ? '' : out)));
  });
}

function descendants(pt, pid) {
  const out = [];
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    for (const c of pt.kids.get(p) || []) { if (!seen.has(c.pid)) { seen.add(c.pid); out.push(c); stack.push(c.pid); } }
  }
  return out;
}

function isAncestor(pt, anc, pid) {
  for (let p = pt.procs.get(pid), n = 0; p && n < 64; p = pt.procs.get(p.ppid), n++) if (p.pid === anc) return true;
  return false;
}

function procEnv(pid, keys) {
  const out = {};
  try {
    for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0')) {
      const i = kv.indexOf('=');
      if (i > 0 && keys.includes(kv.slice(0, i))) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
  } catch {}
  return out;
}
const readlink = p => { try { return fs.readlinkSync(p); } catch { return null; } };

// A `flock -w N FD` (or `flock FILE`) process is a wait on a lock; which lock is where FD points.
function lockWaits(pt, procs, lockDir) {
  const out = [];
  for (const p of procs) {
    const a = p.args.split(/\s+/);
    if (!/(^|\/)flock$/.test(a[0])) continue;
    if (a.includes('-n') || a.includes('--nonblock')) continue;
    const target = a[a.length - 1];
    let file = /^\d+$/.test(target) ? readlink(`/proc/${p.pid}/fd/${target}`) : target;
    if (!file) continue;
    const base = path.basename(file);
    if (lockDir && !file.startsWith(lockDir)) continue;
    const lock = /ue-render/.test(base) ? 'render' : /ue-stack/.test(base) ? 'stack' : null;
    if (lock) out.push({ lock, pid: p.pid, flock_age_s: p.etimes, file }); // flock -w retries in steps: its age is not the wait time
  }
  return out;
}

const NOTABLE = /(Scripts\/[\w.-]+\.(sh|py)|UnrealEditor|go test|\bmake\b|dotnet|\bnpm\b|\bcargo\b|git (push|rebase|merge|fetch))/;
function notableProcs(procs, limit = 5) {
  return procs.filter(p => NOTABLE.test(p.args) && !/^(bash -c|\/usr\/bin\/bash -c|sleep)/.test(p.args))
    .sort((x, y) => y.etimes - x.etimes).slice(0, limit)
    .map(p => ({ pid: p.pid, for_s: p.etimes, args: trunc(p.args, 160) }));
}

// `bash Scripts/ci.sh ...` itself, not a shell whose -c command line merely mentions ci.sh.
const isCiProc = args => /^(\S*\/)?(bash|sh)\s+(\S*\/)?ci\.sh(\s|$)/.test(args);

function ciArgs(args) {
  const m = args.match(/ci\.sh(.*)$/);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------- systemd (tester)
function sh(cmd, args, timeout = 4000) {
  return new Promise(resolve => execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, out) => resolve(err && !out ? '' : String(out || ''))));
}

async function testerStatus(t) {
  if (!t || !t.service) return null;
  const show = await sh('systemctl', ['--user', 'show', t.service, '-p', 'ActiveState,SubState,Result,ExecMainStartTimestamp,ExecMainExitTimestamp,MainPID,LoadState']);
  const props = {};
  for (const l of show.split('\n')) { const i = l.indexOf('='); if (i > 0) props[l.slice(0, i)] = l.slice(i + 1); }
  const out = {
    service: t.service, timer: t.timer || null, loaded: props.LoadState === 'loaded',
    active: props.ActiveState || null, sub: props.SubState || null, result: props.Result || null,
    running: props.ActiveState === 'active' || props.ActiveState === 'activating',
    started: props.ExecMainStartTimestamp || null, ended: props.ExecMainExitTimestamp || null, main_pid: Number(props.MainPID || 0) || null,
    next_run: null, last_run: null, timer_active: null, latest_log: null, latest_line: null,
  };
  if (t.timer) {
    const j = await sh('systemctl', ['--user', 'list-timers', t.timer, '--all', '--output=json', '--no-pager']);
    try {
      const row = JSON.parse(j)[0];
      if (row) {
        if (row.next) out.next_run = new Date(row.next / 1000).toISOString();
        if (row.last) out.last_run = new Date(row.last / 1000).toISOString();
      }
    } catch {}
    const ta = await sh('systemctl', ['--user', 'is-active', t.timer]);
    out.timer_active = ta.trim() || null;
  }
  if (t.log_dir) {
    try {
      const files = fs.readdirSync(t.log_dir).filter(f => f.endsWith('.log'))
        .map(f => ({ f, m: fs.statSync(path.join(t.log_dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
      if (files[0]) {
        const p = path.join(t.log_dir, files[0].f);
        out.latest_log = p; out.latest_log_mtime = new Date(files[0].m).toISOString();
        out.latest_line = lastLine(p);
      }
    } catch {}
  }
  return out;
}

// Last meaningful line of a file, from its last 16 KB. JSON lines (stream-json) are summarized.
function lastLine(file) {
  let text = '';
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, 16384);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l[0] !== '{') return trunc(l, 240);
    const st = newWorkerState();
    feedWorkerLine(st, l);
    if (st.lastText) return st.lastText.text;
    if (st.actions.length) return st.actions[st.actions.length - 1].summary;
  }
  return null;
}

// ---------------------------------------------------------------- $ estimate for live workers
// Claude reports $ only in its final result event. While a worker runs, estimate from its tokens
// with a per-model rate calibrated on that model's finished attempts (weights: output 5x input,
// cache read 0.1x, cache write 1.25x).
const weighted = u => (u.tokens_in || 0) + 5 * (u.tokens_out || 0) + 0.1 * (u.cache_read || 0) + 1.25 * (u.cache_write || 0);

// ---------------------------------------------------------------- the snapshot
class Live {
  constructor(board, dispatcher) {
    this.board = board; this.dispatcher = dispatcher;
    const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    this.opts = Object.assign({
      lock_dir: `/run/user/${uid}/bounty-board`, stuck_minutes: 15, cache_ms: 2000, recent_hours: 24,
      tester: null,
    }, board.cfg.live || {});
    this.follower = new Follower();
    this.ciFollower = new Follower({ maxInitial: 4 << 20 });
    this.cache = null;
    this.rates = null;
  }

  snapshot() {
    const t = Date.now();
    if (this.cache && t - this.cache.at < this.opts.cache_ms) return this.cache.p;
    const p = this.build().catch(e => { this.cache = null; throw e; });
    this.cache = { at: t, p };
    return p;
  }

  rateFor(model) {
    if (!this.rates || Date.now() - this.rates.at > 10 * 60000) {
      const rows = this.board.db.prepare(`SELECT model, cost_usd, tokens_in, tokens_out, cache_read, cache_write FROM attempts
        WHERE kind = 'worker' AND runner = 'claude' AND cost_usd > 0 ORDER BY id DESC LIMIT 200`).all();
      const acc = {};
      for (const r of rows) {
        const w = weighted(r);
        if (!w) continue;
        const k = r.model || '?';
        acc[k] = acc[k] || { c: 0, w: 0 };
        acc[k].c += r.cost_usd; acc[k].w += w;
      }
      const m = {};
      for (const [k, v] of Object.entries(acc)) m[k] = v.c / v.w;
      this.rates = { at: Date.now(), m };
    }
    return this.rates.m[model] ?? null;
  }

  ciLog(file, args, repoDir) {
    const st = this.ciFollower.follow(file, newCiState, feedCiLine);
    if (!st) return null;
    const script = repoDir ? path.join(repoDir, 'Scripts', 'ci.sh') : null;
    const cmdArgs = args != null ? args : st.cmd ? ciArgs(st.cmd) : '';
    const plan = script ? ciPlan(ciStageLists(script), cmdArgs) : null;
    return { log: file, ...ciView(st, plan) };
  }

  // Newest board verify log of a bounty written since its submit.
  verifyLogFor(b) {
    const dir = this.board.cfg.logs_dir;
    const since = b.ci_at ? Date.parse(b.ci_at) - 5000 : 0;
    let best = null;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.startsWith(`bounty-${b.id}-verify-`) || !f.endsWith('.log')) continue;
        const ms = Number(f.slice(`bounty-${b.id}-verify-`.length, -4));
        if (ms >= since && (!best || ms > best.ms)) best = { ms, f };
      }
    } catch {}
    return best ? path.join(dir, best.f) : null;
  }

  // Where a bounty is in the pipeline (verify queue/running, review, approved).
  pipelineState(b) {
    const board = this.board;
    if (b.status === 'in_progress' && b.ci_status === 'running') {
      const active = board.verifyActive && board.verifyActive.get(b.id);
      const qi = (board.verifyQueue || []).findIndex(j => j.id === b.id);
      if (qi >= 0) return { phase: 'verify_queued', label: `verify queued (#${qi + 1} in line)`, queue_position: qi + 1 };
      const log = (active && active.logPath) || this.verifyLogFor(b);
      const p = board.project(b.project_id);
      const ci = log ? this.ciLog(log, null, b.worktree || (p && p.repo)) : null;
      return { phase: 'verifying', label: ci && ci.stage ? `verifying: ${ci.stage}${ci.position ? ` (${ci.position}/${ci.total})` : ''}` : 'verifying', verify: ci, verify_started: active ? active.started : b.ci_at };
    }
    if (b.status === 'in_progress') return { phase: 'in_progress', label: b.ci_status === 'fail' ? 'in progress (fixing a failed verify)' : 'in progress' };
    if (b.status === 'review') return { phase: 'review', label: `in review (${b.review_state || 'pending'})` };
    if (b.status === 'approved') return { phase: 'approved', label: 'approved, waiting for merge to main' };
    if (b.status === 'blocked') return { phase: 'blocked', label: `blocked: ${trunc(b.blocked_reason, 160)}` };
    return { phase: b.status, label: b.status };
  }

  async build() {
    const board = this.board, db = board.db, d = this.dispatcher;
    const nowMs = Date.now();
    const stuckMs = this.opts.stuck_minutes * 60000;
    const [pt, tester] = await Promise.all([psSnapshot(), testerStatus(this.opts.tester).catch(() => null)]);
    const locks = { render: readLock(this.opts.lock_dir, 'ue-render'), stack: readLock(this.opts.lock_dir, 'ue-stack') };
    const mem = memInfo();
    const boardPid = process.pid;

    // Every top-level Scripts/ci.sh run on the machine (not the nested subshells).
    const ciRuns = [];
    for (const p of pt.procs.values()) {
      if (!isCiProc(p.args)) continue;
      const parent = pt.procs.get(p.ppid);
      if (parent && isCiProc(parent.args)) continue; // a nested stage subshell
      const env = procEnv(p.pid, ['BOUNTY_ID', 'BOUNTY_SLOT']);
      const cwd = readlink(`/proc/${p.pid}/cwd`);
      const kind = isAncestor(pt, boardPid, p.pid) ? 'board-verify' : env.BOUNTY_SLOT ? 'worker' : 'other';
      const args = ciArgs(p.args);
      let out = readlink(`/proc/${p.pid}/fd/1`);
      if (out && (!out.startsWith('/') || out.startsWith('/dev/'))) out = null;
      let ci = null;
      if (out && fs.existsSync(out)) ci = this.ciLog(out, args, cwd);
      // Not logging to a file (a pipe or a terminal): the stage is the log `tee` writes.
      if (!ci || !ci.stage) {
        const tee = (pt.kids.get(p.pid) || []).find(k => /^tee\s/.test(k.args));
        const m = tee && tee.args.match(/\/([\w.-]+)\.log\s*$/);
        if (m) {
          const plan = cwd ? ciPlan(ciStageLists(path.join(cwd, 'Scripts', 'ci.sh')), args) : null;
          const idx = plan ? plan.indexOf(m[1]) : -1;
          ci = { ...(ci || {}), stage: m[1], position: idx >= 0 ? idx + 1 : null, total: plan ? plan.length : null };
        }
      }
      const tree = descendants(pt, p.pid);
      ciRuns.push({
        pid: p.pid, kind, bounty_id: env.BOUNTY_ID ? Number(env.BOUNTY_ID) : null, slot: env.BOUNTY_SLOT || null,
        cwd, args, for_s: p.etimes, output: out, ci, waits: lockWaits(pt, tree, this.opts.lock_dir), procs: notableProcs(tree, 3),
      });
    }

    const holderOf = (lock, pids, worktree) => {
      const h = lock.holder;
      if (!h || lock.stale) return false;
      if (worktree && h.worktree === worktree) return true;
      const hp = [h.pid, ...(h.pids || [])].filter(Boolean);
      return hp.some(x => pids.has(x));
    };

    const bSel = db.prepare('SELECT * FROM bounties WHERE id = ?');
    const lastProgress = db.prepare("SELECT at, actor, note FROM events WHERE bounty_id = ? AND kind = 'progress' ORDER BY id DESC LIMIT 1");
    const unread = db.prepare("SELECT COUNT(*) c FROM events WHERE bounty_id = ? AND kind = 'message' AND read_at IS NULL");
    const attSel = db.prepare('SELECT * FROM attempts WHERE id = ?');

    const slots = board.cfg.slots.map(s => {
      const w = d ? d.slotWorker(s.id) : null;
      const base = { id: s.id, runner: s.runner, model: s.model || null, effort: s.effort || null };
      if (!w) return { ...base, state: d && d.spawning.has(s.id) ? 'spawning' : 'idle' };
      const b = bSel.get(w.bountyId);
      const a = attSel.get(w.attemptId) || {};
      const st = w.logPath ? this.follower.follow(w.logPath, newWorkerState, feedWorkerLine) : null;
      const view = workerView(st);
      const logAge = st && st.mtimeMs ? nowMs - st.mtimeMs : null;
      const tree = descendants(pt, w.pid);
      const pids = new Set([w.pid, ...tree.map(p => p.pid)]);
      const ownCi = ciRuns.filter(r => r.kind === 'worker' && (r.slot === s.id || pids.has(r.pid)));
      for (const r of ownCi) for (const x of descendants(pt, r.pid)) pids.add(x.pid);
      const waits = [...lockWaits(pt, tree, this.opts.lock_dir), ...ownCi.flatMap(r => r.waits)];
      for (const r of ownCi) if (r.ci && r.ci.waiting && !waits.some(x => x.lock === r.ci.waiting.lock)) waits.push({ lock: r.ci.waiting.lock, text: r.ci.waiting.text, from: 'ci log' });
      if (locks.stack.holder && locks.stack.holder.state === 'admitting' && holderOf(locks.stack, pids, b && b.worktree)) waits.push({ lock: 'memory', text: `stack gate admitted, waiting for MemAvailable >= ${locks.stack.holder.min_avail_gb} GB` });
      const usage = view ? view.usage : null;
      let costEst = null;
      if (usage && usage.cost_usd == null && s.runner === 'claude') {
        const rate = this.rateFor(a.model || s.model);
        if (rate) costEst = Math.round(weighted({ ...usage, tokens_out: usage.tokens_out_est }) * rate * 100) / 100;
      }
      const lp = b ? lastProgress.get(b.id) : null;
      const pendingTool = view && view.actions.length && view.actions[view.actions.length - 1].running ? view.actions[view.actions.length - 1] : null;
      return {
        ...base, state: 'working', pid: w.pid, alive: pidAlive(w.pid),
        bounty: b ? { id: b.id, title: b.title, type: b.type, tier: b.tier, priority: b.priority, status: b.status, ci_status: b.ci_status, review_state: b.review_state, branch: b.branch, worktree: b.worktree } : null,
        pipeline: b ? this.pipelineState(b) : null,
        attempt: { id: a.id, number: b ? b.attempts : null, started_at: a.started_at, elapsed_s: a.started_at ? Math.round((nowMs - Date.parse(a.started_at)) / 1000) : null, model: a.model, log: w.logPath },
        usage, cost_estimate_usd: costEst,
        progress: lp ? { at: lp.at, age_s: Math.round((nowMs - Date.parse(lp.at)) / 1000), note: lp.note } : null,
        unread_notes: b ? unread.get(b.id).c : 0,
        actions: view ? view.actions : [], last_text: view ? view.last_text : null,
        log_age_s: logAge != null ? Math.round(logAge / 1000) : null,
        possibly_stuck: logAge != null && logAge > stuckMs,
        pending_tool: pendingTool ? pendingTool.summary : null,
        own_ci: ownCi.map(r => ({ pid: r.pid, args: r.args, for_s: r.for_s, stage: r.ci && r.ci.stage, position: r.ci && r.ci.position, total: r.ci && r.ci.total, output: r.output })),
        waiting: waits,
        holds: { render: holderOf(locks.render, pids, b && b.worktree), stack: holderOf(locks.stack, pids, b && b.worktree) },
        procs: notableProcs(tree),
      };
    });
    this.follower.evict(); this.ciFollower.evict();

    // Bounties in the gates or waiting on a human/merge (whether or not a worker is live).
    const liveIds = new Set(slots.filter(s => s.bounty).map(s => s.bounty.id));
    const pipeline = db.prepare(`SELECT * FROM bounties WHERE (status = 'in_progress' AND ci_status = 'running') OR status IN ('review','approved')
      ORDER BY id`).all().map(b => ({
      id: b.id, title: b.title, tier: b.tier, priority: b.priority, status: b.status, slot: b.assignee_slot, live_worker: liveIds.has(b.id),
      ...this.pipelineState(b),
    }));

    // The queue: what each slot takes next, and everything ready.
    const ready = db.prepare(`SELECT id, title, tier, priority, type, assignee_slot, depends_on, project_id FROM bounties WHERE status = 'ready'
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, id`).all();
    const depOpen = db.prepare("SELECT id FROM bounties WHERE id = ? AND status != 'done'");
    const readyRows = ready.map(r => {
      let deps = []; try { deps = JSON.parse(r.depends_on || '[]'); } catch {}
      const waitingOn = deps.filter(x => depOpen.get(x)).map(Number);
      return { id: r.id, title: r.title, tier: r.tier, priority: r.priority, type: r.type, slot: r.assignee_slot, waiting_on: waitingOn };
    });
    const queue = board.cfg.slots.map(s => {
      const next = board.nextFor(s);
      return { slot: s.id, next: next ? { id: next.id, title: next.title, tier: next.tier, priority: next.priority } : null, ready: readyRows.filter(r => r.slot === s.id) };
    });
    const unassigned = readyRows.filter(r => !r.slot);
    const since = new Date(nowMs - this.opts.recent_hours * 3600000).toISOString();
    const recent = db.prepare(`SELECT id, title, tier, priority, status, credited_slot, assignee_slot, cost_usd, attempts, done_at, failed_at, blocked_reason
      FROM bounties WHERE (status = 'done' AND done_at >= ?) OR (status = 'failed' AND failed_at >= ?)
      ORDER BY COALESCE(done_at, failed_at) DESC LIMIT 40`).all(since, since)
      .map(r => ({ ...r, at: r.done_at || r.failed_at, slot: r.credited_slot || r.assignee_slot }));

    const verify = {
      concurrency: board.cfg.verify_concurrency, running: board.verifyRunning || 0,
      active: [...(board.verifyActive ? board.verifyActive.values() : [])].map(v => ({ id: v.id, started: v.started, log: v.logPath })),
      queue: (board.verifyQueue || []).map((j, i) => ({ id: j.id, position: i + 1 })),
    };

    return {
      at: new Date(nowMs).toISOString(), host: os.hostname(), paused: board.paused(),
      running: d ? d.running() : 0, cap: board.cfg.concurrency_cap, stuck_minutes: this.opts.stuck_minutes,
      slots, pipeline, verify, locks, memory: mem, tester,
      ci_runs: ciRuns.map(r => ({ ...r, bounty_title: r.bounty_id ? (bSel.get(r.bounty_id) || {}).title || null : null })),
      queue, unassigned_ready: unassigned, recent,
    };
  }
}

// ---------------------------------------------------------------- text rendering (bounty live)
function dur(s) {
  if (s == null || isNaN(s)) return '?';
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}
const ageOf = iso => (iso ? (Date.now() - Date.parse(iso)) / 1000 : null);
const tok = n => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n || 0));

function lockLine(l) {
  if (!l) return 'n/a';
  const h = l.holder;
  if (!l.held && !h) return 'free';
  if (l.stale) return `free (stale holder file: ${h.owner || '?'} ${h.what || ''})`;
  if (!h) return l.held ? 'HELD (no holder file)' : 'free';
  return `${l.held ? 'HELD' : 'held?'} by ${h.owner || '?'} (${h.kind || '?'}): ${h.what || '?'}${h.state ? ' [' + h.state + ']' : ''}, ${dur(h.since_s)}${h.worktree ? ' in ' + h.worktree : ''}`;
}

function renderText(L) {
  const out = [];
  const mem = L.memory || {};
  out.push(`LIVE ${L.at.slice(0, 19)}Z | ${L.paused ? 'PAUSED' : 'running'} ${L.running}/${L.cap} workers | MemAvailable ${mem.available_mb != null ? (mem.available_mb / 1024).toFixed(1) + ' GB' : '?'} of ${mem.total_mb != null ? Math.round(mem.total_mb / 1024) + ' GB' : '?'}`);
  out.push(`  render lock: ${lockLine(L.locks.render)}`);
  out.push(`  stack gate:  ${lockLine(L.locks.stack)}`);
  out.push('SLOTS');
  for (const s of L.slots) {
    if (s.state !== 'working') { out.push(`  ${s.id.padEnd(14)} ${s.state}`); continue; }
    const b = s.bounty || {};
    const cost = s.usage && s.usage.cost_usd != null ? `$${s.usage.cost_usd.toFixed(2)}` : s.cost_estimate_usd != null ? `~$${s.cost_estimate_usd.toFixed(2)}` : '$n/a';
    const u = s.usage || {};
    out.push(`  ${s.id.padEnd(14)} #${b.id} [${b.tier}/${b.priority}] ${b.title}`);
    out.push(`      attempt ${s.attempt.number} | ${s.pipeline ? s.pipeline.label : b.status} | ${dur(s.attempt.elapsed_s)} | ${tok(u.tokens_in + u.cache_read + u.cache_write)} in ${u.cost_usd != null ? tok(u.tokens_out) : '~' + tok(u.tokens_out_est)} out ${cost} | log ${dur(s.log_age_s)} ago${s.possibly_stuck ? ' POSSIBLY STUCK' : ''}${s.unread_notes ? ` | ${s.unread_notes} unread note(s)` : ''}`);
    if (s.progress) out.push(`      progress (${dur(s.progress.age_s)} ago): ${trunc(s.progress.note, 150)}`);
    for (const r of s.own_ci || []) out.push(`      own CI: ci.sh ${r.args} ${dur(r.for_s)}${r.stage ? ` at ${r.stage}${r.position ? ` (${r.position}/${r.total})` : ''}` : ''}`);
    if (s.pipeline && s.pipeline.verify && s.pipeline.verify.waiting) out.push(`      verify waiting: ${s.pipeline.verify.waiting.text}`);
    for (const w of s.waiting || []) {
      const h = w.lock === 'render' || w.lock === 'stack' ? L.locks[w.lock].holder : null;
      out.push(`      WAITING on ${w.lock === 'render' ? 'the UE render lock' : w.lock === 'stack' ? 'the UE stack gate' : w.lock}${w.text ? ': ' + w.text : ''}${h && !w.text ? ` (held by ${h.owner || '?'}: ${h.what || '?'})` : ''}`);
    }
    if (s.holds && (s.holds.render || s.holds.stack)) out.push(`      holds: ${[s.holds.render && 'render lock', s.holds.stack && 'stack gate'].filter(Boolean).join(', ')}`);
    for (const a of (s.actions || []).slice(-3)) out.push(`      ${a.running ? '>' : '-'} ${a.summary}${a.running && a.at ? ` (running ${dur(ageOf(a.at))})` : ''}`);
    if (s.last_text) out.push(`      says: ${trunc(s.last_text.text, 160)}`);
  }
  if (L.pipeline.length) {
    out.push('PIPELINE');
    for (const p of L.pipeline) out.push(`  #${p.id} ${trunc(p.title, 60)} | ${p.label}${p.slot ? ' | ' + p.slot : ''}${p.live_worker ? '' : ' (no live worker)'}`);
  }
  if (L.ci_runs.length) {
    out.push('CI RUNS');
    for (const r of L.ci_runs) {
      const who = r.kind === 'board-verify' ? `board verify #${r.bounty_id}` : r.kind === 'worker' ? `worker ${r.slot} #${r.bounty_id}` : 'other';
      const stage = r.ci && r.ci.stage ? `${r.ci.stage}${r.ci.position ? ` (${r.ci.position}/${r.ci.total})` : ''}` : '?';
      out.push(`  ${who.padEnd(24)} ci.sh ${r.args || ''} in ${r.cwd} | ${dur(r.for_s)} | stage ${stage}${r.waits.length ? ' | WAITING on ' + r.waits.map(w => w.lock).join(',') : ''}`);
    }
  }
  const t = L.tester;
  if (t) {
    out.push(`TESTER ${t.service}: ${t.running ? 'RUNNING' : t.active || '?'}${t.timer ? ` | timer ${t.timer_active || '?'}, next ${t.next_run ? t.next_run.slice(0, 16).replace('T', ' ') + 'Z' : '?'}` : ''}`);
    if (t.latest_line) out.push(`  last cycle log (${dur(ageOf(t.latest_log_mtime))} ago): ${trunc(t.latest_line, 160)}`);
  }
  out.push('QUEUE');
  for (const q of L.queue) if (q.next || q.ready.length) out.push(`  ${q.slot.padEnd(14)} next ${q.next ? `#${q.next.id} ${trunc(q.next.title, 60)}` : '-'}${q.ready.length > 1 ? ` (+${q.ready.length - 1} ready)` : ''}`);
  if (L.unassigned_ready.length) out.push(`  unassigned ready: ${L.unassigned_ready.map(r => '#' + r.id).join(' ')}`);
  if (!L.queue.some(q => q.next || q.ready.length) && !L.unassigned_ready.length) out.push('  (nothing ready)');
  out.push(`RECENT (24h): ${L.recent.length ? '' : 'none'}`);
  for (const r of L.recent.slice(0, 10)) out.push(`  ${r.status.padEnd(6)} #${r.id} ${trunc(r.title, 70)} ${r.slot ? '(' + r.slot + ')' : ''} ${dur(ageOf(r.at))} ago`);
  return out.join('\n');
}

module.exports = {
  Live, Follower, feedWorkerLine, newWorkerState, workerView, parseWorkerLog, summarizeTool,
  feedCiLine, newCiState, parseCiLog, isCiProc, ciStageLists, ciPlan, ciView, parseHolder, readLock, parsePs, lockWaits, renderText, dur,
};
