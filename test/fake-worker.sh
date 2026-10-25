#!/bin/bash
# Fake worker for tests: follows the Bounty Board protocol with the real CLI.
# FAKE_MODE (read from the bounty description, "mode:<x>"): good (default) | notes-only | no-submit | stall | crash | linger
set -u
bounty=bounty
desc=$(bounty show "$BOUNTY_ID" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).description||""))')
mode=good
[[ $desc =~ mode:([a-z-]+) ]] && mode=${BASH_REMATCH[1]}
echo "fake worker: bounty $BOUNTY_ID slot $BOUNTY_SLOT mode $mode cwd $(pwd)"
case $mode in
  crash) exit 3 ;;
  stall) bounty start; sleep 600; exit 0 ;;
  live)
    # stream-json like claude -p, then a long "tool call" (for the Live page test)
    bounty start
    bounty progress "looking at math.js"
    echo '{"type":"system","subtype":"init","cwd":"'"$PWD"'","model":"fake"}'
    echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Reading the code first."}],"usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":1000}},"timestamp":"2026-01-01T00:00:00Z"}'
    echo '{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"'"$PWD"'/math.js"}}],"usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":1000}}}'
    echo '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"x"}]}}'
    echo '{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"sleep 600"}}],"usage":{"input_tokens":5,"output_tokens":2}}}'
    sleep 600; exit 0 ;;
esac
bounty start || exit 1
bounty progress "reading the code"
if [[ $mode == notes-only ]]; then
  echo "did some work" >> WORK_LOG.md
  git add WORK_LOG.md && git commit -qm "log work"
  bounty submit --no-wait
  exit 0
fi
cat >> math.js <<'JS'
function mul(a, b) { return a * b; }
module.exports.mul = mul;
JS
cat > mul.test.js <<'JS'
const t = require('node:test'); const a = require('node:assert'); const m = require('./math');
t.test('mul', () => a.strictEqual(m.mul(3, 4), 12));
JS
git add -A && git commit -qm "Add mul() with a test"
bounty progress "added mul and its test" --check 1
[[ $mode == no-submit ]] && exit 0
./verify.sh >/dev/null 2>&1 && bounty progress "verify passes locally"
if [[ $mode == linger ]]; then
  # submits, then never exits (a worker that hangs around after its work is done)
  bounty submit --no-wait
  sleep 600 & wait
  exit 0
fi
bounty submit
