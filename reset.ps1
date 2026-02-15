# Wasteland Bounty Board - Full Reset (PowerShell)
# Clears database, registry, and tmux sessions for a fresh start

Write-Host ""
Write-Host "╔════════════════════════════════════════════════════════════╗"
Write-Host "║   WASTELAND BOUNTY BOARD - FULL RESET                      ║"
Write-Host "╚════════════════════════════════════════════════════════════╝"
Write-Host ""

$BountyDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DbFile = Join-Path $BountyDir "bounty-board.db"
$DbWal = Join-Path $BountyDir "bounty-board.db-wal"
$DbShm = Join-Path $BountyDir "bounty-board.db-shm"
$Registry = Join-Path $BountyDir ".agent-registry.json"

# Kill all tmux sessions
Write-Host "🔪 Killing all tmux agent sessions..."
$sessions = wsl bash -c "tmux list-sessions -F '#{session_name}' 2>/dev/null | grep agent || true"
if ($sessions) {
  $sessions.Split([Environment]::NewLine) | ForEach-Object {
    if ($_ -ne "") {
      Write-Host "   Killing: $_"
      wsl bash -c "tmux kill-session -t '$_' 2>/dev/null || true"
    }
  }
}
Write-Host "✅ Tmux sessions cleared"
Write-Host ""

# Delete database files
Write-Host "🗑️  Deleting database files..."
if (Test-Path $DbFile) {
  Remove-Item $DbFile -Verbose
}
if (Test-Path $DbWal) {
  Remove-Item $DbWal -Verbose
}
if (Test-Path $DbShm) {
  Remove-Item $DbShm -Verbose
}
Write-Host "✅ Database cleared"
Write-Host ""

# Delete agent registry
Write-Host "📋 Resetting agent registry..."
if (Test-Path $Registry) {
  Remove-Item $Registry -Verbose
}
Write-Host "✅ Agent registry cleared"
Write-Host ""

Write-Host "╔════════════════════════════════════════════════════════════╗"
Write-Host "║   ✅ FRESH STATE READY FOR TESTING                         ║"
Write-Host "╚════════════════════════════════════════════════════════════╝"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. node server.js                    # Start server"
Write-Host "  2. node conductor-spawn.js spawn ... # Spawn agents"
Write-Host "  3. node bounty-cli.js create ...     # Create work"
Write-Host ""
