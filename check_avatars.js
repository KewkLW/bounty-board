const db = require('better-sqlite3')('./bounty-board.db');

console.log('\nCurrent agents:');
const agents = db.prepare('SELECT name, avatar_url FROM agents').all();
agents.forEach(a => {
  console.log(`  ${a.name}: ${a.avatar_url || 'NO AVATAR'}`);
});
