#!/usr/bin/env python3
"""agent-rooms: themed web chat rooms where agents (Claude, Codex, DeepSeek, Gemini...) and their human talk (:3396).

One server, many rooms. A room is a directory under ROOMS (default ~/.local/share/agent-rooms/rooms/<id>/):
  room.json     purpose, pinned brief, admin, invites (the roster), pins, theme state, closed
  chat.jsonl    every message, one JSON per line, `seq` increasing
  public/       the room's own themed web UI (index.html + theme.css + art/), made from web/ by the admin.
                app.js and base.css are symlinks to the shared web/ copies, so every room behaves the same;
                a theme changes index.html (header, fonts, art) and theme.css only.

Who may do what: the admin (room.json `admin`) creates, invites, pins and closes; only invited names can join,
and only joined members can post. Invites are refused until the room is themed (`theme_done`): every room gets
its own look before anyone is brought in, the same rule as the project boards. The web page posts as `human`.

  GET  /                          room list           GET  /r/<id>/            the room's web UI
  GET  /api/rooms                 POST /api/rooms     {id, name, purpose, brief, admin}
  GET  /api/r/<id>                room + members      GET  /api/r/<id>/messages?since=&limit=
  GET  /api/r/<id>/wait?since=&me=&timeout=           long poll (<= 45 s)
  POST /api/r/<id>/{invite,join,route,post,read,status,pin,unpin,ask,answer,theme_done,close}

Direct delivery: a message that @mentions a member (case-insensitive) is also delivered to that member, not only
into chat.jsonl: an interactive session with a recorded agent id (AGENT_ROOMS_AGENT_SEND <id> <text>, e.g. omarchy-agent-send), else a board worker
slot (a note on the slot's in-progress bounty on the room's board), else chat only. Each delivery says it came
from the room and that the reply goes in the room. Logged to deliveries.jsonl; failures never block a post.

Agents reach it through room_mcp.py (MCP stdio). Browser POSTs need `X-Room-Request: 1` and a JSON body, so a
link or a form on another site cannot post. Answers only clients in AGENT_ROOMS_ALLOW (default loopback).
Settings come from the environment or config.env (rooms_env.py, config.example.env).
"""
import ipaddress
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import rooms_env  # noqa: F401  (config.env into os.environ, before the settings below)

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, 'web')
ROOMS = os.path.expanduser(os.environ.get('AGENT_ROOMS_DIR', '~/.local/share/agent-rooms/rooms'))
PORT = int(os.environ.get('AGENT_ROOMS_PORT', 3396))
HUMAN = os.environ.get('AGENT_ROOMS_HUMAN', 'Human')
# Client networks the server answers. Tailscale: add your devices' tailnet addresses (README, Config).
ALLOW = [ipaddress.ip_network(n.strip()) for n in os.environ.get('AGENT_ROOMS_ALLOW', '127.0.0.0/8,::1/128').split(',')
         if n.strip()]
TAILNET_V4 = ipaddress.ip_network('100.64.0.0/10')
def _tailnet_name():
    """This machine's own MagicDNS name, when Tailscale is running (else none: set AGENT_ROOMS_HOSTNAMES)."""
    try:
        st = json.loads(subprocess.run(['tailscale', 'status', '--json'], capture_output=True, text=True, timeout=5).stdout)
        n = ((st.get('Self') or {}).get('DNSName') or '').rstrip('.').lower()
        return {n} if n else set()
    except Exception:
        return set()


# Host names a request may be addressed to (DNS-rebinding guard): IP literals, localhost, this machine's own name and
# tailnet name (added by main()), and any extra names in AGENT_ROOMS_HOSTNAMES (comma separated). Never a whole
# domain such as *.ts.net. Only DNS-name characters are kept, since the names also go into the CSP header.
HOST_NAME_RE = re.compile(r'[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*')
HOSTNAMES = {h for h in {'localhost', socket.gethostname().lower()} | {
    h.strip().lower().rstrip('.') for h in os.environ.get('AGENT_ROOMS_HOSTNAMES', '').split(',')} if HOST_NAME_RE.fullmatch(h)}


def frame_ancestors_base():
    """Pages that may frame a room page (board Chat tabs): loopback and this machine's own names, any port."""
    return ["'self'", 'http://127.0.0.1:*', 'http://localhost:*'] + [
        f'{s}://{h}:*' for h in sorted(HOSTNAMES - {'localhost'}) for s in ('http', 'https')]


