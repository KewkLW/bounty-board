const http = require('http');
const https = require('https');

/**
 * BountyBoardClient - SDK for agents to interact with the Wasteland Bounty Board
 *
 * Provides atomic claim semantics, automatic retry logic, and production-ready error handling.
 *
 * @example
 * const { BountyBoardClient } = require('./agent-sdk');
 * const client = new BountyBoardClient('http://localhost:3777', 'agent-id');
 *
 * // Claim a bounty
 * const bounty = await client.claimAvailableBounty({ type: 'bug', tier: 'A' });
 *
 * // Work on it
 * await client.reportProgress(bounty.id, 25);
 * await client.reportProgress(bounty.id, 75);
 *
 * // Complete it
 * await client.completeBounty(bounty.id);
 */

class BountyBoardClient {
  /**
   * Create a client for the Bounty Board
   * @param {string} baseUrl - Base URL of the bounty board server (e.g., 'http://localhost:3777')
   * @param {string} agentId - Unique agent identifier (e.g., 'codex-wsl', 'sonnet-coder')
   * @param {object} options - Configuration options
   * @param {number} options.timeout - Request timeout in ms (default: 10000)
   * @param {number} options.retryAttempts - Max retry attempts on conflict (default: 3)
   * @param {number} options.retryDelayMs - Initial retry delay in ms (default: 100)
   */
  constructor(baseUrl, agentId, options = {}) {
    this.baseUrl = baseUrl;
    this.agentId = agentId;
    this.timeout = options.timeout || 10000;
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelayMs = options.retryDelayMs || 100;
    this.isHttps = baseUrl.startsWith('https://');
    this.logger = options.logger || console;
  }

  /**
   * Make a raw HTTP request
   * @private
   */
  _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const client = this.isHttps ? https : http;
      const url = new URL(path, this.baseUrl);

