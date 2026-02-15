#!/usr/bin/env node

/**
 * Wasteland Bounty Board - Agent Registry
 *
 * Maintains a persistent registry of spawned agents to ensure:
 * 1. Agent IDs are deterministic and reusable
 * 2. Same agent name every time it's spawned
 * 3. Consistent identification across restarts
 *
 * Registry file: .agent-registry.json
 *
 * Usage:
 *   const registry = new AgentRegistry();
 *   const agent = registry.getOrCreate('opus', 'wsl');
 */

const fs = require('fs');
const path = require('path');

class AgentRegistry {
  constructor(registryPath = path.join(__dirname, '.agent-registry.json')) {
    this.registryPath = registryPath;
    this.registry = this.load();
  }

  /**
   * Load registry from disk
   */
  load() {
    try {
      if (fs.existsSync(this.registryPath)) {
        const data = fs.readFileSync(this.registryPath, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      console.warn(`⚠️  Could not load registry: ${err.message}`);
    }
    return { agents: {}, nextId: {} };
  }

  /**
   * Save registry to disk
   */
  save() {
    try {
      fs.writeFileSync(this.registryPath, JSON.stringify(this.registry, null, 2));
    } catch (err) {
      console.error(`❌ Failed to save registry: ${err.message}`);
    }
  }

  /**
   * Get or create an agent entry
   * Ensures same name every time for a given model/platform combo
   *
   * @param {string} model - Model type (opus, codex, sonnet, haiku, gemini)
   * @param {string} platform - Platform (wsl, mac)
   * @returns {object} Agent info { agentId, agentName, sessionName, model, platform }
   */
  getOrCreate(model, platform) {
    const key = `${model}-${platform}`;

    // Check if already registered
    if (this.registry.agents[key]) {
      return this.registry.agents[key];
    }

    // Get next instance number for this model
    if (!this.registry.nextId[model]) {
      this.registry.nextId[model] = 1;
    }

    const instanceNum = this.registry.nextId[model];
    const agentId = `${model}-${platform}-${instanceNum}`;

    // Build agent name based on model
    const agentNames = {
      opus: 'Opus-Conductor',
      codex: 'Codex-Agent',
      sonnet: 'Sonnet-Agent',
      haiku: 'Haiku-Agent',
      gemini: 'Gemini-Agent',
    };

    const agentName = agentNames[model] || `${model}-Agent`;
    const sessionName = `${model}-agent-${instanceNum}`;

    const agent = {
      agentId,
      agentName,
      sessionName,
      model,
      platform,
      instanceNum,
      createdAt: new Date().toISOString(),
    };

    // Store in registry
    this.registry.agents[key] = agent;
    this.registry.nextId[model] = instanceNum + 1;
    this.save();

    return agent;
  }

  /**
   * Get existing agent
   */
  get(model, platform) {
    const key = `${model}-${platform}`;
    return this.registry.agents[key] || null;
  }

  /**
   * List all registered agents
   */
  list() {
    return Object.values(this.registry.agents);
  }

  /**
   * Remove agent from registry
   */
  remove(model, platform) {
    const key = `${model}-${platform}`;
    if (this.registry.agents[key]) {
      delete this.registry.agents[key];
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Reset entire registry (use with caution!)
   */
  reset() {
    this.registry = { agents: {}, nextId: {} };
    this.save();
  }

  /**
   * Export registry data
   */
  export() {
    return JSON.stringify(this.registry, null, 2);
  }
}

/**
 * CLI for managing registry
 */
async function main() {
  const registry = new AgentRegistry();
  const command = process.argv[2];

  switch (command) {
    case 'list':
      console.log('\n📋 AGENT REGISTRY\n');
      const agents = registry.list();
      if (agents.length === 0) {
        console.log('No agents registered yet.\n');
      } else {
        agents.forEach(agent => {
          console.log(`${agent.agentId}`);
          console.log(`  Name:     ${agent.agentName}`);
          console.log(`  Session:  ${agent.sessionName}`);
          console.log(`  Platform: ${agent.platform}`);
          console.log(`  Created:  ${agent.createdAt}`);
          console.log('');
        });
      }
      break;

    case 'get':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: node agent-registry.js get <model> <platform>');
        process.exit(1);
      }
      const agent = registry.get(process.argv[3], process.argv[4]);
      if (agent) {
        console.log(`\n✅ Found: ${agent.agentId}`);
        console.log(JSON.stringify(agent, null, 2));
      } else {
        console.log(`\n❌ Not found: ${process.argv[3]}-${process.argv[4]}`);
      }
      break;

    case 'create':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: node agent-registry.js create <model> <platform>');
        process.exit(1);
      }
      const newAgent = registry.getOrCreate(process.argv[3], process.argv[4]);
      console.log(`\n✅ Created/Retrieved: ${newAgent.agentId}`);
      console.log(JSON.stringify(newAgent, null, 2));
      break;

    case 'remove':
      if (!process.argv[3] || !process.argv[4]) {
        console.error('Usage: node agent-registry.js remove <model> <platform>');
        process.exit(1);
      }
      const removed = registry.remove(process.argv[3], process.argv[4]);
      if (removed) {
        console.log(`\n✅ Removed: ${process.argv[3]}-${process.argv[4]}`);
      } else {
        console.log(`\n❌ Not found: ${process.argv[3]}-${process.argv[4]}`);
      }
      break;

    case 'reset':
      console.log('⚠️  Resetting entire registry...');
      registry.reset();
      console.log('✅ Registry cleared.\n');
      break;

    case 'export':
      console.log(registry.export());
      break;

    default:
      console.log(`
Usage: node agent-registry.js <command>

Commands:
  list                    List all registered agents
  get <model> <platform>  Get agent info
  create <model> <platform> Create/retrieve agent
  remove <model> <platform> Remove agent
  reset                   Clear all agents
  export                  Export registry as JSON

Examples:
  node agent-registry.js list
  node agent-registry.js create opus wsl
  node agent-registry.js get codex mac
  node agent-registry.js remove sonnet wsl
`);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { AgentRegistry };
