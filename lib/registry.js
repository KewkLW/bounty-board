// The board registry: every running board writes <registry_dir>/<port>.json on start and marks it
// stopped on a clean exit. The hub (hub/server.js) reads the directory on every request, so a board
// that starts later shows up without a hub restart. Default dir: $XDG_STATE_HOME/totally-not-a-kanban/boards.
const fs = require('fs');
const path = require('path');

const DEFAULT_ACCENT = '#7aa2f7';

// A themed board's accent: board.json "accent", else the first of --accent / --st-accent / --blue
// in the board's op.css or status.css, else the default theme's blue.
function accentOf(cfg, pub) {
  if (typeof cfg.accent === 'string' && cfg.accent.trim()) return cfg.accent.trim();
  for (const f of ['op.css', 'status.css']) {
    let css;
    try { css = fs.readFileSync(path.join(pub, f), 'utf8'); } catch { continue; }
    for (const v of ['--accent', '--st-accent', '--blue']) {
      const m = css.match(new RegExp(`${v}\\s*:\\s*(#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\))`));
      if (m) return m[1];
    }
  }
  return DEFAULT_ACCENT;
}

function fileFor(dir, port) { return path.join(dir, `${Number(port)}.json`); }

// Write via a temp file and rename, so the hub never reads a half-written file.
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// "my-garden_v2" -> "My Garden V2": what the hub shows when board.json has no "name".
const titleCase = id => String(id).split(/[-_\s]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

function entryFor(cfg, port, { name, defaultProject, publicDir } = {}) {
  const proj = defaultProject || cfg.default_project;
  return {
    // A project row's name equal to its id is no name at all: title-case the id instead.
    name: cfg.name || (name && name !== proj ? name : null) || (proj ? titleCase(proj) : null) || `Board ${port}`,
    port: Number(port),
    host: cfg.host || '0.0.0.0',
    default_project: defaultProject || cfg.default_project || null,
    public_dir: publicDir || null,
    accent: accentOf(cfg, publicDir || path.join(__dirname, '..', 'public')),
    pid: process.pid,
    started_at: new Date().toISOString(),
    stopped_at: null,
  };
}

function register(dir, entry) {
  writeAtomic(fileFor(dir, entry.port), entry);
  return entry;
}

// Mark stopped (kept so the hub shows the board as offline rather than forgetting it). Only the
// process that wrote the file marks it, so a stale board can never clobber a newer one on that port.
function unregister(dir, port, pid = process.pid) {
  const file = fileFor(dir, port);
  let cur;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (cur.pid !== pid) return;
  writeAtomic(file, { ...cur, stopped_at: new Date().toISOString() });
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Every registered board, sorted by port. Bad files are skipped; a missing dir is an empty list.
function list(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!e || !Number(e.port)) continue;
      out.push({ ...e, port: Number(e.port), stopped: !!e.stopped_at || (e.pid ? !pidAlive(e.pid) : false) });
    } catch {}
  }
  return out.sort((a, b) => a.port - b.port);
}

module.exports = { titleCase, register, unregister, list, entryFor, accentOf, fileFor, DEFAULT_ACCENT };