      const options = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `BountyBoardAgent/${this.agentId}`,
        },
        timeout: this.timeout,
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const response = {
            status: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null,
          };
          resolve(response);
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout after ${this.timeout}ms`));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * List available bounties with optional filters
   * @param {object} filters - Query filters
   * @param {string} filters.status - Filter by status (pending, in_progress, done, failed)
   * @param {string} filters.type - Filter by type (task, bug)
   * @param {string} filters.tier - Filter by tier (S, A, B, C)
   * @returns {Promise<array>} Array of bounties
   */
  async listBounties(filters = {}) {
    const params = new URLSearchParams();
    if (filters.status) params.append('status', filters.status);
    if (filters.type) params.append('type', filters.type);
    if (filters.tier) params.append('tier', filters.tier);

    const path = `/api/bounties${params.toString() ? '?' + params.toString() : ''}`;
    const res = await this._request('GET', path);

    if (res.status !== 200) {
      throw new Error(`Failed to list bounties: ${res.status} ${JSON.stringify(res.body)}`);
    }

    return res.body;
  }

  /**
   * Get board statistics
   * @returns {Promise<object>} Board stats (total, pending, in_progress, done, failed, etc.)
   */
  async getBoardStats() {
    const res = await this._request('GET', '/api/bounties/stats');
    if (res.status !== 200) {
      throw new Error(`Failed to get stats: ${res.status}`);
    }
    return res.body;
  }

  /**
   * Claim an available bounty atomically with retry logic
   *
   * On 409 conflict (another agent already claimed it), retries with exponential backoff.
   *
   * @param {object} filters - Optional filters to find a specific type of bounty
   * @param {string} filters.type - Prefer bounties of this type (task, bug)
   * @param {string} filters.tier - Prefer bounties of this tier (S, A, B, C)
   * @param {string} filters.priority - Prefer bounties with this priority
   * @returns {Promise<object>} The claimed bounty object, or null if no available bounties
   */
  async claimAvailableBounty(filters = {}) {
    const bounties = await this.listBounties({ status: 'pending', ...filters });

    if (bounties.length === 0) {
      this.logger.log(`[${this.agentId}] No pending bounties available`);
      return null;
    }

    // Try each bounty until we successfully claim one
    for (const bounty of bounties) {
      try {
        return await this.claimBounty(bounty.id);
      } catch (err) {
        if (err.statusCode === 409) {
          // Another agent claimed it, try the next one
          this.logger.log(`[${this.agentId}] Bounty ${bounty.id} already claimed, trying next...`);
          continue;
        }
        throw err;
      }
    }

    this.logger.log(`[${this.agentId}] All available bounties were claimed by other agents`);
    return null;
  }

  /**
   * Claim a specific bounty (atomic operation)
   *
   * Returns 409 if another agent already claimed it.
   *
   * @param {number} bountyId - ID of the bounty to claim
   * @returns {Promise<object>} The claimed bounty object
   * @throws {Error} If bounty not found or already claimed
   */
  async claimBounty(bountyId) {
    let attempt = 0;
    let lastError;

    while (attempt < this.retryAttempts) {
      try {
        const res = await this._request('POST', `/api/bounties/${bountyId}/claim`, {
          agent_id: this.agentId,
        });

        if (res.status === 200) {
          this.logger.log(`[${this.agentId}] Successfully claimed bounty ${bountyId}: ${res.body.title}`);
          return res.body;
        }

        if (res.status === 409) {
          const error = new Error(`Bounty ${bountyId} already claimed by another agent`);
          error.statusCode = 409;
          throw error;
        }

        if (res.status === 404) {
          throw new Error(`Bounty ${bountyId} not found`);
        }

        throw new Error(`Failed to claim: ${res.status} ${JSON.stringify(res.body)}`);
      } catch (err) {
        lastError = err;

        // Don't retry on 409 or 404
        if (err.statusCode === 409 || err.statusCode === 404) {
          throw err;
        }

        attempt++;
        if (attempt < this.retryAttempts) {
          const delay = this.retryDelayMs * Math.pow(2, attempt - 1);
          this.logger.log(`[${this.agentId}] Claim attempt ${attempt} failed, retrying in ${delay}ms...`);
          await this._sleep(delay);
        }
      }
    }

    throw lastError || new Error(`Failed to claim bounty after ${this.retryAttempts} attempts`);
  }

  /**
   * Report progress on the current bounty
   * @param {number} bountyId - ID of the bounty
   * @param {number} progress - Progress percentage (0-100)
   * @returns {Promise<object>} Updated bounty object
   */
  async reportProgress(bountyId, progress) {
    const p = Math.max(0, Math.min(100, progress));

    const res = await this._request('POST', `/api/bounties/${bountyId}/progress`, { progress: p });

    if (res.status !== 200) {
      throw new Error(`Failed to report progress: ${res.status} ${JSON.stringify(res.body)}`);
    }

    this.logger.log(`[${this.agentId}] Reported ${p}% progress on bounty ${bountyId}`);
    return res.body;
  }

  /**
   * Mark a bounty as completed
   *
   * This calculates XP rewards with bonuses (First Blood, Streak, etc.)
   *
   * @param {number} bountyId - ID of the bounty
   * @returns {Promise<object>} Completed bounty object with final reward
   */
  async completeBounty(bountyId) {
    const res = await this._request('POST', `/api/bounties/${bountyId}/complete`);

    if (res.status !== 200) {
      throw new Error(`Failed to complete bounty: ${res.status} ${JSON.stringify(res.body)}`);
    }

    this.logger.log(`[${this.agentId}] Completed bounty ${bountyId}. Earned ${res.body.reward} XP!`);
    return res.body;
  }

  /**
   * Mark a bounty as failed
   *
   * This applies a botch penalty (50% of reward deducted from agent loot)
   *
   * @param {number} bountyId - ID of the bounty
   * @param {string} errorLog - Description of what went wrong
   * @returns {Promise<object>} Failed bounty object
   */
  async failBounty(bountyId, errorLog = '') {
    const res = await this._request('POST', `/api/bounties/${bountyId}/fail`, {
      error_log: errorLog || 'Agent failed to complete task',
    });

    if (res.status !== 200) {
      throw new Error(`Failed to mark bounty as failed: ${res.status} ${JSON.stringify(res.body)}`);
    }

    this.logger.log(`[${this.agentId}] Failed bounty ${bountyId}. Botch penalty applied.`);
    return res.body;
  }

  /**
   * Retry a failed bounty (resets it to pending)
   * @param {number} bountyId - ID of the bounty
   * @returns {Promise<object>} Reset bounty object
   */
  async retryBounty(bountyId) {
    const res = await this._request('POST', `/api/bounties/${bountyId}/retry`);

    if (res.status !== 200) {
      throw new Error(`Failed to retry bounty: ${res.status} ${JSON.stringify(res.body)}`);
    }

    this.logger.log(`[${this.agentId}] Retried bounty ${bountyId} - back to pending`);
    return res.body;
  }

  /**
   * Get a single bounty's details
   * @param {number} bountyId - ID of the bounty
   * @returns {Promise<object>} Bounty object
   */
  async getBounty(bountyId) {
    const bounties = await this.listBounties();
    const bounty = bounties.find(b => b.id === bountyId);
    if (!bounty) {
      throw new Error(`Bounty ${bountyId} not found`);
    }
    return bounty;
  }

  /**
   * Get agent details and their bounties
   * @param {string} agentId - ID of the agent (defaults to this client's agent)
   * @returns {Promise<object>} Agent object with bounties array
   */
  async getAgent(agentId = this.agentId) {
    const res = await this._request('GET', `/api/agents/${agentId}`);

    if (res.status !== 200) {
      throw new Error(`Failed to get agent: ${res.status}`);
    }

    return res.body;
  }

  /**
   * Get the leaderboard
   * @returns {Promise<array>} Array of agents ranked by XP
   */
  async getLeaderboard() {
    const res = await this._request('GET', '/api/agents/leaderboard');

    if (res.status !== 200) {
      throw new Error(`Failed to get leaderboard: ${res.status}`);
    }

    return res.body;
  }

  /**
   * Get tier information (rewards, names, bonuses)
   * @returns {Promise<object>} Tier data
   */
  async getTierInfo() {
    const res = await this._request('GET', '/api/tiers');

    if (res.status !== 200) {
      throw new Error(`Failed to get tier info: ${res.status}`);
    }

    return res.body;
  }

  /**
   * Sleep utility
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { BountyBoardClient };
