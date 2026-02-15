#!/usr/bin/env node

/**
 * Wasteland Bounty Board - Agent Worker
 *
 * Runs inside a tmux session and continuously:
 * 1. Checks for available bounties
 * 2. Claims work matching its tier
 * 3. Reports progress
 * 4. Completes tasks with XP calculation
 *
 * Usage:
 *   AGENT_ID=opus-wsl-1 BOUNTY_BOARD_URL=http://localhost:3777 node agent-worker.js
 *
 * Environment:
 *   AGENT_ID            - Unique agent identifier
 *   BOUNTY_BOARD_URL    - URL to bounty board (default: http://localhost:3777)
 *   WORK_POLL_INTERVAL  - Check for work every N ms (default: 5000)
 *   WORK_TIMEOUT        - Timeout for work simulation (default: 10000)
 *   AGENT_MODEL         - Model type (opus, sonnet, haiku, codex, gemini)
 */

const { BountyBoardClient } = require('./agent-sdk');
const WebSocket = require('ws');

const AGENT_ID = process.env.AGENT_ID || 'agent-unknown';
const BOUNTY_BOARD_URL = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';
const POLL_INTERVAL = parseInt(process.env.WORK_POLL_INTERVAL || '5000');
const WORK_TIMEOUT = parseInt(process.env.WORK_TIMEOUT || '10000');
const MODEL = process.env.AGENT_MODEL || 'unknown';

// WebSocket for status updates
let ws = null;

/**
 * Model tier preferences (which tiers this model should target)
 */
const MODEL_PREFERENCES = {
  opus: { tiers: ['S', 'A'], types: ['task', 'bug'] },
  sonnet: { tiers: ['B', 'C', 'A'], types: ['task'] }, // No bugs
  haiku: { tiers: ['C', 'B'], types: ['task'] },
  codex: { tiers: ['S', 'A', 'B'], types: ['task', 'bug'] },
  gemini: { tiers: ['A', 'B'], types: ['task'] },
};

/**
 * Connect to WebSocket for status updates
 */
function connectWebSocket() {
  return new Promise((resolve) => {
    const wsUrl = BOUNTY_BOARD_URL.replace('http', 'ws');
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log(`[WS] Connected to server for status updates`);
      pushStatus('online');
      startHeartbeat();
      resolve();
    });

    ws.on('close', () => {
      console.log(`[WS] Disconnected from server`);
      setTimeout(connectWebSocket, 5000); // Reconnect after 5s
    });

    ws.on('error', (err) => {
      console.warn(`[WS] Connection error: ${err.message}`);
    });
  });
}

/**
 * Push status update to server
 */
function pushStatus(status, bountyId = null) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'agent:status:update',
      agentId: AGENT_ID,
      status: status,
      bountyId: bountyId,
      timestamp: Date.now()
    }));
  }
}

/**
 * Start sending heartbeats every 5 seconds
 */
function startHeartbeat() {
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'agent:heartbeat',
        agentId: AGENT_ID,
        timestamp: Date.now()
      }));
    }
  }, 5000);
}

/**
 * Simulate doing work (can be replaced with actual agent code)
 */
async function doWork(bounty) {
  console.log(`\n⚙️  Working on ${bounty.ticket_id}: "${bounty.title}"`);
  console.log(`   Tier: ${bounty.tier} | Reward: ${bounty.reward} XP`);

  const steps = [25, 50, 75, 100];
  for (let i = 0; i < steps.length - 1; i++) {
    await sleep(WORK_TIMEOUT / steps.length);
    console.log(`   Progress: ${steps[i]}%`);
  }

  console.log(`   ✅ Work complete!`);
}

/**
 * Main agent loop
 */
async function agentLoop() {
  const client = new BountyBoardClient(BOUNTY_BOARD_URL, AGENT_ID, {
    timeout: 15000,
    retryAttempts: 5,
    logger: createLogger(),
  });

  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║   WASTELAND AGENT WORKER              ║`);
  console.log(`║   ${AGENT_ID.padEnd(35)} ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);

  // Connect to WebSocket for status updates
  await connectWebSocket();

  // Get agent info
  try {
    const agent = await client.getAgent();
    console.log(`📊 Agent Stats:`);
    console.log(`   Loot: ${agent.total_loot} XP`);
    console.log(`   Missions: ${agent.missions_completed} completed, ${agent.missions_failed} failed`);
    console.log(`   Streak: ${agent.streak}\n`);
  } catch (err) {
    console.error(`Warning: Could not fetch agent stats:`, err.message);
  }

  // Main work loop
  let iteration = 0;
  while (true) {
    iteration++;

    try {
      const prefs = MODEL_PREFERENCES[MODEL] || { tiers: ['C', 'B', 'A', 'S'], types: ['task', 'bug'] };

      console.log(`\n[${new Date().toLocaleTimeString()}] Iteration ${iteration} - Looking for work...`);

      // Try to claim a bounty
      let bounty = null;

      // First try: high-tier preferred work
      if (prefs.types.includes('bug')) {
        for (const tier of prefs.tiers) {
          bounty = await client.claimAvailableBounty({ type: 'bug', tier });
          if (bounty) break;
        }
      }

      // Second try: tasks
      if (!bounty && prefs.types.includes('task')) {
        for (const tier of prefs.tiers) {
          bounty = await client.claimAvailableBounty({ type: 'task', tier });
          if (bounty) break;
        }
      }

      if (!bounty) {
        console.log(`ℹ️  No available bounties. Sleeping...`);
        pushStatus('idle');
        await sleep(POLL_INTERVAL);
        continue;
      }

      // Push status: active with bounty ID
      console.log(`✅ Claimed bounty #${bounty.id}!`);
      pushStatus('active', bounty.id);

      // Do the work
      await doWork(bounty);

      // Complete the bounty
      const completed = await client.completeBounty(bounty.id);
      console.log(`\n🎉 Completed! Earned ${completed.reward} XP (base: ${bounty.reward})`);

      // Push status: idle after completion
      pushStatus('idle');

      // Check leaderboard position
      const leaderboard = await client.getLeaderboard();
      const position = leaderboard.findIndex(a => a.id === AGENT_ID) + 1;
      console.log(`   Position: #${position} of ${leaderboard.length}`);
    } catch (err) {
      console.error(`\n❌ Error during work cycle:`, err.message);
      pushStatus('idle');

      // If we have an active bounty, mark it as failed
      // (In a real scenario, we'd track this better)
    }

    // Wait before next iteration
    await sleep(POLL_INTERVAL);
  }
}

/**
 * Create a logger that prefixes with agent ID
 */
function createLogger() {
  return {
    log: (msg) => console.log(`[${AGENT_ID}] ${msg}`),
    error: (msg) => console.error(`[${AGENT_ID}] ❌ ${msg}`),
    warn: (msg) => console.warn(`[${AGENT_ID}] ⚠️  ${msg}`),
  };
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Graceful shutdown
 */
process.on('SIGINT', () => {
  console.log(`\n\n✋ Agent shutting down gracefully...`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n\n✋ Agent terminated...`);
  process.exit(0);
});

// Start the agent
agentLoop().catch(err => {
  console.error(`Fatal error:`, err);
  process.exit(1);
});
