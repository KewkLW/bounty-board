const db = require('better-sqlite3')('./bounty-board.db');

console.log('\n=== AGENTS IN REGISTRY ===');
db.prepare('SELECT agentId, status, isActive FROM agent_status ORDER BY agentId').all().forEach(a => {
  console.log(`${a.agentId.padEnd(25)} ${a.status.padEnd(10)} ${a.isActive ? 'ACTIVE' : 'inactive'}`);
});

console.log('\n=== BOUNTIES ===');
const bounties = db.prepare('SELECT COUNT(*) as count FROM bounties').get();
console.log(`Total bounties: ${bounties.count}`);
db.prepare('SELECT id, title, status FROM bounties LIMIT 10').all().forEach(b => {
  console.log(`  #${b.id} [${b.status}] ${b.title.substring(0,50)}`);
});

console.log('\n=== AGENT LEADERBOARD ===');
db.prepare('SELECT name, total_loot, missions_completed FROM agents ORDER BY total_loot DESC').all().forEach(a => {
  console.log(`${a.name.padEnd(25)} ${String(a.total_loot).padStart(6)} XP | ${a.missions_completed} missions`);
});
