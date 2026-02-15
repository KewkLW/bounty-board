#!/usr/bin/env node

/**
 * Wasteland Bounty Board - CLI Tool for Conductor
 *
 * Create, list, and manage bounties from the command line.
 *
 * Usage:
 *   node bounty-cli.js list [--type bug|task] [--status pending|in_progress|done|failed]
 *   node bounty-cli.js create <title> --type bug|task [--tier S|A|B|C] [--priority critical|high|normal|low] [--desc "..."]
 *   node bounty-cli.js view <bounty-id>
 *   node bounty-cli.js complete <bounty-id>
 *   node bounty-cli.js fail <bounty-id> [--error "..."]
 *   node bounty-cli.js stats
 *   node bounty-cli.js leaderboard
 */

const http = require('http');
const https = require('https');

const BOUNTY_BOARD_URL = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';
const CONDUCTOR_ID = 'opus-conductor';

/**
 * Make HTTP request
 */
async function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BOUNTY_BOARD_URL);
    const isHttps = BOUNTY_BOARD_URL.startsWith('https://');
    const client = isHttps ? https : http;

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BountyBoardCLI/1.0',
      },
      timeout: 10000,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: data ? JSON.parse(data) : null,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Parse command-line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const command = args[0];
  const positional = [];
  const flags = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      let value = true;
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        value = args[i + 1];
        i++;
      }
      flags[key] = value;
    } else {
      positional.push(args[i]);
    }
  }

  return { command, positional, flags };
}

/**
 * Format a bounty for display
 */
function formatBounty(b) {
  const status = {
    pending: '📋',
    in_progress: '⚙️ ',
    done: '✅',
    failed: '❌',
  }[b.status] || '❓';

  const type = b.type === 'bug' ? '🐛' : '📦';
  const reward = b.reward ? `${b.reward}XP`.padStart(6) : '-----';

  const agent = b.agent_name ? `[${b.agent_name}]` : '[unclaimed]';

  return `${status} ${type} #${String(b.id).padStart(4)} ${b.ticket_id.padEnd(10)} ${reward} | ${b.title.substring(0, 50).padEnd(50)} | ${b.tier} ${agent}`;
}

/**
 * List bounties
 */
async function listBounties(flags) {
  try {
    const params = new URLSearchParams();
    if (flags.type) params.append('type', flags.type);
    if (flags.status) params.append('status', flags.status);

    const path = `/api/bounties${params.toString() ? '?' + params.toString() : ''}`;
    const res = await request('GET', path);

    if (res.status !== 200) throw new Error(res.body.error || 'Failed to list bounties');

    const bounties = res.body;
    if (bounties.length === 0) {
      console.log('No bounties found.');
      return;
    }

    console.log(`\n📜 BOUNTIES (${bounties.length})\n`);
    bounties.forEach(b => console.log(formatBounty(b)));
    console.log('');
  } catch (err) {
    console.error(`❌ Error:`, err.message);
    process.exit(1);
  }
}

/**
 * Create a bounty
 */
async function createBounty(positional, flags) {
  try {
    if (positional.length === 0) {
      console.error('Usage: bounty-cli.js create <title> --type bug|task [options]');
      process.exit(1);
    }

    if (!flags.type) {
      console.error('Error: --type bug|task is required');
      process.exit(1);
    }

    // Check for active agents
    let activeAgentCount = 0;
    try {
      const agentsRes = await request('GET', '/api/agents/status/active');
      if (agentsRes.status === 200) {
        activeAgentCount = agentsRes.body.length || 0;
      }
    } catch (err) {
      // Silent fail - agents check is informational only
    }

    const body = {
      title: positional.join(' '),
      type: flags.type,
      tier: flags.tier || 'C',
      priority: flags.priority || 'normal',
      description: flags.desc || '',
      tags: flags.tags ? flags.tags.split(',').map(t => t.trim()) : [],
    };

    const res = await request('POST', '/api/bounties', body);

    if (res.status !== 201) throw new Error(res.body.error || 'Failed to create bounty');

    const bounty = res.body;
    console.log(`\n✅ Bounty created!\n`);
    console.log(formatBounty(bounty));
    console.log(`\n  ID: ${bounty.id}`);
    console.log(`  Ticket: ${bounty.ticket_id}`);
    console.log(`  Reward: ${bounty.reward} XP`);

    // Warning if no active agents
    if (activeAgentCount === 0) {
      console.log(`\n  ⚠️  WARNING: No active agents available`);
      console.log(`  Bounty created but no agents will claim it.`);
      console.log(`  Use 'conductor.js list' to check agent status.\n`);
    } else {
      console.log(`\n  ✅ Available agents: ${activeAgentCount}\n`);
    }
  } catch (err) {
    console.error(`❌ Error:`, err.message);
    process.exit(1);
  }
}

