// stand-in for roomd (same contract as test/room.test.js fakeRoom); appends each post's text to argv[2]
const http = require('http'), fs = require('fs');
const out = process.argv[2], id = 'scratch-room', members = new Set();
const srv = http.createServer((req, res) => { let body = ''; req.on('data', d => body += d).on('end', () => {
  const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = req.url.split('?')[0].split('/').filter(Boolean);
  if (p[0] !== 'api' || p[1] !== 'r' || p[2] !== id) return send(404, { error: 'unknown room' });
  if (req.method === 'GET' && p.length === 3) return send(200, { id, admin: 'Conductor', members: [] });
  const b = JSON.parse(body || '{}');
  if (p[3] === 'join') { members.add(b.as); return send(200, { joined: b.as }); }
  if (p[3] === 'post') { fs.appendFileSync(out, `${b.as}: ${b.text || b.message || JSON.stringify(b)}\n`); return send(200, { seq: 1 }); }
  send(404, {});
}); });
srv.listen(0, '127.0.0.1', () => console.log(srv.address().port));
