const db = require('better-sqlite3')('./bounty-board.db');

// Map new agents to the old avatar files (reusing the existing GIFs in public/avatars)
const avatarMap = {
  'Opus-Conductor': '/avatars/opus-leader.gif',      // Leader → Conductor
  'Codex-Agent': '/avatars/codex-wsl.gif',           // Codex-WSL → Codex-Agent
  'Sonnet-Agent': '/avatars/sonnet-coder.gif',       // Sonnet-Coder → Sonnet-Agent
  'Haiku-Agent': '/avatars/haiku-research.gif',      // Haiku-Research → Haiku-Agent
  'Gemini-Agent': '/avatars/gemini-wsl.gif',         // Gemini-WSL → Gemini-Agent
};

console.log('\n╔════════════════════════════════════════════╗');
console.log('║        ASSIGNING AGENT AVATARS            ║');
console.log('╚════════════════════════════════════════════╝\n');

Object.entries(avatarMap).forEach(([agent, avatarUrl]) => {
  db.prepare('UPDATE agents SET avatar_url = ? WHERE name = ?').run(avatarUrl, agent);
  console.log(`✓ ${agent.padEnd(20)} → ${avatarUrl}`);
});

console.log('\n✅ Avatars assigned!\n');

// Verify
const agents = db.prepare('SELECT name, avatar_url FROM agents ORDER BY name').all();
agents.forEach(a => {
  console.log(`${a.name.padEnd(20)} ${a.avatar_url || 'NO AVATAR'}`);
});
console.log('');