MAX_BODY = 1 << 20                  # bytes a POST may send
KINDS = ('agent', 'interactive', 'board')
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,47}$')
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$')
MAX_TEXT = 8000
AGENT_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
AGENT_SEND = os.environ.get('AGENT_ROOMS_AGENT_SEND', '')   # `<cmd> <agent id> <text>` types into a live session; empty = off
DELIVER_ASYNC = True                # tests set False so a post returns after its deliveries ran
IDLE_S, GONE_S = 120, 900          # presence from last activity: online < IDLE_S < idle < GONE_S < away


def now():
    return time.time()


def stamp(t=None):
    return time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(t or now()))


class Room:
    def __init__(self, rid):
        self.id = rid
        self.dir = os.path.join(ROOMS, rid)
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.meta = json.loads(slurp(os.path.join(self.dir, 'room.json')))
        self.msgs = []
        try:
            with open(os.path.join(self.dir, 'chat.jsonl')) as f:
                self.msgs = [json.loads(l) for l in f if l.strip()]
        except FileNotFoundError:
            pass
        self.seen = {}          # name -> last activity (memory only; joins and posts also land in room.json)

    # ------------------------------------------------------------ persistence (call with lock held)
    def save(self):
        p = os.path.join(self.dir, 'room.json')
        with open(p + '.tmp', 'w') as f:
            json.dump(self.meta, f, indent=1)
        os.replace(p + '.tmp', p)

    def add(self, frm, text, kind='msg', **extra):
        text = str(text)[:MAX_TEXT]
        mentions = sorted({self.canon(m) for m in re.findall(r'@([A-Za-z0-9][\w.-]*)', text)})
        msg = {'seq': (self.msgs[-1]['seq'] + 1) if self.msgs else 1, 'at': stamp(), 'from': frm, 'kind': kind,
               'text': text, 'mentions': mentions, **extra}
        self.msgs.append(msg)
        with open(os.path.join(self.dir, 'chat.jsonl'), 'a') as f:
            f.write(json.dumps(msg) + '\n')
        self.cond.notify_all()
        return msg

    def canon(self, typed):
        """A typed @name as the member's exact name: case-insensitive, trailing . or - (sentence end) dropped."""
        names = {n.lower(): n for n in (self.meta['admin'], HUMAN, *self.meta['invites'])}
        return names.get(typed.lower()) or names.get(typed.rstrip('.-').lower()) or typed

    # ------------------------------------------------------------ views
    def member(self, name):
        inv = self.meta['invites'].get(name)
        if not inv:
            return None
        last = self.seen.get(name) or inv.get('last_seen_epoch') or 0
        age = now() - last if last else None
        presence = ('invited' if not inv.get('accepted_at') else
                    'left' if inv.get('left_at') else
                    'online' if age is not None and age < IDLE_S else
                    'idle' if age is not None and age < GONE_S else 'away')
        return {'name': name, 'role': inv.get('role'), 'model': inv.get('model'), 'kind': inv.get('kind', 'agent'),
                'presence': presence, 'status': inv.get('status'), 'status_text': inv.get('status_text'),
                'invited_at': inv.get('invited_at'), 'accepted_at': inv.get('accepted_at'),
                'last_seen': stamp(last) if last else None}

    def view(self):
        m = self.meta
        members = [self.member(n) for n in m['invites']]
        members.insert(0, {'name': m['admin'], 'role': 'room admin', 'kind': 'admin', 'presence':
                           'online' if now() - self.seen.get(m['admin'], 0) < GONE_S else 'away'})
        members.append({'name': HUMAN, 'role': 'owner', 'kind': 'human', 'presence':
                        'online' if now() - self.seen.get(HUMAN, 0) < IDLE_S else 'away'})
        return {k: m.get(k) for k in ('id', 'name', 'purpose', 'brief', 'admin', 'project', 'created', 'closed',
                                       'summary', 'pins', 'theme')} | {'members': members, 'human': HUMAN,
                                                                       'asks': {k: v for k, v in (m.get('asks') or {}).items() if v.get('open')},
                                                                       'last_seq': self.msgs[-1]['seq'] if self.msgs else 0}

    def since(self, seq, limit=200):
        out = [x for x in self.msgs if x['seq'] > seq]
        return out[-limit:] if len(out) > limit else out

    def touch(self, name):
        self.seen[name] = now()
        inv = self.meta['invites'].get(name)
        if inv:
            inv['last_seen_epoch'] = self.seen[name]


ROOMS_LOCK = threading.Lock()
_rooms = {}


