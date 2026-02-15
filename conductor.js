#!/usr/bin/env node

/**
 * Wasteland Bounty Board - Conductor Agent Management
 *
 * The Conductor can manage agent status and control which agents are active.
 * Usage:
 *   node conductor.js list [active|all]
 *   node conductor.js deactivate <agentId>
 *   node conductor.js reactivate <agentId>
 *   node conductor.js history <agentId> [limit]
 *   node conductor.js status <agentId>
 */

const fetch = require('node-fetch');

const BOUNTY_BOARD_URL = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

const statusColors = {
  online: colors.green,
  active: colors.yellow,
  idle: colors.blue,
  offline: colors.red,
};

/**
 * List agents (active or all)
 */
async function listAgents(filter = 'active') {
  try {
    let url = `${BOUNTY_BOARD_URL}/api/agents/status/`;
    if (filter === 'active') {
      url += 'active';
    } else {
      url += 'all';
    }

    const res = await fetch(url);
    const agents = await res.json();

    if (agents.length === 0) {
      console.log(`${colors.gray}No agents found.${colors.reset}`);
      return;
    }

    console.log(`\n${colors.cyan}${colors.bright}📡 AGENT STATUS REPORT${colors.reset}`);
    console.log(`${colors.cyan}${'═'.repeat(80)}${colors.reset}\n`);

    // Header
    console.log(
      `${colors.bright}` +
      `${'Agent ID'.padEnd(25)} ` +
      `${'Status'.padEnd(12)} ` +
      `${'Active'.padEnd(8)} ` +
      `${'Current Work'.padEnd(15)} ` +
      `Last Seen` +
      `${colors.reset}`
    );
    console.log(`${colors.gray}${'-'.repeat(80)}${colors.reset}`);

    agents.forEach(agent => {
      const status = agent.status || 'offline';
      const statusColor = statusColors[status] || colors.gray;
      const activeStr = agent.isActive ? 'YES' : 'NO';
      const bountyStr = agent.currentBountyId ? `#${agent.currentBountyId}` : 'idle';
      const lastSeen = agent.lastSeen
        ? new Date(agent.lastSeen).toLocaleTimeString()
        : 'N/A';

      console.log(
        `${agent.agentId.padEnd(25)} ` +
        `${statusColor}${status.toUpperCase().padEnd(12)}${colors.reset} ` +
        `${activeStr.padEnd(8)} ` +
        `${bountyStr.padEnd(15)} ` +
        `${lastSeen}`
      );
    });

    console.log(`${colors.cyan}${'═'.repeat(80)}${colors.reset}\n`);

    // Summary
    const total = agents.length;
    const online = agents.filter(a => a.status && a.status !== 'offline').length;
    const active = agents.filter(a => a.status === 'active').length;
    const idle = agents.filter(a => a.status === 'idle').length;
    const offline = agents.filter(a => !a.status || a.status === 'offline').length;

    console.log(`${colors.bright}SUMMARY:${colors.reset}`);
    console.log(`  Total:    ${total}`);
    console.log(`  ${colors.green}Online:${colors.reset}   ${online}`);
    console.log(`  ${colors.yellow}Active:${colors.reset}   ${active}`);
    console.log(`  ${colors.blue}Idle:${colors.reset}     ${idle}`);
    console.log(`  ${colors.red}Offline:${colors.reset}  ${offline}`);
    console.log('');
  } catch (err) {
    console.error(`${colors.red}❌ Error fetching agents:${colors.reset}`, err.message);
  }
}

/**
 * Get detailed status for a specific agent
 */
