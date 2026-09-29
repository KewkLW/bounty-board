// Board config: config/board.json (or $BOUNTY_CONFIG), paths resolved against the repo root.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function load(file) {
  const cfgPath = path.resolve(file || process.env.BOUNTY_CONFIG || path.join(ROOT, 'config', 'board.json'));
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const base = path.dirname(cfgPath) === path.join(ROOT, 'config') ? ROOT : path.dirname(cfgPath);
  const abs = p => (path.isAbsolute(p) ? p : path.resolve(base, p));
  cfg.config_path = cfgPath;
  cfg.root = ROOT;
  cfg.db_path = abs(process.env.BOUNTY_DB || cfg.db_path || 'data/bounty-board.db');
  cfg.logs_dir = abs(process.env.BOUNTY_LOGS || cfg.logs_dir || 'logs');
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  cfg.port = cfg.port || 3777;
  cfg.host = cfg.host || '0.0.0.0';
  cfg.concurrency_cap = cfg.concurrency_cap ?? 3;
  cfg.tick_seconds = cfg.tick_seconds ?? 5;
  cfg.watchdog = Object.assign({ stall_minutes: 30, check_seconds: 30, kill_grace_seconds: 15 }, cfg.watchdog);
  cfg.retry = Object.assign({ max_attempts: 4, escalate_after_failures: 2, escalate_model: {} }, cfg.retry);
  cfg.leases = Object.assign({ default_ttl_minutes: 45 }, cfg.leases);
  cfg.merge_check_seconds = cfg.merge_check_seconds ?? 60;
  cfg.verify_concurrency = cfg.verify_concurrency ?? 1;
  cfg.reviewer = Object.assign({ runner: 'codex', timeout_minutes: 25, max_diff_chars: 160000, max_errors: 3 }, cfg.reviewer);
  cfg.runners = cfg.runners || {};
  cfg.slots = cfg.slots || [];
  cfg.bin_dir = path.join(ROOT, 'bin');
  return cfg;
}

module.exports = { load, ROOT };
