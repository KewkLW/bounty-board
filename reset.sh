#!/bin/bash

# Wasteland Bounty Board - Full Reset
# Clears database, registry, and tmux sessions for a fresh start

set -e

BOUNTY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_FILE="$BOUNTY_DIR/bounty-board.db"
DB_WAL="$BOUNTY_DIR/bounty-board.db-wal"
DB_SHM="$BOUNTY_DIR/bounty-board.db-shm"
REGISTRY="$BOUNTY_DIR/.agent-registry.json"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   WASTELAND BOUNTY BOARD - FULL RESET                      ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Kill all tmux sessions
echo "🔪 Killing all tmux agent sessions..."
for session in $(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep agent || true); do
  echo "   Killing: $session"
  tmux kill-session -t "$session" 2>/dev/null || true
done
echo "✅ Tmux sessions cleared"
echo ""

# Delete database files
echo "🗑️  Deleting database files..."
if [ -f "$DB_FILE" ]; then
  rm -v "$DB_FILE"
fi
if [ -f "$DB_WAL" ]; then
  rm -v "$DB_WAL"
fi
if [ -f "$DB_SHM" ]; then
  rm -v "$DB_SHM"
fi
echo "✅ Database cleared"
echo ""

# Delete agent registry
echo "📋 Resetting agent registry..."
if [ -f "$REGISTRY" ]; then
  rm -v "$REGISTRY"
fi
echo "✅ Agent registry cleared"
echo ""

echo "╔════════════════════════════════════════════════════════════╗"
echo "║   ✅ FRESH STATE READY FOR TESTING                         ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. node server.js                    # Start server"
echo "  2. node conductor-spawn.js spawn ... # Spawn agents"
echo "  3. node bounty-cli.js create ...     # Create work"
echo ""
