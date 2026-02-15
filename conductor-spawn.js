#!/usr/bin/env node

/**
 * Wasteland Bounty Board - Conductor Agent Spawner
 *
 * The Conductor (Opus) spawns and manages agent sessions:
 * - Each agent runs in its own tmux session
 * - Agents auto-claim and complete bounties
 * - User can tmux into sessions to monitor
 *
 * Usage:
 *   node conductor-spawn.js spawn <model> [--wsl|--mac]
 *   node conductor-spawn.js list
 *   node conductor-spawn.js kill <model>
 *   node conductor-spawn.js attach <model>
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const { AgentRegistry } = require('./agent-registry');

const BOUNTY_BOARD_URL = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';

/**
 * Agent models and their configurations
 */
const AGENTS = {
  'opus': {
    name: 'Opus-Conductor',
    class: 'Conductor / Orchestrator',
    level: 9001,
    cmd_wsl: `claude --dangerously-skip-permissions --chrome codex --yolo`,
    cmd_mac: `claude --dangerously-skip-permissions --chrome codex --yolo`,
    session_prefix: 'opus-agent',
    max_instances: 1,
  },
  'sonnet': {
    name: 'Sonnet-Agent',
    class: 'Research / Testing',
    level: 42,
    cmd_wsl: `claude --dangerously-skip-permissions --chrome sonnet --yolo`,
    cmd_mac: `claude --dangerously-skip-permissions --chrome sonnet --yolo`,
    session_prefix: 'sonnet-agent',
    max_instances: 1,
  },
  'haiku': {
    name: 'Haiku-Agent',
    class: 'Research / Quick Tasks',
    level: 25,
    cmd_wsl: `claude --dangerously-skip-permissions --chrome haiku --yolo`,
    cmd_mac: `claude --dangerously-skip-permissions --chrome haiku --yolo`,
    session_prefix: 'haiku-agent',
    max_instances: 1,
  },
  'codex': {
    name: 'Codex-Agent',
    class: 'Coding / Research / Testing',
    level: 50,
    cmd_wsl: `codex --yolo --model gpt-5.3-codex --reasoning-effort high`,
    cmd_mac: `codex --yolo --model gpt-5.3-codex --reasoning-effort high`,
    session_prefix: 'codex-agent',
    max_instances: 1,
  },
  'gemini': {
    name: 'Gemini-Agent',
    class: 'Research / Coding',
    level: 38,
    cmd_wsl: `gemini --yolo`,
    cmd_mac: `gemini --yolo`,
    session_prefix: 'gemini-agent',
    max_instances: 1,
  },
};

/**
 * Execute a shell command
 */