async function getAgentStatus(agentId) {
  try {
    const res = await fetch(`${BOUNTY_BOARD_URL}/api/agents/${agentId}/status`);
    if (!res.ok) {
      console.error(`${colors.red}❌ Agent not found: ${agentId}${colors.reset}`);
      return;
    }

    const agent = await res.json();
    const statusColor = statusColors[agent.status || 'offline'] || colors.gray;

    console.log(`\n${colors.cyan}${colors.bright}🤖 AGENT DETAILS${colors.reset}`);
    console.log(`${colors.cyan}${'═'.repeat(60)}${colors.reset}\n`);
    console.log(`Agent ID:        ${colors.bright}${agent.agentId}${colors.reset}`);
    console.log(`Status:          ${statusColor}${(agent.status || 'offline').toUpperCase()}${colors.reset}`);
    console.log(`Active:          ${agent.isActive ? `${colors.green}YES${colors.reset}` : `${colors.red}NO${colors.reset}`}`);
    console.log(`Current Bounty:  ${agent.currentBountyId ? `#${agent.currentBountyId}` : 'None'}`);
    console.log(`Last Seen:       ${new Date(agent.lastSeen).toLocaleString()}`);
    console.log(`Created At:      ${new Date(agent.createdAt).toLocaleString()}`);
    console.log(`${colors.cyan}${'═'.repeat(60)}${colors.reset}\n`);
  } catch (err) {
    console.error(`${colors.red}❌ Error fetching agent status:${colors.reset}`, err.message);
  }
}

/**
 * Deactivate an agent
 */
async function deactivateAgent(agentId) {
  try {
    const res = await fetch(`${BOUNTY_BOARD_URL}/api/agents/${agentId}/deactivate`, {
      method: 'POST',
    });

    if (!res.ok) {
      console.error(`${colors.red}❌ Failed to deactivate agent: ${agentId}${colors.reset}`);
      return;
    }

    const agent = await res.json();
    console.log(`${colors.green}✅ Agent deactivated: ${agentId}${colors.reset}`);
    console.log(`   Status: ${colors.red}OFFLINE${colors.reset}`);
  } catch (err) {
    console.error(`${colors.red}❌ Error deactivating agent:${colors.reset}`, err.message);
  }
}

/**
 * Reactivate an agent
 */
async function reactivateAgent(agentId) {
  try {
    const res = await fetch(`${BOUNTY_BOARD_URL}/api/agents/${agentId}/reactivate`, {
      method: 'POST',
    });

    if (!res.ok) {
      console.error(`${colors.red}❌ Failed to reactivate agent: ${agentId}${colors.reset}`);
      return;
    }

    const agent = await res.json();
    console.log(`${colors.green}✅ Agent reactivated: ${agentId}${colors.reset}`);
    console.log(`   Status: ${colors.green}ONLINE${colors.reset}`);
  } catch (err) {
    console.error(`${colors.red}❌ Error reactivating agent:${colors.reset}`, err.message);
  }
}

/**
 * Show agent event history
 */
async function getAgentHistory(agentId, limit = 50) {
  try {
    const res = await fetch(`${BOUNTY_BOARD_URL}/api/agents/${agentId}/events?limit=${limit}`);
    if (!res.ok) {
      console.error(`${colors.red}❌ Agent not found: ${agentId}${colors.reset}`);
      return;
    }

    const events = await res.json();

    console.log(`\n${colors.cyan}${colors.bright}📜 AGENT EVENT HISTORY${colors.reset}`);
    console.log(`${colors.cyan}Agent: ${agentId} | Events: ${events.length}${colors.reset}`);
    console.log(`${colors.cyan}${'═'.repeat(80)}${colors.reset}\n`);

    if (events.length === 0) {
      console.log(`${colors.gray}No events found.${colors.reset}\n`);
      return;
    }

    // Header
    console.log(
      `${colors.bright}` +
      `${'Time'.padEnd(20)} ` +
      `${'Status'.padEnd(12)} ` +
      `${'Bounty'.padEnd(12)} ` +
      `Reason` +
      `${colors.reset}`
    );
    console.log(`${colors.gray}${'-'.repeat(80)}${colors.reset}`);

    events.forEach(event => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const statusColor = statusColors[event.status] || colors.gray;
      const bountyStr = event.bountyId ? `#${event.bountyId}` : '-';
      const reason = event.reason || '-';

      console.log(
        `${time.padEnd(20)} ` +
        `${statusColor}${event.status.toUpperCase().padEnd(12)}${colors.reset} ` +
        `${bountyStr.padEnd(12)} ` +
        `${reason}`
      );
    });

    console.log(`${colors.cyan}${'═'.repeat(80)}${colors.reset}\n`);
  } catch (err) {
    console.error(`${colors.red}❌ Error fetching agent history:${colors.reset}`, err.message);
  }
}

/**
 * Show help
 */
function showHelp() {
  console.log(`
${colors.cyan}${colors.bright}╔════════════════════════════════════════════╗${colors.reset}
${colors.cyan}║ WASTELAND BOUNTY BOARD - CONDUCTOR CONTROL ║${colors.reset}
${colors.cyan}╚════════════════════════════════════════════╝${colors.reset}

${colors.bright}COMMANDS:${colors.reset}

  ${colors.bright}list${colors.reset} [active|all]        List agents
    active               Show only active agents (default)
    all                  Show all agents

  ${colors.bright}status${colors.reset} <agentId>          Get detailed agent status

  ${colors.bright}deactivate${colors.reset} <agentId>      Deactivate an agent (goes offline)

  ${colors.bright}reactivate${colors.reset} <agentId>      Reactivate a deactivated agent

  ${colors.bright}history${colors.reset} <agentId> [n]    Show agent event history
    [n]                  Limit to last N events (default: 50)

  ${colors.bright}help${colors.reset}                      Show this message

${colors.bright}EXAMPLES:${colors.reset}

  # List active agents
  node conductor.js list active

  # Show all agents including offline
  node conductor.js list all

  # Get status of specific agent
  node conductor.js status opus-wsl-1

  # Deactivate an agent
  node conductor.js deactivate opus-wsl-1

  # Reactivate a deactivated agent
  node conductor.js reactivate opus-wsl-1

  # Show agent history
  node conductor.js history codex-agent-1 100

${colors.bright}AGENT STATES:${colors.reset}

  ${colors.green}ONLINE${colors.reset}     - Agent connected and ready
  ${colors.yellow}ACTIVE${colors.reset}     - Agent working on a bounty
  ${colors.blue}IDLE${colors.reset}       - Agent waiting for work
  ${colors.red}OFFLINE${colors.reset}    - Agent disconnected or deactivated

`);
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help') {
    showHelp();
    return;
  }

  switch (command) {
    case 'list':
      await listAgents(args[1] || 'active');
      break;

    case 'status':
      if (!args[1]) {
        console.error(`${colors.red}Usage: status <agentId>${colors.reset}`);
        process.exit(1);
      }
      await getAgentStatus(args[1]);
      break;

    case 'deactivate':
      if (!args[1]) {
        console.error(`${colors.red}Usage: deactivate <agentId>${colors.reset}`);
        process.exit(1);
      }
      await deactivateAgent(args[1]);
      break;

    case 'reactivate':
      if (!args[1]) {
        console.error(`${colors.red}Usage: reactivate <agentId>${colors.reset}`);
        process.exit(1);
      }
      await reactivateAgent(args[1]);
      break;

    case 'history':
      if (!args[1]) {
        console.error(`${colors.red}Usage: history <agentId> [limit]${colors.reset}`);
        process.exit(1);
      }
      await getAgentHistory(args[1], parseInt(args[2]) || 50);
      break;

    default:
      console.error(`${colors.red}Unknown command: ${command}${colors.reset}`);
      console.log(`Run with 'help' for usage information.`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, err.message);
  process.exit(1);
});
