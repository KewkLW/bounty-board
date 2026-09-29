#!/bin/bash
# End-to-end with REAL agents on a throwaway project: one `claude -p --model haiku` worker and the
# real Codex reviewer, on a separate board instance (own port, DB and logs), so the live board's
# data is untouched. Watches: ready -> spawn -> start -> submit -> verify -> review -> approve ->
# merge -> done, then prints the history, the log path and the recorded cost.
#
#   test/e2e-real.sh [workdir]
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=${1:-$(mktemp -d /tmp/bb-e2e-real-XXXXXX)}
port=${E2E_PORT:-3778}
repo=$work/repo
mkdir -p "$work"
echo "e2e workdir: $work"

# 1. the throwaway project: a tiny node lib with a verify script
rm -rf "$repo"; mkdir -p "$repo"; cd "$repo"
git init -q -b main; git config user.email e2e@local; git config user.name e2e
cat > math.js <<'JS'
function add(a, b) { return a + b; }
module.exports = { add };
JS
cat > math.test.js <<'JS'
const test = require('node:test'); const assert = require('node:assert'); const m = require('./math');
test('add', () => assert.strictEqual(m.add(2, 3), 5));
JS
printf '#!/bin/bash\nset -e\nnode --test\n' > verify.sh; chmod +x verify.sh
git add -A; git commit -qm init

# 2. a board instance with one haiku slot and the real Codex reviewer
cat > "$work/board.json" <<JSON
{
  "port": $port, "host": "127.0.0.1", "allow_cidrs": ["127.0.0.0/8", "::1/128"],
  "db_path": "$work/board.db", "logs_dir": "$work/logs",
  "concurrency_cap": 1, "tick_seconds": 2,
  "watchdog": { "stall_minutes": 10, "check_seconds": 10, "kill_grace_seconds": 5 },
  "merge_check_seconds": 5,
  "reviewer": { "runner": "codex", "timeout_minutes": 15 },
  "runners": { "claude": { "bin": "claude", "allowed_tools": "Bash,Read,Grep,Glob,Edit,Write" }, "codex": { "bin": "codex" } },
  "slots": [ { "id": "haiku-e2e", "runner": "claude", "model": "haiku" } ]
}
JSON
BOUNTY_CONFIG=$work/board.json BOUNTY_NO_SEED=1 node "$root/server.js" > "$work/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null || true' EXIT
export BOUNTY_URL=http://127.0.0.1:$port
for _ in $(seq 50); do curl -sf "$BOUNTY_URL/health" >/dev/null && break; sleep 0.2; done

bounty project add e2e --repo "$repo" --main main --wt-cmd 'git worktree add {path} -b {branch} {main}' --wt-path "$work/wt/{task}" --verify ./verify.sh
bounty add "Add a mul(a, b) function with a test" --project e2e --slot haiku-e2e --type task --tier C \
  --desc "In math.js add mul(a, b) that returns a * b and export it next to add. Add a node:test test for it. Keep it minimal." \
  --criteria "math.js exports mul(a, b) that returns the product a * b" \
  --criteria "a node:test test (e.g. mul.test.js or in math.test.js) asserts mul(3, 4) === 12" \
  --criteria "./verify.sh passes" --ready
id=1

last=""
deadline=$((SECONDS + 1800))
while ((SECONDS < deadline)); do
  st=$(curl -s "$BOUNTY_URL/api/bounties/$id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);console.log([b.status,b.ci_status||"-",b.review_state||"-"].join(" "))})')
  [[ $st != "$last" ]] && { echo "$(date +%T) status: $st"; last=$st; }
  case $st in
    approved*)
      br=$(curl -s "$BOUNTY_URL/api/bounties/$id" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).branch))')
      echo "$(date +%T) orchestrator: merging $br into main"
      git -C "$repo" merge -q --no-ff "$br" -m "Merge $br (bounty #$id)"
      ;;
    done*) break ;;
    blocked*|failed*) echo "stopped at $st"; break ;;
  esac
  sleep 3
done
echo; bounty show $id
echo; echo "worker log (readable): $BOUNTY_URL/api/attempts/<id>/log ; raw files in $work/logs"
ls -la "$work/logs"