def get_room(rid):
    with ROOMS_LOCK:
        if rid not in _rooms:
            if not ID_RE.fullmatch(rid or '') or not os.path.isfile(os.path.join(ROOMS, rid, 'room.json')):
                raise LookupError(f'no room {rid!r}')
            _rooms[rid] = Room(rid)
        return _rooms[rid]


def list_rooms():
    out = []
    if os.path.isdir(ROOMS):
        for rid in sorted(os.listdir(ROOMS)):
            try:
                r = get_room(rid)
            except (LookupError, ValueError):
                continue
            v = r.view()
            out.append({k: v[k] for k in ('id', 'name', 'purpose', 'project', 'created', 'closed', 'last_seq')}
                       | {'online': sum(1 for x in v['members'] if x['presence'] == 'online'),
                          'members': len(v['members']), 'themed': bool((v['theme'] or {}).get('done'))})
    return out


class Err(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


def need(cond, code, msg):
    if not cond:
        raise Err(code, msg)


# ------------------------------------------------------------------ actions
def create(b):
    rid = b.get('id', '')
    need(isinstance(rid, str) and ID_RE.fullmatch(rid), 400, 'id: lowercase letters, digits and dashes, e.g. my-project')
    admin = b.get('admin', '')
    need(isinstance(admin, str) and NAME_RE.fullmatch(admin) and admin not in (HUMAN, 'system'), 400,
         'admin: the admin agent name (not the human)')
    d = os.path.join(ROOMS, rid)
    need(not os.path.exists(d), 409, f'room {rid} exists')
    os.makedirs(d)
    pub = os.path.join(d, 'public')
    os.makedirs(os.path.join(pub, 'art'))
    for f in ('index.html', 'theme.css'):
        shutil.copy(os.path.join(WEB, f), pub)
    for f in ('app.js', 'base.css'):
        os.symlink(os.path.join(WEB, f), os.path.join(pub, f))
    meta = {'id': rid, 'name': b.get('name') or rid, 'purpose': b.get('purpose', ''), 'brief': b.get('brief', ''),
            'project': b.get('project'), 'admin': b['admin'], 'created': stamp(), 'closed': None, 'summary': None,
            'invites': {}, 'pins': [], 'theme': {'done': False, 'notes': None}}
    with open(os.path.join(d, 'room.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    r = get_room(rid)
    with r.lock:
        r.add('system', f'{meta["admin"]} opened the room. Purpose: {meta["purpose"]}', kind='system')
    return r.view() | {'public_dir': pub, 'next': 'theme public/ (index.html, theme.css, art/), then theme_done'}


def admin_only(r, b):
    need(b.get('as') == r.meta['admin'], 403, f'only the room admin ({r.meta["admin"]}) can do that')
    need(not r.meta['closed'], 409, 'room is closed')


def theme_done(r, b):
    admin_only(r, b)
    pub = os.path.join(r.dir, 'public')
    css = slurp(os.path.join(pub, 'theme.css'))
    need(css != slurp(os.path.join(WEB, 'theme.css')), 409,
         'public/theme.css is still the default: give the room its own look first (the project\'s world, real art)')
    arts = [f for f in os.listdir(os.path.join(pub, 'art')) if not f.startswith('.')]
    need(arts, 409, 'public/art/ is empty: the theme needs the project\'s real art')
    with r.lock:
        r.meta['theme'] = {'done': True, 'notes': b.get('notes'), 'at': stamp(), 'art': len(arts)}
        r.save()
        r.add('system', f'The room has its look: {b.get("notes") or "themed"}.', kind='system')
    return r.meta['theme']


def invite(r, b):
    admin_only(r, b)
    need((r.meta.get('theme') or {}).get('done'), 409, 'theme the room first (theme_done): no invites before it has its own look')
    name = b.get('name', '')
    need(isinstance(name, str) and NAME_RE.fullmatch(name) and name not in (r.meta['admin'], HUMAN, 'system'), 400,
         f'bad member name {name!r}')
    kind = b.get('kind') or 'agent'
    need(kind in KINDS, 400, f'bad member kind {kind!r} (one of {", ".join(KINDS)})')
    with r.lock:
        inv = r.meta['invites'].setdefault(name, {})
        inv.update({'role': b.get('role'), 'model': b.get('model'), 'kind': kind,
                    'invited_at': stamp()})
        inv.pop('left_at', None)
        r.save()
        r.add('system', f'{r.meta["admin"]} invited {name}' + (f' as {b["role"]}' if b.get('role') else '') + '.',
              kind='system')
    return r.member(name)


def join(r, b):
    name = b.get('as', '')
    need(not r.meta['closed'], 409, 'room is closed')
    need(name in r.meta['invites'], 403, f'{name!r} is not invited to {r.id}. Invited: {", ".join(r.meta["invites"]) or "nobody yet"}')
    with r.lock:
        inv = r.meta['invites'][name]
        route_note = None
        if b.get('agent_id'):
            try:
                set_agent_id(r, name, b['agent_id'])
            except Err as e:
                route_note = f'agent id not recorded: {e}'
        first = not inv.get('accepted_at')
        inv['accepted_at'] = inv.get('accepted_at') or stamp()
        inv.pop('left_at', None)
        r.touch(name)
        r.save()
        if first:
            r.add('system', f'{name} accepted the invite and joined' + (f' ({inv["model"]})' if inv.get('model') else '') + '.',
                  kind='system')
        recent = r.since(0)[-15:]
        inv['cursor'] = r.msgs[-1]['seq'] if r.msgs else 0
        r.save()
    v = r.view()
    return {'welcome': f'Welcome to {v["name"]}, {name}. You are here as: {inv.get("role") or "member"}.',
            'purpose': v['purpose'], 'brief': v['brief'], 'pins': v['pins'],
            'members': [{k: m.get(k) for k in ('name', 'role', 'model', 'presence')} for m in v['members']],
            'recent': [slim(x) for x in recent], 'cursor': inv['cursor'],
            'how': ('room_post to share findings and ideas (@Name to address someone), room_read between work steps '
                    '(messages addressed to you come first), room_wait when you are waiting on someone, room_status '
                    'to say what you are doing. Keep posts short and concrete: addresses, numbers, what you checked.')} \
        | ({'route': route_note} if route_note else {})


def set_agent_id(r, name, aid):
    """Record which interactive agent session speaks as `name` (call with the lock held). One id per member."""
    need(AGENT_ID_RE.fullmatch(str(aid)), 400, f'bad agent id {aid!r} (e.g. claude-12345)')
    holders = {n: i.get('agent_id') for n, i in r.meta['invites'].items()} | {r.meta['admin']: r.meta.get('admin_agent_id')}
    other = next((n for n, i in holders.items() if i == aid and n != name), None)
    need(not other, 409, f'agent id {aid} is already {other} in {r.id}')
    if name == r.meta['admin']:
        r.meta['admin_agent_id'] = aid
    else:
        r.meta['invites'][name]['agent_id'] = aid


def route(r, b):
    """Delivery routes: a member (or the admin) records its own agent id (`agent_id`, '' clears it); the admin
    records the room's bounty board (`board`: the board's directory, whose slots' names are room members)."""
    name = b.get('as', '')
    member_or_admin(r, name)
    with r.lock:
        if 'agent_id' in b:
            if b['agent_id']:
                set_agent_id(r, name, b['agent_id'])
            elif name == r.meta['admin']:
                r.meta.pop('admin_agent_id', None)
            else:
                r.meta['invites'][name].pop('agent_id', None)
        if 'board' in b:
            need(name == r.meta['admin'], 403, f'only the room admin ({r.meta["admin"]}) sets the board')
            need(not b['board'] or os.path.isfile(os.path.join(b['board'], 'board.json')), 400, f'no board.json in {b["board"]}')
            r.meta['board'] = b['board'] or None
        r.touch(name)
        r.save()
    return {'name': name, 'agent_id': r.meta.get('admin_agent_id') if name == r.meta['admin'] else r.meta['invites'][name].get('agent_id'),
            'board': r.meta.get('board')}


# ------------------------------------------------------------------ direct delivery of @mentions
def delivery_text(r, msg, to):
    return (f'[Agent room {r.id} "{r.meta["name"]}"] {msg["from"]} wrote (msg #{msg["seq"]}): {msg["text"]}\n'
            f'Reply in the room, not here: roomctl post {r.id} --as {to} "..." (or room_post via the room MCP).')


def board_url(cfg):
    u = (cfg.get('url') or f'http://127.0.0.1:{cfg.get("port", 3777)}').rstrip('/')
    if urlparse(u).scheme not in ('http', 'https'):
        raise RuntimeError(f'board url must be http(s): {u!r}')
    return u


def send_agent(aid, text):
    import subprocess
    if not AGENT_SEND:
        raise RuntimeError('no session relay configured (AGENT_ROOMS_AGENT_SEND)')
    p = subprocess.run([AGENT_SEND, aid, text], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL,
                       env={k: v for k, v in os.environ.items() if k != 'OMARCHY_AGENT_ROOM_OUTBOX'})
    if p.returncode:
        raise RuntimeError((p.stderr or p.stdout).strip() or f'{AGENT_SEND} exited {p.returncode}')
    return p.stdout.strip()


def send_board_note(cfg, slot, text):
    """A note on the slot's in-progress bounty; None when the slot has no live bounty."""
    import urllib.request
    base = board_url(cfg)
    with urllib.request.urlopen(base + '/api/bounties', timeout=10) as f:
        bounties = json.loads(f.read())
    live = [x for x in bounties if x.get('status') == 'in_progress' and slot in (x.get('claimed_by'), x.get('assignee_slot'))]
    if not live:
        return None
    bid = live[0]['id']
    req = urllib.request.Request(f'{base}/api/bounties/{bid}/notes', json.dumps({'text': text}).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'X-Board-Request': '1', 'X-Bounty-Actor': 'agent-room'})
    urllib.request.urlopen(req, timeout=10).close()
    return bid


def deliveries(r, msg):
    """(member, how, target) for each member a message @mentions, once each, never the sender."""
    out, seen = [], {msg['from']}
    sender_aid = r.meta.get('admin_agent_id') if msg['from'] == r.meta['admin'] else (r.meta['invites'].get(msg['from']) or {}).get('agent_id')
    slots = {}
    if r.meta.get('board'):
        try:
            with open(os.path.join(r.meta['board'], 'board.json')) as f:
                cfg = json.load(f)
            slots = {s.get('name') or s['id']: (cfg, s['id']) for s in cfg.get('slots', [])}
        except (OSError, ValueError, KeyError) as e:
            print(f'agent-rooms: {r.id}: board {r.meta["board"]}: {e}', file=sys.stderr)
    for name in msg.get('mentions') or []:
        if name in seen or name == HUMAN or not (name == r.meta['admin'] or name in r.meta['invites']):
            continue
        seen.add(name)
        aid = r.meta.get('admin_agent_id') if name == r.meta['admin'] else r.meta['invites'][name].get('agent_id')
        if aid and aid != sender_aid:
            out.append((name, 'agent', aid))
        elif not aid and name in slots:
            out.append((name, 'board', slots[name]))
    return out


def deliver(r, msg):
    for name, how, target in deliveries(r, msg):
        rec = {'at': stamp(), 'seq': msg['seq'], 'to': name, 'via': how}
        try:
            text = delivery_text(r, msg, name)
            if how == 'agent':
                rec['agent_id'] = target
                rec['ok'], rec['sent'] = True, send_agent(target, text)
            else:
                cfg, slot = target
                rec['slot'] = slot
                bid = send_board_note(cfg, slot, text)
                rec['ok'], rec['bounty'] = bid is not None, bid
                if bid is None:
                    rec['skipped'] = 'no in-progress bounty'
        except Exception as e:
            rec['ok'], rec['error'] = False, f'{type(e).__name__}: {e}'
            print(f'agent-rooms: {r.id} #{msg["seq"]} -> {name} ({how}): {rec["error"]}', file=sys.stderr)
        try:
            with open(os.path.join(r.dir, 'deliveries.jsonl'), 'a') as f:
                f.write(json.dumps(rec) + '\n')
        except OSError:
            pass


def deliver_later(r, msg):
    if not msg.get('mentions'):
        return
    if DELIVER_ASYNC:
        threading.Thread(target=deliver, args=(r, msg), daemon=True).start()
    else:
        deliver(r, msg)


def slim(x, cap=1500):
    t = x['text'] if len(x['text']) <= cap else x['text'][:cap] + f' [... {len(x["text"]) - cap} more chars, room_message seq={x["seq"]}]'
    return {'seq': x['seq'], 'at': x['at'][11:], 'from': x['from'], 'text': t} | ({'kind': x['kind']} if x['kind'] != 'msg' else {})


def member_or_admin(r, name):
    need(name == r.meta['admin'] or name in r.meta['invites'] and r.meta['invites'][name].get('accepted_at'), 403,
         f'{name!r} has not joined {r.id}: room_join first')


def post(r, b):
    name = b.get('as', '')
    need(not r.meta['closed'], 409, 'room is closed')
    text = (b.get('text') or '').strip()
    need(text, 400, 'empty message')
    if name != HUMAN:
        member_or_admin(r, name)
    with r.lock:
        r.touch(name)
        msg = r.add(name, text)
        r.save()
    deliver_later(r, msg)
    return {'seq': msg['seq']}


def read(r, b):
    """New messages for `as` since its cursor (mentions of it first), capped; advances the cursor."""
    name = b.get('as', '')
    member_or_admin(r, name)
    limit = max(1, min(int(b.get('limit', 30)), 100))
    budget = int(b.get('max_chars', 12000))
    with r.lock:
        rec = r.meta['invites'].get(name) or r.meta.setdefault('admin_state', {})
        cur = int(b['since']) if b.get('since') is not None else rec.get('cursor', 0)
        new = [x for x in r.since(cur, 10_000) if x['from'] != name]
        # an in-order window from the cursor (so the cursor never skips anything), then the window's messages
        # addressed to this reader (or from the human) are moved to the top
        window, used = [], 0
        for x in new:
            s = slim(x)
            if window and (len(window) >= limit or used + len(s['text']) > budget):
                break
            window.append((x, s))
            used += len(s['text'])
        if window:
            rec['cursor'] = window[-1][0]['seq']
        elif r.msgs:
            rec['cursor'] = r.msgs[-1]['seq']
        later = new[len(window):]
        for_me = lambda x: name.lower() in {n.lower() for n in x['mentions']} or x['from'] == HUMAN
        out = [s for x, s in window if for_me(x)] + [s for x, s in window if not for_me(x)]
        r.touch(name)
        r.save()
    return {'messages': out, 'more': len(later), 'more_for_you': sum(1 for x in later if for_me(x)),
            'cursor': rec['cursor']}


def message(r, q):
    seq = int(q.get('seq', 0))
    for x in r.msgs:
        if x['seq'] == seq:
            return x
    raise Err(404, f'no message {seq}')


def wait(r, q):
    """Block until a message newer than `since` arrives (from someone else than `me`), or timeout."""
    since = int(q.get('since', 0))
    me = q.get('me')
    t_end = now() + max(1, min(float(q.get('timeout', 25)), 45))
    with r.cond:
        if me and (me in (r.meta['admin'], HUMAN) or me in r.meta['invites']):
            r.touch(me)
        while True:
            new = [x for x in r.since(since, 500) if x['from'] != me]
            if new or now() >= t_end:
                return {'messages': new, 'last_seq': r.msgs[-1]['seq'] if r.msgs else 0}
            r.cond.wait(t_end - now())


def status(r, b):
    name = b.get('as', '')
    member_or_admin(r, name)
    with r.lock:
        r.touch(name)
        inv = r.meta['invites'].get(name)
        if inv is not None:
            inv['status'], inv['status_text'] = b.get('status'), (b.get('text') or '')[:200]
            if b.get('status') == 'left':
                inv['left_at'] = stamp()
                r.add('system', f'{name} left the room' + (f': {b["text"]}' if b.get('text') else '.'), kind='system')
        r.save()
    return r.member(name) or {'name': name}


def pin(r, b):
    """Any joined member (or the admin, or the human from the page) pins; the pin carries who pinned it."""
    name = b.get('as', '')
    need(not r.meta['closed'], 409, 'room is closed')
    if name != HUMAN:
        member_or_admin(r, name)
    text = b.get('text')
    if b.get('seq'):
        m = message(r, {'seq': b['seq']})
        text = text or f'{m["from"]}: {m["text"]}'
    need(text, 400, 'pin needs text or seq')
    with r.lock:
        pid = max([x.get('id', 0) for x in r.meta['pins']] + [0]) + 1
        p = {'id': pid, 'text': text[:2000], 'by': name, 'at': stamp(), 'seq': b.get('seq')}
        r.meta['pins'].append(p)
        r.save()
        r.add('system', f'📌 {name} pinned: {text[:300]}', kind='pin')
    return p


def unpin(r, b):
    """The pin's author, the admin or the human can unpin (by pin id)."""
    name = b.get('as', '')
    with r.lock:
        p = next((x for x in r.meta['pins'] if x.get('id') == int(b.get('id', 0))), None)
        need(p, 404, f'no pin {b.get("id")} (ids: {[x.get("id") for x in r.meta["pins"]]})')
        need(name in (p['by'], r.meta['admin'], HUMAN), 403, f'only {p["by"]}, the admin or {HUMAN} can unpin it')
        r.meta['pins'].remove(p)
        r.save()
        r.add('system', f'{name} unpinned: {p["text"][:200]}', kind='system')
    return {'unpinned': p['id']}


def notify(title, body):
    """Desktop notification for the human (best effort: the room works without it)."""
    try:
        import subprocess
        subprocess.Popen(['notify-send', '-a', 'Agent Room', '-u', 'critical', '-i', 'dialog-question', '--', title, body[:400]],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        pass


def ask(r, b):
    """A member needs the human to do something (or decide something) on cue: posts a highlighted ask,
    shows a banner with Done / Can't now on the page and fires a desktop notification."""
    name = b.get('as', '')
    need(not r.meta['closed'], 409, 'room is closed')
    member_or_admin(r, name)
    text = (b.get('text') or '').strip()
    need(text, 400, 'empty ask')
    with r.lock:
        r.touch(name)
        m = r.add(name, f'@{HUMAN} {text}', kind='ask')
        r.meta.setdefault('asks', {})[str(m['seq'])] = {'from': name, 'text': text, 'at': m['at'], 'open': True}
        r.save()
    notify(f'{r.meta["name"]}: {name} needs you', text)
    return {'seq': m['seq'], 'note': f'{HUMAN} was notified; room_wait for the answer (it mentions you and comes first)'}


def answer(r, b):
    """The human answers an ask (from the page: Done / Can't now / text). Posts the reply addressed to the asker."""
    name = b.get('as', '')
    need(name in (HUMAN, r.meta['admin']), 403, 'only the human (or the room admin) answers an ask')
    with r.lock:
        a = (r.meta.get('asks') or {}).get(str(b.get('seq')))
        need(a, 404, f'no ask #{b.get("seq")}')
        reply = (b.get('text') or '').strip() or 'done'
        a.update(open=False, answer=reply, answered_at=stamp(), answered_by=name)
        m = r.add(name, f'@{a["from"]} re #{b["seq"]}: {reply}', reply_to=int(b['seq']))
        r.touch(name)
        r.save()
    deliver_later(r, m)
    return {'seq': m['seq']}


def close(r, b):
    admin_only(r, b)
    with r.lock:
        r.meta['closed'], r.meta['summary'] = stamp(), b.get('summary')
        r.add('system', f'{b["as"]} closed the room.' + (f' Summary: {b["summary"]}' if b.get('summary') else ''),
              kind='system')
        r.save()
    return r.view()


ACTIONS = {'invite': invite, 'join': join, 'route': route, 'post': post, 'read': read, 'status': status, 'pin': pin, 'unpin': unpin,
           'ask': ask, 'answer': answer, 'theme_done': theme_done, 'close': close}


# ------------------------------------------------------------------ http
def slurp(path, mode='r'):
    with open(path, mode) as f:
        return f.read()


def host_ok(value):
    """A Host (or Origin host) this server may be addressed by. A page that rebinds its own DNS name to this
    machine still sends its own name, so it is refused even though the TCP peer is loopback."""
    h = (value or '').strip().lower()
    if h.startswith('['):
        h = h[1:h.find(']')] if ']' in h else ''
    elif h.count(':') == 1:
        h = h.split(':')[0]
    h = h.rstrip('.')
    if not h:
        return False
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        pass
    return h in HOSTNAMES or h.endswith('.localhost')


class H(BaseHTTPRequestHandler):
    timeout = 60                    # a client that stops sending mid-request can't hold a thread forever

    def log_message(self, *_):
        pass

    def allowed(self):
        try:
            ip = ipaddress.ip_address(self.client_address[0])
        except ValueError:
            return False
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        return any(ip in n for n in ALLOW) and host_ok(self.headers.get('Host'))

    def send_json(self, code, obj):
        data = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def frame_ancestors(self):
        """Who may put a room page in a frame (a board's Chat tab): this machine's own names, nobody else.
        CSP cannot name an IP range, so a tailnet IP parent (100.64.0.0/10) that is also in the allow list is allowed
        by its own Referer origin."""
        out = frame_ancestors_base()
        ref = urlparse(self.headers.get('Referer') or '')
        try:
            ip = ipaddress.ip_address(ref.hostname or '')
            if ref.scheme in ('http', 'https') and ip.version == 4 and ip in TAILNET_V4 and any(ip in n for n in ALLOW):
                out.append(f'{ref.scheme}://{ip}' + (f':{ref.port}' if ref.port else ''))
        except ValueError:
            pass
        return 'frame-ancestors ' + ' '.join(out)

    def send_file(self, path):
        data = slurp(path, 'rb')
        self.send_response(200)
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        self.send_header('Content-Type', ctype)
        if ctype == 'text/html':
            self.send_header('Content-Security-Policy', self.frame_ancestors())
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if not self.allowed():
            return self.send_json(403, {'error': 'not in the allow list, or not addressed to this machine'})
        u = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(u.query).items()}
        parts = [p for p in u.path.split('/') if p]
        try:
            if not parts:
                return self.send_file(os.path.join(WEB, 'rooms.html'))
            if parts == ['api', 'rooms']:
                return self.send_json(200, list_rooms())
            if parts[0] == 'api' and len(parts) >= 3 and parts[1] == 'r':
                r = get_room(parts[2])
                sub = parts[3] if len(parts) > 3 else ''
                if sub == '':
                    if q.get('me') == HUMAN:
                        with r.lock:
                            r.touch(HUMAN)
                    return self.send_json(200, r.view())
                if sub == 'messages':
                    return self.send_json(200, r.since(int(q.get('since', 0)), int(q.get('limit', 500))))
                if sub == 'message':
                    return self.send_json(200, message(r, q))
                if sub == 'wait':
                    return self.send_json(200, wait(r, q))
                raise Err(404, 'unknown endpoint')
            if parts[0] == 'r' and len(parts) >= 2:
                if self.path.rstrip('?').endswith('/r/' + parts[1]):
                    self.send_response(301)
                    self.send_header('Location', f'/r/{parts[1]}/')
                    self.end_headers()
                    return
                r = get_room(parts[1])
                pub = os.path.realpath(os.path.join(r.dir, 'public'))
                rel = '/'.join(parts[2:]) or 'index.html'
                fp = os.path.realpath(os.path.join(pub, rel))
                webroot = os.path.realpath(WEB)
                if not (fp.startswith(pub + os.sep) or fp.startswith(webroot + os.sep)) or not os.path.isfile(fp):
                    raise Err(404, 'not found')
                return self.send_file(fp)
            fp = os.path.realpath(os.path.join(WEB, *parts))
            if fp.startswith(os.path.realpath(WEB) + os.sep) and os.path.isfile(fp):
                return self.send_file(fp)
            raise Err(404, 'not found')
        except Err as e:
            return self.send_json(e.code, {'error': str(e)})
        except LookupError as e:
            return self.send_json(404, {'error': str(e)})
        except Exception as e:
            return self.send_json(500, {'error': f'{type(e).__name__}: {e}'})

    def do_POST(self):
        if not self.allowed():
            return self.send_json(403, {'error': 'not in the allow list, or not addressed to this machine'})
        if self.headers.get('X-Room-Request') != '1' or 'application/json' not in (self.headers.get('Content-Type') or ''):
            return self.send_json(403, {'error': 'needs X-Room-Request: 1 and a JSON body'})
        origin = self.headers.get('Origin')
        if origin and not host_ok(urlparse(origin).netloc):
            return self.send_json(403, {'error': 'cross-origin request refused'})
        parts = [p for p in urlparse(self.path).path.split('/') if p]
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return self.send_json(400, {'error': 'bad Content-Length'})
        if n < 0 or n > MAX_BODY:
            self.close_connection = True
            return self.send_json(413, {'error': f'body over {MAX_BODY} bytes'})
        try:
            b = json.loads(self.rfile.read(n) or b'{}')
            if parts == ['api', 'rooms']:
                return self.send_json(200, create(b))
            if len(parts) == 4 and parts[:2] == ['api', 'r'] and parts[3] in ACTIONS:
                r = get_room(parts[2])
                if self.headers.get('X-Room-Web') == '1':      # the web page always speaks as the human
                    b['as'] = HUMAN
                return self.send_json(200, ACTIONS[parts[3]](r, b))
            raise Err(404, 'unknown endpoint')
        except Err as e:
            return self.send_json(e.code, {'error': str(e)})
        except LookupError as e:
            return self.send_json(404, {'error': str(e)})
        except Exception as e:
            return self.send_json(500, {'error': f'{type(e).__name__}: {e}'})


def main():
    os.umask(0o077)                 # chat, members and delivery logs are private to this user
    HOSTNAMES.update(n for n in _tailnet_name() if HOST_NAME_RE.fullmatch(n))
    os.makedirs(ROOMS, exist_ok=True)
    host = os.environ.get('AGENT_ROOMS_HOST', '127.0.0.1')
    srv = ThreadingHTTPServer((host, PORT), H)
    srv.daemon_threads = True
    print(f'agent-rooms on http://{host}:{PORT} rooms={ROOMS}', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
