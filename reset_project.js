const db = require('better-sqlite3')('./bounty-board.db');

console.log('\n╔════════════════════════════════════════════╗');
console.log('║     RESETTING BOUNTY BOARD PROJECT        ║');
console.log('╚════════════════════════════════════════════╝\n');

// 1. Clear bounties first (foreign key constraint)
console.log('🗑️  Clearing all bounties...');
const bountyCount = db.prepare('SELECT COUNT(*) as count FROM bounties').get().count;
db.prepare('DELETE FROM bounties').run();
console.log(`   ✓ Deleted ${bountyCount} bounties`);

// 2. Clear agent status registry
console.log('\n🗑️  Clearing agent status registry...');
const statusCount = db.prepare('SELECT COUNT(*) as count FROM agent_status').get().count;
db.prepare('DELETE FROM agent_status').run();
console.log(`   ✓ Cleared ${statusCount} agent status entries`);

// 3. Clear event history
console.log('\n🗑️  Clearing event history...');
const eventCount = db.prepare('SELECT COUNT(*) as count FROM agent_events').get().count;
db.prepare('DELETE FROM agent_events').run();
console.log(`   ✓ Cleared ${eventCount} events`);

// 4. Delete old agents
console.log('\n🗑️  Deleting old agents (keeping new roster)...');
const oldAgents = db.prepare('SELECT name FROM agents WHERE name NOT IN (?, ?, ?, ?, ?)').all(
  'Opus-Conductor', 'Codex-Agent', 'Sonnet-Agent', 'Haiku-Agent', 'Gemini-Agent'
);
oldAgents.forEach(a => console.log(`   ✗ ${a.name}`));
db.prepare('DELETE FROM agents WHERE name NOT IN (?, ?, ?, ?, ?)').run(
  'Opus-Conductor', 'Codex-Agent', 'Sonnet-Agent', 'Haiku-Agent', 'Gemini-Agent'
);

// 5. Reset stats for new agents
console.log('\n📊 Resetting stats to 0 for new agents...');
db.prepare(`
  UPDATE agents 
  SET total_loot = 0, 
      missions_completed = 0, 
      missions_failed = 0,
      streak = 0,
      current_directive = NULL
  WHERE name IN (?, ?, ?, ?, ?)
`).run('Opus-Conductor', 'Codex-Agent', 'Sonnet-Agent', 'Haiku-Agent', 'Gemini-Agent');
console.log('   ✓ All new agents reset to 0 XP / 0 missions\n');

console.log('╔════════════════════════════════════════════╗');
console.log('║          RESET COMPLETE ✅               ║');
console.log('╚════════════════════════════════════════════╝\n');

// Verify
console.log('📊 NEW LEADERBOARD:');
const agents = db.prepare('SELECT name, level, total_loot, missions_completed FROM agents ORDER BY name').all();
agents.forEach(a => {
  console.log(`   ${a.name.padEnd(20)} Lvl ${a.level} | ${String(a.total_loot).padStart(6)} XP | ${a.missions_completed} missions`);
});

const bounties = db.prepare('SELECT COUNT(*) as count FROM bounties').get().count;
console.log(`\n📋 Bounties: ${bounties}`);

const statusCount2 = db.prepare('SELECT COUNT(*) as count FROM agent_status').get().count;
console.log(`📡 Agent Registry: ${statusCount2}\n`);
