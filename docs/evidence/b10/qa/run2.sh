#!/bin/bash
# (the reviewer sleeps 20 s first, so the orchestrator can reject while the bounty is in review)
# Scratch-board QA for b10 attempt 4 (the third review's points): the cap with an older attempt's
# open incident, retry with no open incident, and the end reason of a worker gone after a board
# restart / an adopted worker that dies. Own config dir, db, ephemeral port, command slots, fake workers.
set -u
WT=$(cd "$(dirname "$0")/../../../.." && pwd)
QA=$(mktemp -d /tmp/b10qa4-XXXX); echo "QA dir: $QA"
O=$QA/transcript.txt
step() { echo "\$ $*" >> $O; }
cd $QA
BPORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
mkdir repo && (cd repo && git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false &&
  printf 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' > math.js && printf '#!/bin/bash\nset -e\nnode --test\n' > verify.sh && chmod +x verify.sh && git add -A && git commit -qm init)
cat > board.json <<EOF
{ "port": $BPORT, "host": "127.0.0.1", "allow_cidrs": ["127.0.0.0/8","::1/128"],
  "db_path": "$QA/board.db", "logs_dir": "$QA/logs", "registry_dir": "$QA/registry", "run_dir": "$QA/run",
  "orchestrator": "Conductor", "concurrency_cap": 3, "tick_seconds": 2, "idle_shutdown_minutes": 0,
  "watchdog": { "stall_minutes": 5, "check_seconds": 3, "kill_grace_seconds": 2 },
  "retry": { "max_attempts": 2, "escalate_after_failures": 9, "escalate_model": {} },
  "reviewer": { "runner": "command", "cmd": ["bash", "-c", "sleep 20; exec bash $WT/test/fake-reviewer.sh"], "timeout_minutes": 2 },
  "slots": [
    { "id": "qa-1", "name": "Alpha", "runner": "command", "model": "sonnet", "cmd": ["bash", "$WT/test/fake-worker.sh"] },
    { "id": "qa-2", "name": "Bravo", "runner": "command", "model": "sonnet", "cmd": ["bash", "$WT/test/fake-worker.sh"] },
    { "id": "qa-3", "name": "Charlie", "runner": "command", "model": "opus", "cmd": ["bash", "$WT/test/fake-worker.sh"] } ] }
EOF
printf '#!/bin/bash\nexec env -u BOUNTY_ID -u BOUNTY_SLOT -u BOUNTY_ACTOR BOUNTY_URL=http://127.0.0.1:%s AGENT_NAME=Conductor node %s/bin/bounty "$@"\n' $BPORT $WT > q.sh; chmod +x q.sh; mkdir -p logs
startserver() { (cd $WT; BOUNTY_CONFIG=$QA/board.json BOUNTY_NO_SEED=1 node server.js >> $QA/server.out 2>&1 & echo $! > $QA/server.pid); sleep 3; echo "server pid $(cat $QA/server.pid)" >> $O; }
startserver
echo "commit $(git -C $WT rev-parse --short HEAD); board port $BPORT" >> $O
q() { step "q.sh $*"; ./q.sh "$@" >> $O 2>&1; }
sql() { step "sqlite3 -header board.db \"$1\""; sqlite3 -header board.db "$1" >> $O; }
q project add scratch --repo $QA/repo --main main --verify ./verify.sh --wt-path "$QA/wt/{task}"

echo "--- (1) the cap with an older attempt's incident still open (max_attempts 2)" >> $O
q add "Older incident" --desc "mode:giveup" --criteria "math.js exports mul" --slot qa-1 --ready
for i in $(seq 1 20); do [ -n "$(sqlite3 board.db "SELECT id FROM incidents WHERE bounty_id=1")" ] && break; sleep 1; done; sleep 2
q incidents
step "# nobody decides incident #1; the bounty is requeued by hand, attempt 2 submits real work, the orchestrator rejects it at the cap"
q edit 1 --desc "mode:good"
q ready 1
for i in $(seq 1 60); do [ "$(sqlite3 board.db "SELECT status FROM bounties WHERE id=1")" = review ] && break; sleep 1; done
q reject 1 "the product must be BigInt-safe"
q show 1
sql "SELECT id,bounty_id,attempt_no,attempt_id,status,cause_kind,cause FROM incidents WHERE bounty_id=1 ORDER BY id"
q incidents

echo "--- (2) retry with no open incident is refused" >> $O
q add "Blocked by hand" --criteria "x"
q block 2 "waiting on a design decision"
sql "SELECT id,status,attempts,failures FROM bounties WHERE id=2"
q retry 2
step "echo exit=\$?"; ./q.sh retry 2 > /dev/null 2>&1; echo "exit=$?" >> $O
sql "SELECT id,status,attempts,failures FROM bounties WHERE id=2"

echo "--- (3) workers gone across a board restart" >> $O
q add "Gone after restart" --desc "mode:stall" --criteria "x" --slot qa-2 --ready
q add "Adopted then dies" --desc "mode:stall" --criteria "x" --slot qa-3 --ready
for i in $(seq 1 30); do [ "$(sqlite3 board.db "SELECT COUNT(*) FROM bounties WHERE id IN (3,4) AND status='in_progress'")" = 2 ] && break; sleep 1; done
P3=$(sqlite3 board.db "SELECT pid FROM attempts WHERE bounty_id=3 AND ended_at IS NULL"); P4=$(sqlite3 board.db "SELECT pid FROM attempts WHERE bounty_id=4 AND ended_at IS NULL")
C3=$(cat /proc/$P3/task/*/children 2>/dev/null | tr -s ' ' ' '); C4=$(cat /proc/$P4/task/*/children 2>/dev/null | tr -s ' ' ' ')
echo "worker pids: #3 $P3 (children $C3), #4 $P4 (children $C4)" >> $O
for p in $P3 $C3 $P4 $C4; do echo "$p: $(tr '\0' ' ' < /proc/$p/cmdline)" >> $O; done
step "kill -TERM $(cat server.pid)  # stop the board; workers outlive it"; kill -TERM $(cat server.pid); sleep 2
step "kill -TERM $P3 $C3  # #3's worker dies while the board is down"; kill -TERM $P3 $C3; sleep 1
startserver
sleep 3
step "kill -TERM $P4 $C4  # #4's worker was re-attached, then dies"; kill -TERM $P4 $C4
for i in $(seq 1 20); do [ "$(sqlite3 board.db "SELECT COUNT(*) FROM incidents WHERE bounty_id IN (3,4)")" = 2 ] && break; sleep 1; done; sleep 1
q incidents
for B in 3 4; do I=$(sqlite3 board.db "SELECT id FROM incidents WHERE bounty_id=$B"); step "q.sh incident $I | sed -n '1,9p'"; ./q.sh incident $I | sed -n '1,9p' >> $O; done
sql "SELECT bounty_id,COUNT(*) n FROM incidents GROUP BY bounty_id, attempt_no HAVING n > 1  -- expect nothing"

echo "--- stopping by recorded PID" >> $O
# attempts still running (the slow reviewer of #1's rejected attempt), and their children
for p in $(sqlite3 board.db "SELECT pid FROM attempts WHERE ended_at IS NULL AND pid IS NOT NULL"); do
  [ -e /proc/$p ] || continue; K=$(cat /proc/$p/task/*/children 2>/dev/null)
  echo "$p: $(tr '\0' ' ' < /proc/$p/cmdline) (children $K)" >> $O; step "kill -TERM $p $K"; kill -TERM $p $K
done
echo "$(cat server.pid): $(tr '\0' ' ' < /proc/$(cat server.pid)/cmdline)" >> $O
step "kill -TERM $(cat server.pid)"; kill -TERM $(cat server.pid); sleep 2
for p in $(cat server.pid) $P3 $C3 $P4 $C4; do [ -e /proc/$p ] && echo "$p still alive" >> $O || echo "$p gone" >> $O; done
for p in $(sqlite3 board.db "SELECT pid FROM attempts WHERE pid IS NOT NULL"); do [ -e /proc/$p ] && echo "attempt pid $p still alive" >> $O || echo "attempt pid $p gone" >> $O; done
ss -ltn | grep -E ":$BPORT\b" >> $O || echo "port $BPORT closed" >> $O
echo DONE >> $O
