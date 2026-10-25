// Board config: config/board.json (or $BOUNTY_CONFIG), paths resolved against the repo root.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function registryDir() {
  const state = process.env.XDG_STATE_HOME || path.join(require('os').homedir(), '.local', 'state');
  return path.join(state, 'totally-not-a-kanban', 'boards');
}

function load(file) {
  const cfgPath = path.resolve(file || process.env.BOUNTY_CONFIG || path.join(ROOT, 'config', 'board.json'));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const base = path.dirname(cfgPath) === path.join(ROOT, 'config') ? ROOT : path.dirname(cfgPath);
  const abs = p => (path.isAbsolute(p) ? p : path.resolve(base, p));
  cfg.config_path = cfgPath;
  cfg.root = ROOT;
  cfg.db_path = abs(process.env.BOUNTY_DB || cfg.db_path || 'data/bounty-board.db');
  cfg.logs_dir = abs(process.env.BOUNTY_LOGS || cfg.logs_dir || 'logs');
  // Where running boards register themselves so the hub (hub/server.js) can find them.
  cfg.registry_dir = abs(process.env.BOUNTY_REGISTRY_DIR || cfg.registry_dir || registryDir());
  // The agent manifest (run/agents.json) lives here; see lib/agents.js.
  cfg.run_dir = abs(process.env.BOUNTY_RUN_DIR || cfg.run_dir || 'run');
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  cfg.port = cfg.port ?? 3777;
  cfg.host = cfg.host || '0.0.0.0';
  cfg.concurrency_cap = cfg.concurrency_cap ?? 3;
  cfg.tick_seconds = cfg.tick_seconds ?? 5;
  cfg.watchdog = Object.assign({ stall_minutes: 30, check_seconds: 30, kill_grace_seconds: 15 }, cfg.watchdog);
  // Stopping an agent: SIGTERM, then SIGKILL after this many seconds (default: the watchdog grace, 15).
  cfg.stop_grace_seconds = cfg.stop_grace_seconds ?? cfg.watchdog.kill_grace_seconds;
  // No bounty in progress/review/approved (or paused) this long: stop every non-orchestrator agent. 0 disables.
  cfg.idle_shutdown_minutes = cfg.idle_shutdown_minutes ?? 120;
  cfg.retry = Object.assign({ max_attempts: 4, escalate_after_failures: 2, escalate_model: {} }, cfg.retry);
  cfg.leases = Object.assign({ default_ttl_minutes: 45 }, cfg.leases);
  cfg.merge_check_seconds = cfg.merge_check_seconds ?? 60;
  cfg.verify_concurrency = cfg.verify_concurrency ?? 1;
  cfg.reviewer = Object.assign({ runner: 'codex', timeout_minutes: 25, max_diff_chars: 160000, max_errors: 3 }, cfg.reviewer);
  cfg.runners = cfg.runners || {};
  cfg.slots = cfg.slots || [];
  // Core rule: every agent spawns with a specific, stable name for the project's
  // life (it tags the telemetry as agent.name). An unnamed slot is a config error.
  const unnamed = cfg.slots.filter(s => !s || typeof s.name !== 'string' || !s.name.trim());
  if (unnamed.length) throw new Error(`board.json: every slot needs a "name" (missing on ${unnamed.map(s => (s && s.id) || '?').join(', ')})`);
  const dupes = cfg.slots.map(s => s.name.trim()).filter((n, i, a) => a.indexOf(n) !== i);
  if (dupes.length) throw new Error(`board.json: slot names must be unique (${[...new Set(dupes)].join(', ')})`);
  for (const s of cfg.slots) s.name = s.name.trim();
  cfg.bin_dir = path.join(ROOT, 'bin');
  return cfg;
}

module.exports = { load, ROOT, registryDir };