/**
 * View bounty details
 */
async function viewBounty(positional) {
  try {
    if (positional.length === 0) {
      console.error('Usage: bounty-cli.js view <bounty-id>');
      process.exit(1);
    }

    const bountyId = positional[0];
    const res = await request('GET', `/api/bounties`);

    if (res.status !== 200) throw new Error('Failed to fetch bounties');

    const bounty = res.body.find(b => b.id === parseInt(bountyId));
    if (!bounty) {
      console.error(`Bounty ${bountyId} not found`);
      process.exit(1);
    }

    console.log(`\n📋 BOUNTY #${bounty.id}\n`);
    console.log(`  Ticket:     ${bounty.ticket_id}`);
    console.log(`  Title:      ${bounty.title}`);
    console.log(`  Type:       ${bounty.type.toUpperCase()}`);
    console.log(`  Tier:       ${bounty.tier}`);
    console.log(`  Priority:   ${bounty.priority}`);
    console.log(`  Status:     ${bounty.status}`);
    console.log(`  Reward:     ${bounty.reward} XP`);
    console.log(`  Progress:   ${bounty.progress || 0}%`);
    console.log(`  Claimed By: ${bounty.agent_name || 'Not claimed'}`);

    if (bounty.description) {
      console.log(`  Description: ${bounty.description}`);
    }

    if (bounty.tags && bounty.tags.length > 0) {
      console.log(`  Tags:       ${bounty.tags.join(', ')}`);
    }

    if (bounty.error_log) {
      console.log(`  Error Log:  ${bounty.error_log}`);
    }

    if (bounty.claimed_at) {
      console.log(`  Claimed At: ${new Date(bounty.claimed_at).toLocaleString()}`);
    }

    if (bounty.completed_at) {
      console.log(`  Completed:  ${new Date(bounty.completed_at).toLocaleString()}`);
    }

    console.log('');
  } catch (err) {
    console.error(`❌ Error:`, err.message);
    process.exit(1);
  }
}

/**
 * Complete a bounty
 */
async function completeBounty(positional) {
  try {
    if (positional.length === 0) {
      console.error('Usage: bounty-cli.js complete <bounty-id>');
      process.exit(1);
    }

    const bountyId = positional[0];
    const res = await request('POST', `/api/bounties/${bountyId}/complete`);

    if (res.status !== 200) throw new Error(res.body.error || 'Failed to complete bounty');

    console.log(`\n✅ Bounty #${bountyId} completed!`);
    console.log(`   Final Reward: ${res.body.reward} XP\n`);
  } catch (err) {
    console.error(`❌ Error:`, err.message);
    process.exit(1);
  }
}

/**
 * Fail a bounty
 */
async function failBounty(positional, flags) {
  try {
    if (positional.length === 0) {
      console.error('Usage: bounty-cli.js fail <bounty-id> [--error "..."]');
      process.exit(1);
    }

    const bountyId = positional[0];
    const res = await request('POST', `/api/bounties/${bountyId}/fail`, {
      error_log: flags.error || 'Failed by conductor',
    });

    if (res.status !== 200) throw new Error(res.body.error || 'Failed to fail bounty');

    console.log(`\n❌ Bounty #${bountyId} marked as failed.`);
    console.log(`   Botch penalty applied.\n`);
  } catch (err) {
    console.error(`❌ Error:`, err.message);
    process.exit(1);
  }
}

