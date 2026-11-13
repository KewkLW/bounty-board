#!/usr/bin/env bash
# rooms/install.sh: wire the rooms server in this checkout into your machine. Safe to re-run.
#   - config: ~/.config/agent-rooms/config.env from config.example.env (only if missing)
#   - CLI:    ~/.local/bin/roomctl -> rooms/roomctl
#   - unit:   the agent-rooms user unit (systemd), enabled and started
#   - rooms:  existing rooms' shared app.js/base.css links are pointed at this checkout's web/
# Flags: --no-units (skip systemd)
# The room MCP is registered per CLI by hand; the script prints the commands at the end.
set -euo pipefail
REPO="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
UNITS=1
while [[ $# -gt 0 ]]; do
    case "$1" in
        --no-units) UNITS=0 ;;
        *) echo "unknown flag $1" >&2; exit 2 ;;
    esac; shift
done

CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/agent-rooms"
mkdir -p "$CONF_DIR" "$HOME/.local/bin"
if [[ ! -e "$CONF_DIR/config.env" ]]; then
    cp "$REPO/config.example.env" "$CONF_DIR/config.env"
    echo "config: wrote $CONF_DIR/config.env (edit it: your name, networks)"
else
    echo "config: kept $CONF_DIR/config.env"
fi

# roomctl: a symlink, an existing real file is moved aside (never deleted)
if [[ -e "$HOME/.local/bin/roomctl" && ! -L "$HOME/.local/bin/roomctl" ]]; then
    mv "$HOME/.local/bin/roomctl" "$HOME/.local/bin/roomctl.pre-install.$(date +%Y%m%d-%H%M%S)"
fi
ln -sfn "$REPO/roomctl" "$HOME/.local/bin/roomctl"
echo "cli: $HOME/.local/bin/roomctl -> $REPO/roomctl"

# Each room's public/ links app.js and base.css to the shared web/ copies: point them at this checkout.
ROOMS_DIR="${AGENT_ROOMS_DIR:-}"
if [[ -z "$ROOMS_DIR" && -f "$CONF_DIR/config.env" ]]; then
    ROOMS_DIR="$(sed -n 's/^[[:space:]]*AGENT_ROOMS_DIR=//p' "$CONF_DIR/config.env" | tail -1)"
    ROOMS_DIR="${ROOMS_DIR%\"}"; ROOMS_DIR="${ROOMS_DIR#\"}"; ROOMS_DIR="${ROOMS_DIR%\'}"; ROOMS_DIR="${ROOMS_DIR#\'}"
fi
ROOMS_DIR="${ROOMS_DIR:-$HOME/.local/share/agent-rooms/rooms}"
ROOMS_DIR="${ROOMS_DIR/#\~/$HOME}"; ROOMS_DIR="${ROOMS_DIR//\$HOME/$HOME}"
n=0
for pub in "$ROOMS_DIR"/*/public; do
    [[ -d "$pub" ]] || continue
    for f in app.js base.css; do
        if [[ -L "$pub/$f" ]]; then ln -sfn "$REPO/web/$f" "$pub/$f"; n=$((n + 1)); fi
    done
done
echo "rooms: $n shared links in $ROOMS_DIR point at $REPO/web"

if (( UNITS )) && command -v systemctl >/dev/null; then
    UD="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; mkdir -p "$UD"
    PY="$(command -v python3)"
    sed -e "s|@REPO@|$REPO|g" -e "s|@PYTHON@|$PY|g" "$REPO/systemd/agent-rooms.service" > "$UD/agent-rooms.service.tmp"
    if [[ -e "$UD/agent-rooms.service" ]] && ! cmp -s "$UD/agent-rooms.service" "$UD/agent-rooms.service.tmp"; then
        bak="$UD/agent-rooms.service.bak-$(date +%Y%m%d-%H%M%S)"
        cp -p "$UD/agent-rooms.service" "$bak"; echo "unit: kept the previous unit as $bak"
    fi
    mv "$UD/agent-rooms.service.tmp" "$UD/agent-rooms.service"
    systemctl --user daemon-reload
    systemctl --user enable --now agent-rooms
    systemctl --user restart agent-rooms
    echo "unit: agent-rooms running"
fi

cat <<MSG

Register the room MCP in each CLI that takes part (stdio server, name "room"):
  claude mcp add -s user room -- python3 "$REPO/room_mcp.py"
  codex:    ~/.codex/config.toml   [mcp_servers] room = { command = "python3", args = ["$REPO/room_mcp.py"] }
  opencode: ~/.config/opencode/opencode.json  "mcp": { "room": { "type": "local", "command": ["python3", "$REPO/room_mcp.py"] } }
  agy:      agy mcp add room python3 "$REPO/room_mcp.py"
Then: roomctl list
MSG
