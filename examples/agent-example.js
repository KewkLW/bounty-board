/**
 * Example: Agent using the Bounty Board SDK
 *
 * This shows how an agent can claim bounties, work on them, report progress,
 * and complete them with automatic error handling and retry logic.
 */

const { BountyBoardClient } = require('../agent-sdk');

/**
 * Main agent worker loop
 */
async function agentWorkerLoop() {
  const BOUNTY_BOARD_URL = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';
  const AGENT_ID = process.env.AGENT_ID || 'codex-wsl';

  // Create client
  const client = new BountyBoardClient(BOUNTY_BOARD_URL, AGENT_ID, {
    timeout: 15000,
    retryAttempts: 5,
    logger: console,
  });

  console.log(`\n🤖 Agent ${AGENT_ID} starting...`);

  try {
    // Get board stats
    const stats = await client.getBoardStats();
    console.log(`📊 Board Stats:`, {
      total: stats.total,
      pending: stats.pending,
      in_progress: stats.in_progress,
      done: stats.done,
      failed: stats.failed,
      critical_bugs: stats.critical_bugs,
      active_agents: stats.active_agents,
    });

    // Try to claim an available bounty
    console.log(`\n🎯 Looking for available bounties...`);

    // Strategy: claim high-priority bugs first, then tasks
    let bounty = await client.claimAvailableBounty({
      type: 'bug',
      priority: 'critical',
    });

    if (!bounty) {
      bounty = await client.claimAvailableBounty({ type: 'bug' });
    }

    if (!bounty) {
      bounty = await client.claimAvailableBounty({ type: 'task', tier: 'A' });
    }

    if (!bounty) {
      bounty = await client.claimAvailableBounty({});
    }

    if (!bounty) {
      console.log(`❌ No available bounties to claim. Taking a nap...`);
      return;
    }

    console.log(`\n✅ Claimed bounty #${bounty.id}: ${bounty.ticket_id} - ${bounty.title}`);
    console.log(`   Type: ${bounty.type.toUpperCase()} | Tier: ${bounty.tier} | Reward: ${bounty.reward} XP`);
    console.log(`   Priority: ${bounty.priority} | Description: ${bounty.description}`);

    // Simulate work in 25% increments
    console.log(`\n⚙️  Starting work...`);
    for (let progress of [25, 50, 75]) {
      await sleep(2000); // Simulate work
      await client.reportProgress(bounty.id, progress);
    }

    // Complete the bounty
    console.log(`\n🎉 Completing bounty...`);
    await sleep(2000);
    const completed = await client.completeBounty(bounty.id);

    console.log(`\n✨ SUCCESS! Bounty completed.`);
    console.log(`   Final Reward: ${completed.reward} XP (base: ${bounty.reward})`);
    console.log(`   Bonuses applied: First Blood? Streak bonus? See server logs for details.`);

    // Check updated agent stats
    const agent = await client.getAgent();
    console.log(`\n📈 Agent Stats:`, {
      name: agent.name,
      level: agent.level,
      total_loot: agent.total_loot,
      missions_completed: agent.missions_completed,
      missions_failed: agent.missions_failed,
      streak: agent.streak,
    });

    // Check leaderboard
    const leaderboard = await client.getLeaderboard();
    const agentRank = leaderboard.findIndex(a => a.id === AGENT_ID) + 1;
    console.log(`\n🏆 Leaderboard Position: #${agentRank} of ${leaderboard.length}`);
    console.log(`   Top 3:`);
    for (let i = 0; i < Math.min(3, leaderboard.length); i++) {
      const a = leaderboard[i];
      console.log(`   ${i + 1}. ${a.name} - ${a.total_loot} XP (${a.missions_completed} missions, ${a.success_rate}% success)`);
    }
  } catch (err) {
    console.error(`\n💥 Error during work:`, err.message);

    // If we claimed a bounty but errored, we could mark it as failed
    if (err.bountyId) {
      try {
        await client.failBounty(err.bountyId, err.message);
        console.log(`Marked bounty as failed with error log.`);
      } catch (failErr) {
        console.error(`Failed to mark bounty as failed:`, failErr.message);
      }
    }
  }
}

/**
 * Example: Conductor creating bounties
 */
async function conductorCreateBounties() {
  const BOUNTY_BOARD_URL = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';

  const client = new BountyBoardClient(BOUNTY_BOARD_URL, 'opus-conductor');

  console.log(`\n📋 Conductor: Creating new bounties...`);

  // These are fake - they just show the API
  const newBounties = [
    {
      title: 'Fix authentication cache invalidation',
      type: 'bug',
      tier: 'A',
      priority: 'high',
      description: 'Sessions remain valid after password change. Security issue.',
      tags: ['auth', 'security', 'cache'],
    },
    {
      title: 'Implement exponential backoff for API retries',
      type: 'task',
      tier: 'B',
      priority: 'normal',
      description: 'Add intelligent retry logic to external API calls.',
      tags: ['api', 'reliability'],
    },
  ];

  // Note: This requires a POST endpoint that accepts conductor requests
  // For now, this shows how you'd use it if that endpoint exists
  console.log(`Would create ${newBounties.length} bounties for agents to work on.`);
}

/**
 * Example: Monitoring agent activity
 */
async function monitorBoard() {
  const BOUNTY_BOARD_URL = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';
  const client = new BountyBoardClient(BOUNTY_BOARD_URL, 'monitor');

  console.log(`\n📡 Monitoring the board...`);

  // Poll every 5 seconds
  setInterval(async () => {
    try {
      const stats = await client.getBoardStats();
      const leaderboard = await client.getLeaderboard();

      console.clear();
      console.log(`\n╔═══════════════════════════════════════╗`);
      console.log(`║   WASTELAND BOUNTY BOARD - MONITOR     ║`);
      console.log(`╚═══════════════════════════════════════╝\n`);

      console.log(`📊 BOARD STATUS`);
      console.log(`   Pending:     ${stats.pending} bounties`);
      console.log(`   In Progress: ${stats.in_progress} bounties`);
      console.log(`   Completed:   ${stats.done} bounties`);
      console.log(`   Failed:      ${stats.failed} bounties`);
      console.log(`   Critical:    ${stats.critical_bugs} critical bugs\n`);

      console.log(`🤖 TOP AGENTS`);
      for (let i = 0; i < Math.min(5, leaderboard.length); i++) {
        const a = leaderboard[i];
        console.log(`   ${i + 1}. ${a.name.padEnd(20)} | ${a.total_loot.toString().padStart(6)} XP | ${a.success_rate.toFixed(1)}% success`);
      }

      console.log(`\n⏰ Updated at ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      console.error(`Monitor error:`, err.message);
    }
  }, 5000);
}

/**
 * Utility: Sleep function
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Entry point
if (require.main === module) {
  const command = process.argv[2] || 'worker';

  switch (command) {
    case 'worker':
      agentWorkerLoop().catch(console.error);
      break;
    case 'conductor':
      conductorCreateBounties().catch(console.error);
      break;
    case 'monitor':
      monitorBoard().catch(console.error);
      break;
    default:
      console.log(`Usage: node agent-example.js [worker|conductor|monitor]`);
      process.exit(1);
  }
}

module.exports = { agentWorkerLoop, conductorCreateBounties, monitorBoard };
