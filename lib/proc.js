// Process identity from /proc, with no other dependency (the hub uses it too): a pid is "the same
// process" only while it runs and its start time (clock ticks since boot) matches the recorded one,
// so a pid the kernel has handed to someone else never counts.
const fs = require('fs');

// /proc/<pid>/stat: comm may hold spaces and parens, so split after the last ')'.
function procStat(pid) {
  let s;
  try { s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const comm = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
  const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
  const state = f[0];
  if (state === 'Z' || state === 'X') return null;
  return { pid: Number(pid), comm, state, ppid: Number(f[1]), pgrp: Number(f[2]), start_time: Number(f[19]) };
}

// The recorded process (pid + start time) is still the one running under that pid.
function sameProcess(pid, startTime) {
  if (!pid || startTime == null) return false;
  const st = procStat(pid);
  return !!st && st.start_time === Number(startTime);
}

module.exports = { procStat, sameProcess };
