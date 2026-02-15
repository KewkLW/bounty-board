const { db } = require('./db');

// Clear bounty agent references first, then agents
db.prepare("UPDATE bounties SET claimed_by = NULL").run();
db.prepare('DELETE FROM agents').run();

const insertAgent = db.prepare(`
  INSERT INTO agents (id, name, class, level, avatar_url, status, total_loot, missions_completed, missions_failed, current_directive, streak)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const agents = [
  ['opus-leader',     'Opus-Leader',      'Leader / Orchestrator',      9001, null, 'active',  98000, 320, 2,  'Coordinating all agent operations', 45],
  ['opus-coder',      'Opus-Coder',       'Heavy Coding / Debugging',   9001, null, 'active',  87500, 280, 5,  'Deep architecture refactor', 30],
  ['codex-wsl',       'Codex-WSL',        'Research / Search / Coding', 50,   null, 'active',  54000, 142, 3,  'Refactoring combat loop systems', 12],
  ['sonnet-coder',    'Sonnet-Coder',     'Low-Level Coding / Testing', 42,   null, 'active',  42300, 118, 8,  'Deploying Neural Net v2.1', 5],
  ['mac-research',    'Mac-Research',     'Research / Search / Coding', 40,   null, 'idle',    32000, 85,  7,  null, 0],
  ['sonnet-research', 'Sonnet-Research',  'Research / Analysis',        35,   null, 'idle',    28500, 72,  10, null, 0],
  ['gemini-wsl',      'Gemini-WSL',       'Research',                   38,   null, 'active',  38100, 95,  12, 'Scraping Sector 7 Data Nodes', 3],
  ['haiku-research',  'Haiku-Research',   'Research / Web Search',      25,   null, 'active',  18900, 48,  15, 'Scanning docs for API changes', 2],
];

const tx = db.transaction(() => {
  for (const a of agents) insertAgent.run(...a);
});
tx();

// Reassign bounties to real agents
db.prepare("UPDATE bounties SET claimed_by = 'sonnet-coder' WHERE ticket_id = 'TSK_3001'").run();
db.prepare("UPDATE bounties SET claimed_by = 'gemini-wsl' WHERE ticket_id = 'TSK_3002'").run();
db.prepare("UPDATE bounties SET claimed_by = 'codex-wsl' WHERE ticket_id = 'TSK_4001'").run();
db.prepare("UPDATE bounties SET claimed_by = 'sonnet-coder' WHERE ticket_id = 'ERR_0088'").run();
db.prepare("UPDATE bounties SET claimed_by = 'opus-coder' WHERE ticket_id = 'TSK_4002'").run();
db.prepare("UPDATE bounties SET claimed_by = 'codex-wsl' WHERE ticket_id = 'TSK_5001'").run();
db.prepare("UPDATE bounties SET claimed_by = 'haiku-research' WHERE ticket_id = 'ERR_0201'").run();

console.log('Agents updated successfully!');
const results = db.prepare('SELECT id, name, class, level, status, total_loot FROM agents ORDER BY total_loot DESC').all();
console.table(results);
