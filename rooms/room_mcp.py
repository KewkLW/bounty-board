#!/usr/bin/env python3
"""MCP (stdio) front for agent-rooms: lets any CLI agent join a themed room, talk, and (for the admin) run it.

Dependency-free newline JSON-RPC. Each agent runs its own copy, so after room_join this process
remembers which room and which name it speaks for. Defaults: ROOM_ID and ROOM_AS (or OMARCHY_AGENT_NAME) from the
environment; every tool also takes `room` / `as` so agents whose CLI does not pass the env through still work.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

import rooms_env  # noqa: F401  (config.env into os.environ)

URL = os.environ.get('AGENT_ROOMS_URL', 'http://127.0.0.1:3396')
STATE = {'room': os.environ.get('ROOM_ID'), 'as': os.environ.get('ROOM_AS') or os.environ.get('OMARCHY_AGENT_NAME'),
         'cursor': None}
INSTRUCTIONS = (
    'Agent chat rooms. If you were invited to a room, call room_join first (room id and your name are in your '
    'invite), then room_read between work steps and answer anything addressed to you (@YourName). Share findings '
    'and ideas with room_post: short and concrete (addresses, numbers, what you checked, what you will try next). '
    'Use room_wait when you are waiting on another member, room_status to say what you are doing. '
    'room_ask_user asks the human to act on cue (something only they can do, or a decision). Admin tools (room_create, room_invite, room_theme_done, room_close) only work for the room admin.')


def http(method, path, body=None, timeout=60):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(URL + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json', 'X-Room-Request': '1'})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            raise RuntimeError(json.loads(e.read()).get('error', str(e)))
        except ValueError:
            raise RuntimeError(str(e))


def who(a):
    room, me = a.get('room') or STATE['room'], a.get('as') or STATE['as']
    if not room:
        raise RuntimeError('which room? pass room (the id from your invite) or room_join first')
    if not me:
        raise RuntimeError('who are you? pass as (your agent name from the invite) or room_join first')
    return room, me


def act(room, action, body):
    return http('POST', f'/api/r/{urllib.parse.quote(room)}/{action}', body)


def t_join(a):
    room, me = who(a)
    ob = os.environ.get('OMARCHY_AGENT_ROOM_OUTBOX')       # interactive omarchy-agent session: @mentions reach its prompt
    aid = None if os.environ.get('BOUNTY_SLOT') or os.environ.get('BOUNTY_ID') or not ob else os.path.basename(ob.rstrip('/'))
    r = act(room, 'join', {'as': me} | ({'agent_id': aid} if aid else {}))
    STATE.update({'room': room, 'as': me, 'cursor': r.get('cursor')})
    return r


def t_post(a):
    room, me = who(a)
    return act(room, 'post', {'as': me, 'text': a['text']})


def t_read(a):
    room, me = who(a)
    r = act(room, 'read', {'as': me, 'limit': a.get('limit', 30)})
    STATE['cursor'] = r.get('cursor')
    return r


def t_wait(a):
    room, me = who(a)
    since = STATE['cursor']
    if since is None:
        since = act(room, 'read', {'as': me, 'limit': 1}).get('cursor', 0)
    t = max(1, min(int(a.get('timeout', 40)), 45))
    q = urllib.parse.urlencode({'since': since, 'me': me, 'timeout': t})
    w = http('GET', f'/api/r/{urllib.parse.quote(room)}/wait?{q}', timeout=t + 10)
    if not w['messages']:
        return {'messages': [], 'note': f'nothing new in {t}s'}
    return t_read({})


def t_status(a):
    room, me = who(a)
    return act(room, 'status', {'as': me, 'status': a['status'], 'text': a.get('text')})


def t_members(a):
    room, _ = who(a | {'as': a.get('as') or STATE['as'] or '-'})
    v = http('GET', f'/api/r/{urllib.parse.quote(room)}')
    return {'room': v['name'], 'purpose': v['purpose'], 'pins': v['pins'], 'members': v['members']}


def t_message(a):
    room, _ = who(a | {'as': a.get('as') or STATE['as'] or '-'})
    return http('GET', f'/api/r/{urllib.parse.quote(room)}/message?seq={int(a["seq"])}')


def t_create(a):
    me = a.get('as') or STATE['as']
    r = http('POST', '/api/rooms', {'id': a['room'], 'name': a.get('name'), 'purpose': a['purpose'],
                                    'brief': a.get('brief', ''), 'project': a.get('project'), 'admin': me})
    STATE.update(room=a['room'])
    return r


def t_invite(a):
    room, me = who(a)
    return act(room, 'invite', {'as': me, 'name': a['name'], 'role': a.get('role'), 'model': a.get('model'),
                                'kind': a.get('kind', 'agent')})


def t_theme_done(a):
    room, me = who(a)
    return act(room, 'theme_done', {'as': me, 'notes': a.get('notes')})


def t_pin(a):
    room, me = who(a)
    return act(room, 'pin', {'as': me, 'text': a.get('text'), 'seq': a.get('seq')})


def t_unpin(a):
    room, me = who(a)
    return act(room, 'unpin', {'as': me, 'id': a['id']})


def t_ask(a):
    """Post an ask for the human (desktop notification), then optionally wait for the answer."""
    room, me = who(a)
    r = act(room, 'ask', {'as': me, 'text': a['text']})
    wait_s = max(0, min(int(a.get('wait_s', 45)), 45))
    if not wait_s:
        return r
    q = urllib.parse.urlencode({'since': r['seq'], 'me': me, 'timeout': wait_s})
    w = http('GET', f'/api/r/{urllib.parse.quote(room)}/wait?{q}', timeout=wait_s + 10)
    ans = [m for m in w['messages'] if m.get('reply_to') == r['seq']]
    return r | {'answer': ans[0]['text'] if ans else None,
                'note': 'answered' if ans else f'no answer in {wait_s}s: room_wait again (the answer comes first)'}


def t_close(a):
    room, me = who(a)
    return act(room, 'close', {'as': me, 'summary': a.get('summary')})


S_ROOM = {'type': 'string', 'description': 'room id (from your invite); remembered after room_join'}
S_AS = {'type': 'string', 'description': 'your agent name (from your invite); remembered after room_join'}


def tool(name, desc, props=None, req=(), fn=None):
    return name, fn, {'name': name, 'description': desc, 'inputSchema': {
        'type': 'object', 'properties': {'room': S_ROOM, 'as': S_AS, **(props or {})}, 'required': list(req)}}


TOOLS = {n: (f, s) for n, f, s in [
    tool('room_join', 'Accept your invite and enter the room. Returns the welcome packet: purpose, pinned brief, '
         'members, recent messages and how the room works. Call this first.', fn=t_join),
    tool('room_post', 'Say something to the whole room. @Name addresses one member (they see it first). Share '
         'findings, ideas, questions, requests for a second opinion.', {'text': {'type': 'string'}}, ['text'], t_post),
    tool('room_read', 'New messages since your last read; messages addressed to you (and from the human) come first. '
         'Call between work steps.', {'limit': {'type': 'integer', 'default': 30}}, fn=t_read),
    tool('room_wait', 'Wait up to 45 s for someone else to post, then return the new messages. Use when you are '
         'waiting on a reply.', {'timeout': {'type': 'integer', 'default': 40}}, fn=t_wait),
    tool('room_status', 'Set what you are doing, shown next to your name in the member list.',
         {'status': {'type': 'string', 'enum': ['working', 'waiting', 'idle', 'done', 'left']},
          'text': {'type': 'string', 'description': 'one line, e.g. "reading the test logs"'}}, ['status'], t_status),
    tool('room_members', 'Who is in the room, their roles, presence and status, plus the pinned items.', fn=t_members),
    tool('room_message', 'Full text of one message (long ones are cut in room_read).',
         {'seq': {'type': 'integer'}}, ['seq'], t_message),
    tool('room_create', 'ADMIN: open a new room (you become its admin). Then theme it (public/ dir in the result) '
         'and call room_theme_done before inviting anyone.',
         {'name': {'type': 'string'}, 'purpose': {'type': 'string'}, 'brief': {'type': 'string', 'description': 'markdown, pinned at the top'},
          'project': {'type': 'string'}}, ['room', 'purpose'], t_create),
    tool('room_theme_done', "ADMIN: mark the room's own look as finished (refused while theme.css is the default "
         'or art/ is empty). Invites open after this.', {'notes': {'type': 'string'}}, fn=t_theme_done),
    tool('room_invite', 'ADMIN: invite a member by name with a role. They join with room_join.',
         {'name': {'type': 'string'}, 'role': {'type': 'string'}, 'model': {'type': 'string'},
          'kind': {'type': 'string', 'enum': ['agent', 'interactive']}}, ['name'], t_invite),
    tool('room_pin', 'Pin a verified finding (text, or a message by seq) to the top of the room, under your name.',
         {'text': {'type': 'string'}, 'seq': {'type': 'integer'}}, fn=t_pin),
    tool('room_unpin', 'Remove a pin by its id (yours; the admin can remove any).', {'id': {'type': 'integer'}}, ['id'], t_unpin),
    tool('room_ask_user', 'Ask the human to do something on cue that only they can do: e.g. "approve the deploy", "plug in '
         'the device", "open the settings screen", "check the page on your phone". It shows '
         'on the page with Done / Can\'t now and pops a desktop notification. Be exact about what and for how long, '
         'and get ready to observe the result before you ask. Waits up to wait_s (45 max) for the answer.',
         {'text': {'type': 'string'}, 'wait_s': {'type': 'integer', 'default': 45}}, ['text'], t_ask),
    tool('room_close', 'ADMIN: close the room with a summary.', {'summary': {'type': 'string'}}, fn=t_close),
]}


def reply(mid, result=None, error=None):
    msg = {'jsonrpc': '2.0', 'id': mid}
    msg['error' if error else 'result'] = error or result
    sys.stdout.write(json.dumps(msg) + '\n')
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        method, mid, params = msg.get('method'), msg.get('id'), msg.get('params') or {}
        if mid is None:
            continue
        if method == 'initialize':
            reply(mid, {'protocolVersion': params.get('protocolVersion', '2025-06-18'), 'capabilities': {'tools': {}},
                        'serverInfo': {'name': 'room', 'version': '1.0'}, 'instructions': INSTRUCTIONS})
        elif method == 'tools/list':
            reply(mid, {'tools': [s for _, s in TOOLS.values()]})
        elif method == 'tools/call':
            name, args = params.get('name'), params.get('arguments') or {}
            try:
                if name not in TOOLS:
                    raise RuntimeError(f'unknown tool {name}')
                text, err = json.dumps(TOOLS[name][0](args), indent=1, ensure_ascii=False), False
            except urllib.error.URLError as e:
                text, err = f'agent-rooms not reachable at {URL} ({e.reason}); systemctl --user start agent-rooms', True
            except Exception as e:
                text, err = f'{type(e).__name__}: {e}', True
            reply(mid, {'content': [{'type': 'text', 'text': text}], 'isError': err})
        elif method == 'ping':
            reply(mid, {})
        else:
            reply(mid, error={'code': -32601, 'message': f'method not found: {method}'})


if __name__ == '__main__':
    main()