function execAsync(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get the next available session number for a model
 */
async function getNextSessionNumber(model) {
  try {
    const result = await execAsync(`wsl bash -c ${JSON.stringify(`tmux list-sessions -F '#{session_name}' 2>/dev/null || echo ''`)}`);
    const sessions = result.stdout.split('\n').filter(s => s.startsWith(`${AGENTS[model].session_prefix}-`));
    return sessions.length + 1;
  } catch {
    return 1;
  }
}

/**
 * Check if a session already exists
 */
async function sessionExists(sessionName) {
  try {
    await execAsync(`wsl bash -c ${JSON.stringify(`tmux has-session -t ${sessionName} 2>/dev/null`)}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn an agent session on WSL
 */
async function spawnOnWSL(model, sessionName) {
  const registry = new AgentRegistry();
  const agentInfo = registry.getOrCreate(model, 'wsl');
  const agent = AGENTS[model];
  const agentId = agentInfo.agentId;

  console.log(`\n🚀 Spawning ${model.toUpperCase()} agent on WSL...`);
  console.log(`   Session: ${sessionName}`);
  console.log(`   Agent ID: ${agentId}`);

  // Create tmux session
  try {
    // Create the session with a name that shows the attach command (via WSL)
    const createCmd = `wsl bash -c ${JSON.stringify(`tmux new-session -d -s ${sessionName} -x 200 -y 50`)}`;
    await execAsync(createCmd);

    // Set the session title to show the connect command
    const titleCmd = `wsl bash -c ${JSON.stringify(`tmux set-option -t ${sessionName} set-titles-string 'tmux attach-session -t ${sessionName}'`)}`;
    await execAsync(titleCmd);

    // Send the model's CLI command to run in the session
    const sendCmd = `wsl bash -c ${JSON.stringify(`tmux send-keys -t ${sessionName} '${agent.cmd_wsl}' Enter`)}`;
    await sleep(500);
    await execAsync(sendCmd);

    console.log(`✅ Session created: ${sessionName}`);
    console.log(`   Location: WSL`);
    console.log(`   Connect: tmux attach-session -t ${sessionName}`);
    console.log(`   Model:   ${agent.name} (${agent.class})`);

    return {
      model,
      sessionName,
      agentId,
      platform: 'wsl',
      location: `localhost:tmux`,
      connectCmd: `tmux attach-session -t ${sessionName}`,
    };
  } catch (err) {
    console.error(`❌ Failed to spawn session:`, err.message);
    throw err;
  }
}

/**
 * Spawn an agent session on Mac (via SSH)
 */
async function spawnOnMac(model, sessionName) {
  const registry = new AgentRegistry();
  const agentInfo = registry.getOrCreate(model, 'mac');
  const agent = AGENTS[model];
  const agentId = agentInfo.agentId;

  console.log(`\n🚀 Spawning ${model.toUpperCase()} agent on Mac...`);
  console.log(`   Session: ${sessionName}`);
  console.log(`   Agent ID: ${agentId}`);

  try {
    const createCmd = `ssh mac ${JSON.stringify(`tmux new-session -d -s ${sessionName} -x 200 -y 50 -c ~/bounty-board`)}`;
    await execAsync(createCmd);

    // Set the session title
    const titleCmd = `ssh mac ${JSON.stringify(`tmux set-option -t ${sessionName} set-titles-string 'ssh mac tmux attach-session -t ${sessionName}'`)}`;
    await execAsync(titleCmd);

    // Send the command to the session
    await sleep(500);
    const agent_cmd = `ssh mac ${JSON.stringify(`tmux send-keys -t ${sessionName} '${agent.cmd_mac}' Enter`)}`;
    await execAsync(agent_cmd);

    console.log(`✅ Session created: ${sessionName}`);
    console.log(`   Location: Mac`);
    console.log(`   Connect: ssh mac "tmux attach-session -t ${sessionName}"`);
    console.log(`   Model:   ${agent.name} (${agent.class})`);

    return {
      model,
      sessionName,
      agentId,
      platform: 'mac',
      location: `mac:tmux`,
      connectCmd: `ssh mac "tmux attach-session -t ${sessionName}"`,
    };
  } catch (err) {
    console.error(`❌ Failed to spawn session:`, err.message);
    throw err;
  }
}

/**
 * Spawn an agent (automatically choose WSL)
 */
async function spawnAgent(model, options = {}) {
  model = model.toLowerCase();

  if (!AGENTS[model]) {
    console.error(`❌ Unknown model: ${model}`);
    console.log(`Available: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(1);
  }

  // Check if already running
  const sessionNum = await getNextSessionNumber(model);
  const sessionName = `${AGENTS[model].session_prefix}-${sessionNum}`;

  if (await sessionExists(sessionName) && sessionNum === 1) {
    console.log(`⚠️  Agent already running: ${sessionName}`);
    console.log(`   Max instances: ${AGENTS[model].max_instances}`);
    process.exit(1);
  }

  // Spawn on WSL by default
  const platform = options.mac ? 'mac' : 'wsl';

  try {
    let result;
    if (platform === 'mac') {
      result = await spawnOnMac(model, sessionName);
    } else {
      result = await spawnOnWSL(model, sessionName);
    }

    // Register agent with bounty board
    await registerAgent(result);

    return result;
  } catch (err) {
    console.error(`Error spawning agent:`, err.message);
    process.exit(1);
  }
}

/**
 * Register agent with the bounty board API
 */
async function registerAgent(agentInfo) {
  const agent = AGENTS[agentInfo.model];

  try {
    const response = await fetch(`${BOUNTY_BOARD_URL}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: agentInfo.agentId,
        name: agent.name,
        class: agent.class,
      }),
    });

    if (response.ok) {
      console.log(`✅ Agent registered with bounty board`);
    } else if (response.status === 409) {
      console.log(`ℹ️  Agent already registered`);
    } else {
      console.warn(`⚠️  Failed to register: ${response.status}`);
    }
  } catch (err) {
    console.warn(`⚠️  Could not register agent: ${err.message}`);
  }
}

/**
 * List active agent sessions
 */
async function listSessions() {
  console.log(`\n📡 ACTIVE AGENT SESSIONS\n`);

  try {
    const result = await execAsync(`wsl bash -c ${JSON.stringify(`tmux list-sessions -F '#{session_name}: #{session_window_count} windows' 2>/dev/null || echo 'No sessions'`)}`);

    const sessions = result.stdout
      .split('\n')
      .filter(line => line.includes('-agent-'))
      .sort();

    if (sessions.length === 0) {
      console.log('No active agent sessions.');
      return;
    }

    sessions.forEach(line => {
      const [name] = line.split(':');
      const model = Object.keys(AGENTS).find(m => name.includes(AGENTS[m].session_prefix));
      const modelName = model ? AGENTS[model].name : 'Unknown';
      console.log(`  ${name.padEnd(25)} [${modelName}]`);
      console.log(`    → tmux attach-session -t ${name}`);
    });
  } catch (err) {
    console.error(`Error listing sessions:`, err.message);
  }

  console.log('');
}

/**
 * Kill an agent session
 */
async function killSession(model) {
  model = model.toLowerCase();

  if (!AGENTS[model]) {
    console.error(`❌ Unknown model: ${model}`);
    process.exit(1);
  }

  const sessionName = `${AGENTS[model].session_prefix}-1`;

  try {
    const exists = await sessionExists(sessionName);
    if (!exists) {
      console.log(`No active session for ${model}`);
      return;
    }

    await execAsync(`wsl bash -c ${JSON.stringify(`tmux kill-session -t ${sessionName}`)}`);
    console.log(`✅ Killed session: ${sessionName}`);
  } catch (err) {
    console.error(`Error killing session:`, err.message);
  }
}

/**
 * Attach to an agent session
 */
async function attachSession(model) {
  model = model.toLowerCase();

  if (!AGENTS[model]) {
    console.error(`❌ Unknown model: ${model}`);
    process.exit(1);
  }

  const sessionName = `${AGENTS[model].session_prefix}-1`;

  try {
    const exists = await sessionExists(sessionName);
    if (!exists) {
      console.log(`❌ No active session for ${model}`);
      process.exit(1);
    }

    // Spawn tmux attach (blocks until user exits)
    // Use WSL wrapper for proper tmux access
    const child = spawn('wsl', ['tmux', 'attach-session', '-t', sessionName], {
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      process.exit(code);
    });
  } catch (err) {
    console.error(`Error attaching:`, err.message);
    process.exit(1);
  }
}

/**
 * Show help
 */
function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║   WASTELAND BOUNTY BOARD - Conductor Agent Spawner         ║
╚════════════════════════════════════════════════════════════╝

COMMANDS:

  spawn <model> [options]    Spawn a new agent session
    <model>                  opus, sonnet, haiku, codex, gemini
    --mac                    Spawn on Mac (default: WSL)
    --wsl                    Spawn on WSL

  list                       List all active agent sessions

  attach <model>             Attach to agent session

  kill <model>               Kill agent session

  help                       Show this message

EXAMPLES:

  # Spawn Opus agent on WSL
  node conductor-spawn.js spawn opus

  # Spawn Codex agent on Mac
  node conductor-spawn.js spawn codex --mac

  # List active sessions
  node conductor-spawn.js list

  # Attach to Opus session
  node conductor-spawn.js attach opus

  # Kill Sonnet session
  node conductor-spawn.js kill sonnet

AGENTS:

  opus   - Opus-Conductor (Level 9001) [Leader/Orchestrator]
  sonnet - Sonnet-Agent (Level 42) [Research/Testing]
  haiku  - Haiku-Agent (Level 25) [Research/Quick]
  codex  - Codex-Agent (Level 50) [Coding/Research]
  gemini - Gemini-Agent (Level 38) [Research/Coding]

SESSION NAMING:

  Sessions are named: {model}-agent-{number}
  Example: opus-agent-1, codex-agent-1

  Connect with: tmux attach-session -t {session-name}

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

  try {
    switch (command) {
      case 'spawn':
        if (!args[1]) {
          console.error('Usage: spawn <model> [--wsl|--mac]');
          process.exit(1);
        }
        const options = { mac: args.includes('--mac') };
        await spawnAgent(args[1], options);
        break;

      case 'list':
        await listSessions();
        break;

      case 'attach':
        if (!args[1]) {
          console.error('Usage: attach <model>');
          process.exit(1);
        }
        await attachSession(args[1]);
        break;

      case 'kill':
        if (!args[1]) {
          console.error('Usage: kill <model>');
          process.exit(1);
        }
        await killSession(args[1]);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.log(`Run with 'help' for usage information.`);
        process.exit(1);
    }
  } catch (err) {
    console.error(`Fatal error:`, err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { spawnAgent, listSessions, killSession, attachSession };
