"""agent-rooms end to end on a temp rooms dir: admin flow, theme gate, invites, join, mentions-first reads, wait,
web posting rules, and the MCP stdio front."""
import json, os, shutil, subprocess, sys, tempfile, threading, time, unittest, urllib.request, urllib.error
from http.server import ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = tempfile.mkdtemp(prefix='rooms-test-')
os.environ['AGENT_ROOMS_DIR'] = TMP
os.environ['AGENT_ROOMS_HUMAN'] = 'Human'          # fixed names for the tests, whatever config.env says
os.environ['AGENT_ROOMS_ALLOW'] = '127.0.0.0/8,::1/128,100.64.0.0/10'
os.environ['AGENT_ROOMS_HOSTNAMES'] = 'box.tail1234.ts.net'
os.environ['AGENT_ROOMS_CONFIG'] = '/dev/null'      # never the developer's own config.env
sys.path.insert(0, ROOT)
import roomd  # noqa: E402
from http.server import BaseHTTPRequestHandler  # noqa: E402

roomd.AGENT_SEND = '/nonexistent/agent-send'     # no real sends from tests, ever
roomd.DELIVER_ASYNC = False


class RoomsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        roomd.notify = lambda title, body: None          # never a real desktop notification from a test
        cls.srv = ThreadingHTTPServer(('127.0.0.1', 0), roomd.H)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.srv.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        shutil.rmtree(TMP, ignore_errors=True)

    def req(self, path, body=None, headers=None, method=None):
        h = {'Content-Type': 'application/json', 'X-Room-Request': '1'} if body is not None else {}
        h.update(headers or {})
        r = urllib.request.Request(self.url + path, None if body is None else json.dumps(body).encode(), h, method=method)
        try:
            with urllib.request.urlopen(r, timeout=20) as f:
                return f.status, json.loads(f.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def act(self, a, body, **kw):
        return self.req(f'/api/r/t1/{a}', body, **kw)

    def test_flow(self):
        s, v = self.req('/api/rooms', {'id': 't1', 'name': 'Test Room', 'purpose': 'find the thing', 'brief': '# b', 'admin': 'Host'})
        self.assertEqual(s, 200, v)
        pub = v['public_dir']
        self.assertTrue(os.path.islink(os.path.join(pub, 'app.js')))
        self.assertEqual(self.act('invite', {'as': 'Host', 'name': 'A'})[0], 409)          # not themed
        self.assertEqual(self.act('theme_done', {'as': 'Host'})[0], 409)                    # default css
        with open(os.path.join(pub, 'theme.css'), 'a') as f:
            f.write('body{background:#000}')
        self.assertEqual(self.act('theme_done', {'as': 'Host'})[0], 409)                    # no art
        open(os.path.join(pub, 'art', 'crest.png'), 'wb').write(b'x')
        self.assertEqual(self.act('theme_done', {'as': 'A'})[0], 403)                       # not admin
        self.assertEqual(self.act('theme_done', {'as': 'Host', 'notes': 'test look'})[0], 200)
        for n in ('A', 'B'):
            self.assertEqual(self.act('invite', {'as': 'Host', 'name': n, 'role': 'scanner', 'model': 'm'})[0], 200)
        self.assertEqual(self.act('join', {'as': 'Mallory'})[0], 403)
        self.assertEqual(self.act('post', {'as': 'A', 'text': 'hi'})[0], 403)             # not joined yet
        s, w = self.act('join', {'as': 'A'})
        self.assertEqual(s, 200)
        self.assertEqual(w['purpose'], 'find the thing')
        self.assertTrue(any('invited A' in m['text'] for m in w['recent']))
        self.act('join', {'as': 'B'})
        self.act('read', {'as': 'A'})
        self.act('post', {'as': 'B', 'text': 'general note'})
        self.act('post', {'as': 'B', 'text': '@A can you check 0x10?'})
        s, r = self.act('read', {'as': 'A'})
        self.assertEqual(r['messages'][0]['text'], '@A can you check 0x10?')               # mention first
        self.assertEqual(self.act('read', {'as': 'A'})[1]['messages'], [])                   # cursor advanced
        # hand-typed mentions match member names case-insensitively, a sentence's trailing dot dropped
        s, p = self.act('post', {'as': 'B', 'text': '@a and @host. and @human, @nobody'})
        self.assertEqual(roomd.get_room('t1').msgs[-1]['mentions'], ['A', 'Host', 'Human', 'nobody'])
        s, r = self.act('read', {'as': 'A'})
        self.assertEqual(r['messages'][0]['text'], '@a and @host. and @human, @nobody')
        # wait wakes on a post
        out = {}
        t = threading.Thread(target=lambda: out.update(w=self.req(f'/api/r/t1/wait?since={r["cursor"]}&me=A&timeout=10')))
        t.start(); time.sleep(0.3)
        t0 = time.time(); self.act('post', {'as': 'B', 'text': 'ping'}); t.join()
        self.assertLess(time.time() - t0, 3)
        self.assertEqual(out['w'][1]['messages'][-1]['text'], 'ping')
        # web: needs the header; speaks as the human whatever it claims
        s, _ = self.req('/api/r/t1/post', {'text': 'x'}, headers={'X-Room-Request': '0'})
        self.assertEqual(s, 403)
        s, p = self.act('post', {'as': 'Host', 'text': 'from the page'}, headers={'X-Room-Web': '1'})
        self.assertEqual(s, 200)
        self.assertEqual(roomd.get_room('t1').msgs[-1]['from'], 'Human')
        s, r = self.act('read', {'as': 'A'})
        self.assertEqual(r['messages'][0]['from'], 'Human')                                   # human first
        self.assertEqual(self.act('pin', {'as': 'Host', 'seq': p['seq']})[0], 200)
        s, v = self.req('/api/r/t1')
        self.assertEqual(len(v['pins']), 1)
        self.assertEqual({m['name'] for m in v['members']}, {'Host', 'A', 'B', 'Human'})
        s, html = 0, urllib.request.urlopen(self.url + '/r/t1/').read()
        self.assertIn(b'id="member-list"', html)
        js = urllib.request.urlopen(self.url + '/r/t1/app.js').read()
        self.assertIn(b'mention-list', js)                                                 # @name autocomplete
        self.assertIn(b'.mention-list', urllib.request.urlopen(self.url + '/r/t1/base.css').read())
        self.assertEqual(self.act('close', {'as': 'Host', 'summary': 'done'})[0], 200)
        self.assertEqual(self.act('post', {'as': 'A', 'text': 'late'})[0], 409)

    def test_ask_and_pins(self):
        sent = []
        roomd.notify = lambda title, body: sent.append((title, body))
        s, v = self.req('/api/rooms', {'id': 'a1', 'purpose': 'asks', 'admin': 'Host'})
        open(os.path.join(v['public_dir'], 'theme.css'), 'a').write('/* x */')
        open(os.path.join(v['public_dir'], 'art', 'a.png'), 'wb').write(b'x')
        act = lambda a, b, **kw: self.req(f'/api/r/a1/{a}', b, **kw)
        act('theme_done', {'as': 'Host'})
        act('invite', {'as': 'Host', 'name': 'Leg'}); act('invite', {'as': 'Host', 'name': 'Other'})
        act('join', {'as': 'Leg'}); act('join', {'as': 'Other'})
        s, a = act('ask', {'as': 'Leg', 'text': 'hold still 10 s'})
        self.assertEqual(s, 200)
        self.assertEqual(len(sent), 1)
        self.assertIn(str(a['seq']), self.req('/api/r/a1')[1]['asks'])                   # open ask on the page
        s, _ = act('answer', {'seq': a['seq'], 'text': 'done'}, headers={'X-Room-Web': '1'})
        self.assertEqual(s, 200)
        self.assertEqual(self.req('/api/r/a1')[1]['asks'], {})
        r = act('read', {'as': 'Leg'})[1]['messages']
        self.assertTrue(r[0]['text'].startswith('@Leg re #'))                              # the answer comes first
        s, p = act('pin', {'as': 'Leg', 'text': 'found it'})                               # members pin, under their name
        self.assertEqual((s, p['by']), (200, 'Leg'))
        self.assertEqual(act('unpin', {'as': 'Other', 'id': p['id']})[0], 403)
        self.assertEqual(act('unpin', {'as': 'Leg', 'id': p['id']})[0], 200)
        self.assertEqual(self.req('/api/r/a1')[1]['pins'], [])

    def test_delivery(self):
        # @mentions reach members directly: agent id -> omarchy-agent-send (a fake here), board slot -> a note on
        # its in-progress bounty (a fake board), else chat only; never the sender, one delivery per member.
        d = tempfile.mkdtemp(dir=TMP)
        sends = os.path.join(d, 'sends.jsonl')
        fake = os.path.join(d, 'fake-send')
        with open(fake, 'w') as f:
            f.write(f'#!{sys.executable}\nimport json, sys\nopen({sends!r}, "a").write(json.dumps(sys.argv[1:]) + "\\n")\n'
                    'sys.exit(3 if sys.argv[1] == "claude-dead" else 0)\n')
        os.chmod(fake, 0o755)
        roomd.AGENT_SEND = fake
        notes = []

        class Board(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                body = json.dumps([{'id': 7, 'status': 'in_progress', 'claimed_by': 'slot-w', 'assignee_slot': 'slot-w'},
                                   {'id': 8, 'status': 'done', 'claimed_by': 'slot-idle'}]).encode()
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                notes.append((self.path, self.headers.get('X-Board-Request'),
                              json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(b'{}')
        bsrv = ThreadingHTTPServer(('127.0.0.1', 0), Board)
        threading.Thread(target=bsrv.serve_forever, daemon=True).start()
        try:
            board = os.path.join(d, 'board')
            os.makedirs(board)
            with open(os.path.join(board, 'board.json'), 'w') as f:
                json.dump({'port': bsrv.server_address[1], 'slots': [{'id': 'slot-w', 'name': 'Worker'},
                                                                     {'id': 'slot-idle', 'name': 'Idle'}]}, f)
            s, v = self.req('/api/rooms', {'id': 'd1', 'name': 'Deliver Room', 'purpose': 'p', 'admin': 'Boss'})
            open(os.path.join(v['public_dir'], 'theme.css'), 'a').write('/* x */')
            open(os.path.join(v['public_dir'], 'art', 'a.png'), 'wb').write(b'x')
            act = lambda a, b: self.req(f'/api/r/d1/{a}', b)
            act('theme_done', {'as': 'Boss'})
            for n in ('Ann', 'Bob', 'Worker', 'Idle', 'Plain', 'Dead'):
                act('invite', {'as': 'Boss', 'name': n})
            self.assertEqual(act('join', {'as': 'Ann', 'agent_id': 'claude-111'})[0], 200)
            self.assertIn('already Ann', act('join', {'as': 'Bob', 'agent_id': 'claude-111'})[1]['route'])  # one id each
            for n in ('Worker', 'Idle', 'Plain'):
                act('join', {'as': n})
            act('join', {'as': 'Dead', 'agent_id': 'claude-dead'})
            self.assertEqual(act('route', {'as': 'Boss', 'agent_id': 'claude-999'})[0], 200)           # admin's own id
            self.assertEqual(act('route', {'as': 'Ann', 'board': board})[0], 403)                      # admin only
            self.assertEqual(act('route', {'as': 'Boss', 'board': board})[0], 200)
            s, p = act('post', {'as': 'Bob', 'text': '@ann @Ann @boss @Worker @Idle @Plain @Bob @Human @Dead look'})
            self.assertEqual(s, 200)                                                                    # failures never block
            with open(sends) as f:
                got = [json.loads(l) for l in f]
            self.assertEqual(sorted(g[0] for g in got), ['claude-111', 'claude-999', 'claude-dead'])   # once each
            ann = next(g[1] for g in got if g[0] == 'claude-111')
            first, second = ann.split('\n')
            self.assertEqual(first, f'[Agent room d1 "Deliver Room"] Bob wrote (msg #{p["seq"]}): '
                                    '@ann @Ann @boss @Worker @Idle @Plain @Bob @Human @Dead look')
            self.assertEqual(second, 'Reply in the room, not here: roomctl post d1 --as Ann "..." (or room_post via the room MCP).')
            self.assertEqual(len(notes), 1)                                                             # Worker only; Idle has no live bounty
            self.assertEqual(notes[0][:2], ('/api/bounties/7/notes', '1'))
            self.assertIn('--as Worker', notes[0][2]['text'])
            with open(os.path.join(TMP, 'd1', 'deliveries.jsonl')) as f:
                log = {x['to']: x for x in map(json.loads, f)}
            self.assertEqual(set(log), {'Ann', 'Boss', 'Worker', 'Idle', 'Dead'})
            self.assertFalse(log['Dead']['ok']); self.assertIn('error', log['Dead'])
            self.assertEqual(log['Idle']['skipped'], 'no in-progress bounty')
            # the sender is never delivered its own message, even when it mentions itself
            open(sends, 'w').close()
            act('post', {'as': 'Ann', 'text': '@Ann note to self'})
            self.assertEqual(open(sends).read(), '')
        finally:
            bsrv.shutdown()
            roomd.AGENT_SEND = '/nonexistent/agent-send'

    def test_request_guards(self):
        """DNS rebinding (a foreign Host), a cross-origin Origin, oversized bodies and unknown member kinds are refused."""
        pub = self.req('/api/rooms', {'id': 'g1', 'name': 'Guards', 'purpose': 'p', 'admin': 'Host'})[1]['public_dir']
        self.assertEqual(self.req('/api/rooms', headers={'Host': 'attacker.example:3396'})[0], 403)
        self.assertEqual(self.req('/api/r/g1/post', {'as': 'Host', 'text': 'x'}, headers={'Host': 'evil.test'})[0], 403)
        for ok in ('localhost:1', '127.0.0.1:2', '[::1]:3', 'box.tail1234.ts.net:4', 'app.localhost'):
            self.assertEqual(self.req('/api/rooms', headers={'Host': ok})[0], 200, ok)
        self.assertEqual(self.req('/api/rooms', headers={'Host': 'other.tail9999.ts.net'})[0], 403)   # not ours
        self.assertEqual(self.req('/api/r/g1/post', {'as': 'Host', 'text': 'x'},
                                  headers={'Origin': 'https://attacker.example'})[0], 403)
        self.assertEqual(self.req('/api/r/g1/post', {'as': 'Host', 'text': 'x'}, headers={'Origin': self.url})[0], 200)
        # an oversized body is refused from its Content-Length alone (headers only, so the close can't race the send)
        import socket as so
        with so.create_connection(('127.0.0.1', self.srv.server_address[1]), timeout=10) as c:
            c.sendall(f'POST /api/r/g1/post HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
                      f'X-Room-Request: 1\r\nContent-Length: {roomd.MAX_BODY + 10}\r\n\r\n'.encode())
            self.assertIn(b' 413 ', c.recv(4096).split(b'\r\n')[0] + b' ')
        with open(os.path.join(pub, 'theme.css'), 'a') as f:
            f.write('body{background:#111}')
        open(os.path.join(pub, 'art', 'crest.png'), 'wb').write(b'x')
        self.assertEqual(self.req('/api/r/g1/theme_done', {'as': 'Host'})[0], 200)
        s, v = self.req('/api/r/g1/invite', {'as': 'Host', 'name': 'K', 'kind': 'x"><img src=x onerror=alert(1)>'})
        self.assertEqual(s, 400, v)
        for k in roomd.KINDS:
            self.assertEqual(self.req('/api/r/g1/invite', {'as': 'Host', 'name': f'K-{k}', 'kind': k})[0], 200, k)

    def test_validation(self):
        """Trailing newlines in ids and names, the human's name as admin, non-http board urls, answers by members."""
        self.assertEqual(self.req('/api/rooms', {'id': 'v1\n', 'purpose': 'p', 'admin': 'Host'})[0], 400)
        self.assertEqual(self.req('/api/rooms', {'id': 'v1', 'purpose': 'p', 'admin': 'Human'})[0], 400)
        self.assertEqual(self.req('/api/rooms', {'id': 'v1', 'purpose': 'p', 'admin': 'Host\n'})[0], 400)
        self.assertIsNone(roomd.AGENT_ID_RE.fullmatch('claude-1\n'))
        with self.assertRaises(RuntimeError):
            roomd.board_url({'url': 'file:///etc'})
        self.assertEqual(roomd.board_url({'port': 3777}), 'http://127.0.0.1:3777')
        pub = self.req('/api/rooms', {'id': 'v1', 'purpose': 'p', 'admin': 'Host'})[1]['public_dir']
        with open(os.path.join(pub, 'theme.css'), 'a') as f:
            f.write('body{background:#222}')
        open(os.path.join(pub, 'art', 'crest.png'), 'wb').write(b'x')
        self.req('/api/r/v1/theme_done', {'as': 'Host'})
        self.req('/api/r/v1/invite', {'as': 'Host', 'name': 'M'})
        self.req('/api/r/v1/join', {'as': 'M'})
        seq = self.req('/api/r/v1/ask', {'as': 'M', 'text': 'approve it'})[1]['seq']
        self.assertEqual(self.req('/api/r/v1/answer', {'as': 'system', 'seq': seq})[0], 403)
        self.assertEqual(self.req('/api/r/v1/answer', {'as': 'M', 'seq': seq})[0], 403)
        self.assertEqual(self.req('/api/r/v1/answer', {'as': 'Human', 'seq': seq, 'wait_s': 0})[0], 200)
        self.req('/api/r/v1/wait?me=nobody-at-all&timeout=1')
        self.assertNotIn('nobody-at-all', roomd.get_room('v1').seen)

    def test_frame_ancestors(self):
        # board Chat tabs frame the room page: loopback and tailnet parents only
        self.req('/api/rooms', {'id': 'f1', 'purpose': 'p', 'admin': 'Host'})

        def csp(ref=None):
            r = urllib.request.Request(self.url + '/r/f1/', headers={'Referer': ref} if ref else {})
            with urllib.request.urlopen(r) as f:
                return f.headers.get('Content-Security-Policy'), f.headers.get('X-Frame-Options')
        c, xfo = csp()
        self.assertIsNone(xfo)
        self.assertTrue(c.startswith("frame-ancestors 'self' http://127.0.0.1:* http://localhost:* "), c)
        self.assertIn(' https://box.tail1234.ts.net:*', c)
        self.assertNotIn('*.ts.net', c)
        self.assertTrue(csp('http://100.101.7.9:3788/')[0].endswith(' http://100.101.7.9:3788'))   # tailnet IP board
        self.assertEqual(csp('http://evil.example:3788/')[0], c)                                     # not added
        self.assertEqual(csp('http://192.168.1.5:3788/')[0], c)
        with urllib.request.urlopen(self.url + '/r/f1/app.js') as f:
            self.assertIsNone(f.headers.get('Content-Security-Policy'))                              # pages only

    def test_board_sync(self):
        # board-sync invites the slots and the board itself (kind board, joined), records the board, writes
        # "room" into board.json touching no other byte; a board post @mentioning the orchestrator is delivered.
        d = tempfile.mkdtemp(dir=TMP)
        sends = os.path.join(d, 'sends.jsonl')
        fake = os.path.join(d, 'fake-send')
        with open(fake, 'w') as f:
            f.write(f'#!{sys.executable}\nimport json, sys\nopen({sends!r}, "a").write(json.dumps(sys.argv[1:]) + "\\n")\n')
        os.chmod(fake, 0o755)
        s, v = self.req('/api/rooms', {'id': 'bs1', 'name': 'Sync Room', 'purpose': 'p', 'admin': 'Orch'})
        open(os.path.join(v['public_dir'], 'theme.css'), 'a').write('/* x */')
        open(os.path.join(v['public_dir'], 'art', 'a.png'), 'wb').write(b'x')
        self.req('/api/r/bs1/theme_done', {'as': 'Orch'})
        board = os.path.join(d, 'board')
        os.makedirs(board)
        path = os.path.join(board, 'board.json')
        env = dict(os.environ, AGENT_ROOMS_URL=self.url)
        env.pop('OMARCHY_AGENT_ROOM_OUTBOX', None)
        ctl = lambda *args: subprocess.run([sys.executable, os.path.join(ROOT, 'roomctl'), *args], env=env,
                                           capture_output=True, text=True, timeout=60)
        # the rule as board-sync writes it, so the file below is already current apart from "room"
        with open(path, 'w') as f:
            f.write('{"port": 3999, "default_project": "my-proj",\n  "slots": [ {"id": "s-1", "name": "Wren"} ],\n'
                    '  "machine_rules": []\n}\n')
        out = ctl('board-sync', 'bs1', '--admin', 'Orch', '--board-dir', board, '--dry-run')
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('My Proj: would invite the board itself', out.stdout)
        rule = out.stdout.split('would set machine rule:\n', 1)[1].strip()
        original = ('{"port": 3999, "default_project": "my-proj",   "odd":[1,2.50, "\u00e9"],\n'
                    '  "slots": [ {"id": "s-1", "name": "Wren"} ],\n  "machine_rules": ' + json.dumps([rule]) + '\n}\n')
        with open(path, 'w') as f:
            f.write(original)
        self.assertEqual(self.req('/api/r/bs1')[1]['members'][-1]['name'], 'Human')
        out = ctl('board-sync', 'bs1', '--admin', 'Orch', '--board-dir', board)
        self.assertEqual(out.returncode, 0, out.stderr)
        new = open(path).read()
        room_line = '  "room": {"id": "bs1", "url": "' + self.url + '/r/bs1/"}\n'
        self.assertEqual(new, original[:-3] + ',\n' + room_line + '}\n')                    # only the room key added
        self.assertEqual(json.loads(new)['room'], {'id': 'bs1', 'url': self.url + '/r/bs1/'})
        baks = [f for f in os.listdir(board) if f.startswith('board.json.bak-') and f.endswith('-room')]
        self.assertEqual(len(baks), 1)
        self.assertEqual(open(os.path.join(board, baks[0])).read(), original)
        m = {x['name']: x for x in self.req('/api/r/bs1')[1]['members']}
        self.assertEqual((m['My Proj']['kind'], m['Wren']['kind']), ('board', 'agent'))
        self.assertNotEqual(m['My Proj']['presence'], 'invited')                                # joined: can post
        self.assertEqual(roomd.get_room('bs1').meta['board'], board)
        out = ctl('board-sync', 'bs1', '--admin', 'Orch', '--board-dir', board)                # idempotent
        self.assertIn('"room" key already current', out.stdout)
        self.assertEqual(open(path).read(), new)
        # a finish report from the board reaches the orchestrator's prompt like any @mention
        roomd.AGENT_SEND = fake
        try:
            self.assertEqual(self.req('/api/r/bs1/route', {'as': 'Orch', 'agent_id': 'claude-42'})[0], 200)
            text = '@Orch Wren (s-1) finished #8 Chat tab: approved. Wren is idle: what\'s next?'
            s, p = self.req('/api/r/bs1/post', {'as': 'My Proj', 'text': text})
            self.assertEqual(s, 200, p)
            got = [json.loads(l) for l in open(sends)]
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0][0], 'claude-42')
            self.assertTrue(got[0][1].startswith(f'[Agent room bs1 "Sync Room"] My Proj wrote (msg #{p["seq"]}): {text}'))
        finally:
            roomd.AGENT_SEND = '/nonexistent/agent-send'

    @unittest.skipUnless(shutil.which('node'), 'needs node')
    def test_mention_matches(self):
        # run app.js's own @name matcher (prefix before substring, agents before the human, then presence) in node
        with open(os.path.join(os.path.dirname(__file__), '..', 'web', 'app.js')) as fh:
            src = fh.read()
        a = src.index('  const PRESENCE_RANK')
        b = src.index('\n  }\n', src.index('function mentionMatches', a)) + 4
        members = [{'name': 'Foreman', 'kind': 'admin', 'presence': 'online'},
                   {'name': 'Graft', 'kind': 'agent', 'presence': 'away'},
                   {'name': 'Sprout', 'kind': 'agent', 'presence': 'idle'},
                   {'name': 'deep-seek.pro', 'kind': 'agent', 'presence': 'online'},
                   {'name': 'Human', 'kind': 'human', 'presence': 'online'}]
        cases = {'': None, 'f': None, 'R': None, 'deep-s': None, 'zz': None}
        prog = src[a:b] + f'\nconst M = {json.dumps(members)};\nconsole.log(JSON.stringify(' + \
            json.dumps(list(cases)) + '.map((f) => mentionMatches(M, f).map((m) => m.name))));'
        out = json.loads(subprocess.run(['node', '-e', prog], capture_output=True, text=True, check=True).stdout)
        got = dict(zip(cases, out))
        self.assertEqual(got[''], ['Foreman', 'deep-seek.pro', 'Sprout', 'Graft', 'Human'])
        self.assertEqual(got['f'], ['Foreman', 'Graft'])              # prefix first, then substring
        self.assertEqual(got['R'], ['Foreman', 'deep-seek.pro', 'Sprout', 'Graft'])  # substring, by presence
        self.assertEqual(got['deep-s'], ['deep-seek.pro'])
        self.assertEqual(got['zz'], [])

    @unittest.skipUnless(shutil.which('node'), 'needs node')
    def test_inline_renderer(self):
        # app.js's markdown renderer: a crafted URL must not break out of its href (no event handler, one anchor)
        with open(os.path.join(os.path.dirname(__file__), '..', 'web', 'app.js')) as fh:
            src = fh.read()
        esc = src[src.index('  const esc = '):src.index('\n', src.index('  const esc = '))]
        a = src.index('  function inline(s)')
        fn = src[a:src.index('\n  }\n', a) + 4]
        cases = ["[x](http://a(http://b/onmouseover=location='javascript:alert%281%29'//)",
                 'see https://npmjs.com/package/@scope/x and @Bob', '[t](http://x/`c`)', 'x\u00000\u0000 `a`']
        prog = esc + '\n' + fn + f'\nconsole.log(JSON.stringify({json.dumps(cases)}.map(inline)));'
        out = json.loads(subprocess.run(['node', '-e', prog], capture_output=True, text=True, check=True).stdout)
        self.assertEqual(out[0], '<a href="http://a(http://b/onmouseover=location=&#39;javascript:alert%281%29&#39;//"'
                                 ' target="_blank" rel="noopener">x</a>')
        self.assertIn('<a href="https://npmjs.com/package/@scope/x" target="_blank" rel="noopener">', out[1])
        self.assertIn('<span class="at">@Bob</span>', out[1])
        import re as _re
        self.assertFalse([h for h in _re.findall(r'href="([^"]*)"', out[2]) if '<' in h], out[2])   # no markup in an href
        self.assertEqual(out[3], 'x0 <code>a</code>')

    def test_mcp(self):
        s, v = self.req('/api/rooms', {'id': 'm1', 'purpose': 'mcp', 'admin': 'Host'})
        pub = v['public_dir']
        open(os.path.join(pub, 'theme.css'), 'a').write('/* x */')
        open(os.path.join(pub, 'art', 'a.png'), 'wb').write(b'x')
        env = dict(os.environ, AGENT_ROOMS_URL=self.url, ROOM_ID='m1', ROOM_AS='Host')
        env.pop('OMARCHY_AGENT_NAME', None)
        calls = [('room_theme_done', {}), ('room_invite', {'name': 'Z', 'role': 'tester'}),
                 ('room_join', {'as': 'Z'}), ('room_post', {'text': 'hello @Host'}), ('room_members', {})]
        msgs = [{'jsonrpc': '2.0', 'id': 0, 'method': 'initialize', 'params': {}}] + [
            {'jsonrpc': '2.0', 'id': i + 1, 'method': 'tools/call', 'params': {'name': n, 'arguments': a}} for i, (n, a) in enumerate(calls)]
        out = subprocess.run([sys.executable, os.path.join(ROOT, 'room_mcp.py')], env=env, capture_output=True, text=True,
                             input='\n'.join(map(json.dumps, msgs)) + '\n', timeout=30).stdout
        res = {m['id']: m['result'] for m in map(json.loads, out.splitlines())}
        for i in range(1, 6):
            self.assertFalse(res[i]['isError'], res[i]['content'][0]['text'])
        self.assertEqual(roomd.get_room('m1').msgs[-1]['from'], 'Z')                          # joined as Z, kept it


if __name__ == '__main__':
    unittest.main()