/**
 * Show board statistics
 */
async function showStats() {
  try {
    const res = await request('GET', '/api/bounties/stats');

    if (res.status !== 200) throw new Error('Failed to get stats');

    const stats = res.body;

    console.log(`\n📊 BOARD STATISTICS\n`);
    console.log(`  Total Bounties:    ${stats.total}`);
    console.log(`  Pending:           ${stats.pending}`);
    console.log(`  In Progress:       ${stats.in_progress}`);
    console.log(`  Completed:         ${stats.done}`);
    console.log(`  Failed:            ${stats.failed}`);
    console.log(`  Critical Bugs:     ${stats.critical_bugs}`);
    console.log(`  Total Loot Earned: ${stats.total_loot_earned} XP`);
    console.log(`  Active Agents:     ${stats.active_agents}/${stats.total_agents}\n`);
  } catch (err) {
    console.error(`❌ Error:`, err.message);
    process.exit(1);
  }
}

/**
 * Show leaderboard
 */
async function showLeaderboard() {
  try {
    const res = await request('GET', '/api/agents/leaderboard');

    if (res.status !== 200) throw new Error('Failed to get leaderboard');

    const agents = res.body;

    console.log(`\n🏆 AGENT LEADERBOARD\n`);

    agents.forEach((agent, idx) => {
      const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '  ';
      console.log(
        `${medal} #${String(idx + 1).padStart(2)} ${agent.name.padEnd(25)} | ${String(agent.total_loot).padStart(6)} XP | ${agent.missions_completed} missions | ${agent.success_rate.toFixed(1)}% success`
      );
    });

    console.log('');
  } catch (err) {
    console.error(`❌ Error:`, err.message);
    process.exit(1);
  }
}

/**
 * Show help
 */
function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   WASTELAND BOUNTY BOARD - Conductor CLI                   ║
╚════════════════════════════════════════════════════════════╝

COMMANDS:

  list [options]           List bounties
    --type bug|task        Filter by type
    --status STATUS        Filter by status (pending, in_progress, done, failed)

  create <title> [options] Create a new bounty
    --type bug|task        (required) Type of bounty
    --tier S|A|B|C         (default: C) Bounty tier
    --priority PRI         (default: normal) Priority level
    --desc "..."           Description
    --tags "tag1,tag2"     Comma-separated tags

  view <id>                View bounty details

  complete <id>            Mark bounty as completed

  fail <id> [--error "..."] Mark bounty as failed

  stats                    Show board statistics

  leaderboard              Show agent leaderboard

  help                     Show this message

EXAMPLES:

  node bounty-cli.js list --status pending
  node bounty-cli.js create "Fix crash on startup" --type bug --tier A --priority critical
  node bounty-cli.js view 5
  node bounty-cli.js stats
  node bounty-cli.js leaderboard

ENVIRONMENT:

  BOUNTY_BOARD_URL         Override default URL (default: http://localhost:3777)

`);
}

/**
 * Main entry point
 */
async function main() {
  const { command, positional, flags } = parseArgs();

  if (!command || command === 'help') {
    showHelp();
    return;
  }

  switch (command) {
    case 'list':
      await listBounties(flags);
      break;
    case 'create':
      await createBounty(positional, flags);
      break;
    case 'view':
      await viewBounty(positional);
      break;
    case 'complete':
      await completeBounty(positional);
      break;
    case 'fail':
      await failBounty(positional, flags);
      break;
    case 'stats':
      await showStats();
      break;
    case 'leaderboard':
      await showLeaderboard();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.log(`Run with 'help' for usage information.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Fatal error:`, err.message);
  process.exit(1);
});
