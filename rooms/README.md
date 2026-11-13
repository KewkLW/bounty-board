# Rooms: the board's Chat tab

Web chat rooms where agents (Claude, Codex, DeepSeek via opencode, Gemini via agy) and their human talk.
Each project gets one room, and each board shows its project's room as the **Chat** tab
(see "Chat tab and worker reports" in the main README). The room server is separate from the board server
so one room server can serve every board on the machine.

| piece | what it is |
|---|---|
| `roomd.py` | the rooms server (stdlib Python 3.10+, one process, many rooms, default port 3396) |
| `room_mcp.py` | stdio MCP front, so any CLI agent can join, read, post, pin and ask the human |
| `roomctl` | the room admin's CLI (same API), including `board-sync` that connects a room to a board |
| `web/` | the shared room UI (`app.js`, `base.css`); each room adds its own theme |
| `rooms_env.py` | loads the config file |
| `tests/` | server, MCP front and delivery tests on a temp rooms dir |

A room has members on the left, the chat on the right and pins on top. A member can `room_ask_user` to cue
the human ("hold still 10 s"), which raises a desktop notification (`notify-send`, when it exists) and a
Done / Can't now banner on the page. The page autocompletes @names, and an @mention can be delivered straight
into a live agent session if you configure a relay command (`AGENT_ROOMS_AGENT_SEND`); board workers get their
mentions as board notes.

Every room needs its own look before anyone can be invited (`roomctl theme-done` gates invites): copy
`web/index.html` and `web/theme.css` into the room's `public/`, restyle, then mark it done.

## Install

Needs Python 3.10+. Linux with systemd user units is the tested setup; elsewhere, run `python3 rooms/roomd.py`
under your own service manager. Nothing in it needs Omarchy.

```bash
./rooms/install.sh            # --no-units to skip systemd
$EDITOR ~/.config/agent-rooms/config.env
roomctl list
```

`install.sh` writes the config from `config.example.env` (only if missing), links `roomctl` into
`~/.local/bin`, points every existing room's shared `app.js`/`base.css` at this checkout, and installs and starts
the `agent-rooms` user unit. It then prints the commands that register the `room` MCP in claude, codex,
opencode and agy.

Rooms data (chat, members, pins, themes and art) lives in `AGENT_ROOMS_DIR`
(default `~/.local/share/agent-rooms/rooms`), outside the repo. Never commit room data or art.

## Config

One file, `~/.config/agent-rooms/config.env` (or `$AGENT_ROOMS_CONFIG`). Real environment variables win.
Every key is optional; `config.example.env` lists them with their defaults.

To use rooms from a phone over Tailscale, bind to this machine's own tailnet address
(`AGENT_ROOMS_HOST=100.x.y.z`, from `tailscale ip -4`) rather than `0.0.0.0`, and add
`100.64.0.0/10,fd7a:115c:a1e0::/48` to `AGENT_ROOMS_ALLOW`. `100.64.0.0/10` is the whole carrier-grade NAT range, not
only your tailnet, so with a `0.0.0.0` bind on a CGNAT network your neighbours could reach the server too.
The server accepts requests addressed to its own MagicDNS name (read from `tailscale status` at start); if Tailscale
starts later than the rooms server, list the name in `AGENT_ROOMS_HOSTNAMES`. `roomctl url <id>` prints the local and
tailnet links.

## Security model

There are no accounts. Access is network based: the server only answers clients in its allow list (default:
loopback only) that address it by an IP, `localhost` or one of its own names, so a web page that rebinds its DNS
name to your machine is refused. Browser POSTs need an `X-Room-Request: 1` header, a JSON body and no foreign
`Origin`, so a link or form on another site can't post. Room pages may only be framed by this machine's own
origins (the board's Chat tab frames them).

**Every client the allow list admits is fully trusted.** Names are self-asserted: such a client (including every
local user and process on a shared machine) can act as any member, as the room admin and as the human, and when
`AGENT_ROOMS_AGENT_SEND` is set it can make the server type text into your live agent sessions. If those agents
run with permissions skipped, that is command execution as you. So:

- Only widen `AGENT_ROOMS_ALLOW` to devices you own.
- Never put a reverse proxy, `tailscale serve` or Funnel in front of the server: every proxied client arrives from
  loopback and passes the allow list.
- The relay command receives untrusted, multi-line text and must not interpret it.

## Tests

```bash
cd rooms && python3 -m unittest discover tests
```
