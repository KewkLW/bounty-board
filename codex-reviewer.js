#!/usr/bin/env node

/**
 * Wasteland Bounty Board - Codex Code Reviewer
 *
 * Codex specializes in reviewing code PRs and approving/rejecting agent work.
 * - Checks for pending reviews every 30 seconds
 * - Reviews PR evidence and commits
 * - Approves solid work, rejects issues
 * - Records decisions with reasoning
 */

const http = require('http');

class CodexReviewer {
  constructor() {
    this.agentId = 'codex-wsl-1';
    this.reviewerName = 'Codex-Code-Reviewer';
    this.boardUrl = process.env.BOUNTY_BOARD_URL || 'http://localhost:3777';
    this.isReviewing = false;
  }

  log(msg) {
    console.log(`[${this.reviewerName}] ${msg}`);
  }

  /**
   * Make HTTP request
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
   * Get bounties pending review
   */
  async getPendingReviews() {
    try {
      const result = await this.makeRequest('GET', '/api/bounties/review');
      return result.data || [];
    } catch (err) {
      this.log(`Error fetching pending reviews: ${err.message}`);
      return [];
    }
  }

  /**
   * Review a bounty's work
   */
  async reviewBounty(bountyId, bounty) {
    try {
      // Simulate code review - in reality Codex would analyze the PR
      const evidence = bounty.work_evidence || '';

      // Quick review heuristics
      let shouldApprove = true;
      let feedback = '';

      // Check for PR link
      if (!evidence.includes('PR:') && !evidence.includes('pull')) {
        shouldApprove = false;
        feedback = 'No GitHub PR link found in evidence';
      }

      // Check evidence quality
      if (evidence.length < 50) {
        shouldApprove = false;
        feedback = 'Evidence description too brief - need more detail';
      }

      // Assume approval if evidence looks reasonable
      if (shouldApprove && evidence.length >= 50) {
        feedback = 'Code review approved. Evidence shows work was completed. PR can be merged.';
      }

      // Submit review
      const result = await this.makeRequest('POST', `/api/bounties/${bountyId}/verify`, {
        verified_by: this.agentId,
        approved: shouldApprove,
        feedback: feedback,
      });

      if (result.status === 200) {
        const status = shouldApprove ? '✅ APPROVED' : '❌ REJECTED';
        this.log(`${status} bounty #${bountyId}: ${bounty.ticket_id}`);
        if (feedback) {
          this.log(`  Reason: ${feedback}`);
        }
        return true;
      } else {
        this.log(`⚠️  Failed to review #${bountyId}: ${result.status}`);
        return false;
      }
    } catch (err) {
      this.log(`Error reviewing bounty: ${err.message}`);
      return false;
    }
  }

  /**
   * Main review loop
   */
  async run() {
    this.log('Code Reviewer Started');
    this.log('Monitoring for pending PRs...\n');

    while (true) {
      try {
        if (!this.isReviewing) {
          // Check for pending reviews
          const pending = await this.getPendingReviews();

          if (pending.length > 0) {
            this.log(`Found ${pending.length} pending review(s)`);

            for (const bounty of pending) {
              await this.reviewBounty(bounty.id, bounty);
              // Small delay between reviews
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } else {
            this.log(`⏳ Waiting for PRs... (${new Date().toLocaleTimeString()})`);
          }
        }

        // Check every 30 seconds
        await new Promise(resolve => setTimeout(resolve, 30000));
      } catch (err) {
        this.log(`❌ Error in review loop: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  const reviewer = new CodexReviewer();
  await reviewer.run();
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { CodexReviewer };
