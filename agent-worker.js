#!/usr/bin/env node

/**
 * Wasteland Bounty Board - Worker Agent
 *
 * A self-contained agent that:
 * - Connects to the bounty board via HTTP
 * - Claims available bounties
 * - Simulates work completion
 * - Updates dashboard in real-time
 */

const http = require('http');
const { AgentRegistry } = require('./agent-registry');

class WorkerAgent {
  constructor(model, agentId) {
    this.model = model;
    this.agentId = agentId;
    this.boardUrl = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';
    this.isWorking = false;
    this.currentBountyId = null;
  }

  log(msg) {
    console.log(`[${this.agentId}] ${msg}`);
  }

  /**
   * Make HTTP request to bounty board
   */
  makeRequest(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.boardUrl + path);
      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-ID': this.agentId,
        },
      };

      if (body) {
        const bodyStr = JSON.stringify(body);
        options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, data });
          }
        });
      });

      req.on('error', reject);

      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  }

  /**
   * Get available bounties to claim
   */
  async getAvailableBounties() {
    try {
      const result = await this.makeRequest('GET', '/api/bounties?status=pending');
      return result.data || [];
    } catch (err) {
      this.log(`Error fetching bounties: ${err.message}`);
      return [];
    }
  }

  /**
   * Claim a bounty
   */
  async claimBounty(bountyId) {
    try {
      const result = await this.makeRequest('POST', `/api/bounties/${bountyId}/claim`, {
        agent_id: this.agentId,
      });

      if (result.status === 200 || result.status === 201) {
        this.log(`✅ Claimed bounty #${bountyId}`);
        return true;
      } else {
        this.log(`⚠️  Failed to claim #${bountyId}: ${result.status}`);
        return false;
      }
    } catch (err) {
      this.log(`Error claiming bounty: ${err.message}`);
      return false;
    }
  }

  /**
   * Submit work evidence for review
   */
  async submitWork(bountyId, evidence, notes = '') {
    try {
      const result = await this.makeRequest('POST', `/api/bounties/${bountyId}/submit-work`, {
        agent_id: this.agentId,
        evidence: evidence,
        notes: notes,
      });

      if (result.status === 200) {
        this.log(`📋 Submitted work for review: #${bountyId}`);
        return true;
      } else {
        this.log(`⚠️  Failed to submit work #${bountyId}: ${result.status}`);
        return false;
      }
    } catch (err) {
      this.log(`Error submitting work: ${err.message}`);
      return false;
    }
  }

  /**
   * Complete a bounty (auto-verification)
   */
  async completeBounty(bountyId) {
    try {
      const result = await this.makeRequest('POST', `/api/bounties/${bountyId}/complete`, {
        agent_id: this.agentId,
      });

      if (result.status === 200 || result.status === 201) {
        this.log(`✨ Completed bounty #${bountyId} - Reward: ${result.data.reward}xp`);
        return true;
      } else {
        this.log(`⚠️  Failed to complete #${bountyId}: ${result.status}`);
        return false;
      }
    } catch (err) {
      this.log(`Error completing bounty: ${err.message}`);
      return false;
    }
  }

  /**
   * Simulate working on a bounty (wait then complete with evidence)
   */
  async workOnBounty(bounty) {
    this.currentBountyId = bounty.id;
    this.isWorking = true;

    // Simulate work time based on tier
    const workTimes = {
      'S': 2000,  // 2 seconds
      'A': 3000,  // 3 seconds
      'B': 5000,  // 5 seconds
      'C': 7000,  // 7 seconds
    };

    const workTime = workTimes[bounty.tier] || 5000;
    this.log(`🔨 Working on "${bounty.title}" for ${workTime / 1000}s...`);

    await new Promise(resolve => setTimeout(resolve, workTime));

    // Generate work evidence
    const evidence = `Analyzed and fixed: ${bounty.title}. Root cause identified and resolved.`;
    const notes = `Completed by ${this.model} agent. Verification timestamp: ${new Date().toISOString()}`;

    // Submit work with evidence (or auto-complete if quick)
    // For now, just complete directly with evidence stored
    const success = await this.completeBounty(bounty.id);
    this.isWorking = false;
    this.currentBountyId = null;

    return success;
  }

  /**
   * Register agent in the database (one-time on startup)
   */
  async registerAgent() {
    try {
      // Check if agent already exists
      const checkResult = await this.makeRequest('GET', `/api/agents/${this.agentId}`);

      if (checkResult.status === 200) {
        this.log(`✅ Agent already registered in database`);
        return true;
      }

      // Register the agent via /api/agents/register endpoint
      this.log(`📝 Registering agent with bounty board...`);
      const registerResult = await this.makeRequest('POST', '/api/agents/register', {
        agent_id: this.agentId,
        agent_name: `${this.model.charAt(0).toUpperCase() + this.model.slice(1)}-Agent`,
        class: 'Worker',
        level: 1,
      });

      if (registerResult.status === 200 || registerResult.status === 201) {
        this.log(`✅ Agent registered successfully`);
        return true;
      } else {
        this.log(`⚠️  Agent registration failed: ${registerResult.status}`);
        return false;
      }
    } catch (err) {
      this.log(`❌ Error registering agent: ${err.message}`);
      return false;
    }
  }

  /**
   * Main agent loop
   */
  async run() {
    this.log(`Agent started (${this.model})`);

    // Register this agent in the database on startup
    await this.registerAgent();

    while (true) {
      try {
        // If not currently working, look for bounties to claim
        if (!this.isWorking) {
          const bounties = await this.getAvailableBounties();

          if (bounties.length > 0) {
            // Claim the first available bounty
            const bounty = bounties[0];

            if (await this.claimBounty(bounty.id)) {
              // Work on the claimed bounty
              await this.workOnBounty(bounty);
            }
          } else {
            this.log(`⏳ Waiting for bounties... (${new Date().toLocaleTimeString()})`);
          }
        }

        // Check back every 5 seconds
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (err) {
        this.log(`❌ Error in main loop: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const model = process.argv[2] || 'opus';
  const registry = new AgentRegistry();
  const agentInfo = registry.getOrCreate(model, 'wsl');

  const agent = new WorkerAgent(model, agentInfo.agentId);
  await agent.run();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { WorkerAgent };
