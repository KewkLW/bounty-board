#!/bin/bash
# Smoke run of the real board, no AI: a throwaway board (own port, DB, logs, repo) with the fake
# worker and fake reviewer from test/. Drives one bounty ready -> spawn -> submit -> verify ->
# review -> approved, merges the reviewed sha with `bounty trailer` lines, waits for done, checks
# the pages answer. Prints SMOKE GREEN or SMOKE RED and exits 0/1. Touches no live board.
#
#   scripts/smoke.sh [workdir]      (keep the workdir to inspect logs; default: a temp dir, removed on green)
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
work=${1:-$(mktemp -d "${TMPDIR:-/tmp}/bb-smoke-XXXXXX")}
keep=${1:+1}
port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
repo=$work/repo
export PATH="$root/bin:$PATH"   # the CLI of this checkout, for us and for the fake worker
export BOUNTY_URL=http://127.0.0.1:$port
fail() { echo "SMOKE RED: $*"; echo "workdir kept: $work (server.log, logs/)"; exit 1; }
step() { echo "== $*"; }

step "throwaway repo and board on :$port in $work"
mkdir -p "$repo"; cd "$repo" || exit 1
git init -q -b main; git config user.email smoke@local; git config user.name smoke; git config commit.gpgsign false
printf 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' > math.js
printf "const t = require('node:test'); const a = require('node:assert'); const m = require('./math');\nt.test('add', () => a.strictEqual(m.add(2, 3), 5));\n" > math.test.js
printf '#!/bin/bash\nset -e\nnode --test\n' > verify.sh; chmod +x verify.sh
printf '# Review rules\nReject a change without a test.\n' > REVIEW.md
git add -A; git commit -qm init
cat > "$work/board.json" <<JSON
{
  "port": $port, "host": "127.0.0.1", "allow_cidrs": ["127.0.0.0/8", "::1/128"],
  "db_path": "$work/board.db", "logs_dir": "$work/logs", "registry_dir": "$work/registry",
  "concurrency_cap": 1, "tick_seconds": 1, "merge_check_seconds": 1, "verify_concurrency": 1,
  "watchdog": { "stall_minutes": 5, "check_seconds": 2, "kill_grace_seconds": 1 },
  "reviewer": { "runner": "command", "cmd": ["bash", "$root/test/fake-reviewer.sh"], "timeout_minutes": 2, "max_errors": 2 },
  "runners": {},
  "slots": [ { "id": "fake-1", "name": "Alpha", "runner": "command", "model": "sonnet", "cmd": ["bash", "$root/test/fake-worker.sh"] } ]
}
JSON
BOUNTY_CONFIG=$work/board.json BOUNTY_NO_SEED=1 node "$root/server.js" > "$work/server.log" 2>&1 &
server=$!
trap 'kill $server 2>/dev/null; wait $server 2>/dev/null' EXIT
for _ in $(seq 100); do curl -sf "$BOUNTY_URL/health" >/dev/null && break; sleep 0.1; done
curl -sf "$BOUNTY_URL/health" >/dev/null || fail "board did not come up (server.log)"

step "project with protected paths, one ready bounty"
bounty project add smoke --repo "$repo" --main main --wt-cmd 'git worktree add {path} -b {branch} {main}' \
  --wt-path "$work/wt/{task}" --verify ./verify.sh --protected 'REVIEW.md,AGENTS.md,CLAUDE.md,.claude/**,verify.sh' >/dev/null || fail "project add"
bounty project list | grep -q 'protected=REVIEW.md,AGENTS.md,CLAUDE.md,.claude/\*\*,verify.sh' || fail "protected paths not saved"
bounty add "Add mul(a, b) with a test" --project smoke --slot fake-1 --criteria "math.js exports mul(a, b)" --criteria "a node:test covers mul" --ready >/dev/null || fail "add"

step "worker -> submit -> verify -> review"
get() { curl -s "$BOUNTY_URL/api/bounties/1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);console.log($1)})"; }
for _ in $(seq 120); do st=$(get 'b.status'); [[ $st == approved || $st == failed || $st == blocked ]] && break; sleep 1; done
[[ $st == approved ]] || { bounty show 1; fail "bounty 1 is '$st', expected approved"; }
sub=$(get 'b.submitted_sha'); ver=$(get 'b.verified_sha'); rev=$(get 'b.reviewed_sha')
[[ -n $sub && $sub == "$ver" && $ver == "$rev" ]] || fail "shas not pinned: submitted=$sub verified=$ver reviewed=$rev"
grep -q 'Reject a change without a test' "$(ls "$work"/logs/bounty-1-review-*.prompt.md | head -1)" || fail "REVIEW.md from main not in the reviewer prompt"
echo "   approved @ ${rev:0:10} (submitted = verified = reviewed)"

step "merge the reviewed sha with the trailer; merge check -> done"
trailer=$(bounty trailer 1 --quiet) || fail "trailer"
echo "$trailer" | sed 's/^/   /'
echo "$trailer" | grep -q "^Verified-by: ./verify.sh @ ${rev:0:10}$" || fail "trailer Verified-by"
git -C "$repo" merge -q --no-ff "$rev" -m "Merge bounty #1" -m "$trailer" || fail "merge"
for _ in $(seq 30); do st=$(get 'b.status'); [[ $st == done ]] && break; sleep 1; done
[[ $st == done ]] || fail "bounty 1 is '$st' after the merge, expected done"
git -C "$repo" log -1 --format=%B | grep -q '^Reviewed-by: command @' || fail "trailer not in the merge commit"
curl -s "$BOUNTY_URL/api/bounties/1" | grep -q 'FLAG' && fail "unexpected FLAG event"

step "pages answer"
for p in / /status.html /live.html; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BOUNTY_URL$p"); [[ $code == 200 ]] || fail "GET $p -> $code"
done

echo "SMOKE GREEN"
[[ -z $keep ]] && rm -rf "$work"
exit 0
