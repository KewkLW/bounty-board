#!/bin/bash
# Scratch-board QA for b10: own config dir, db, ephemeral ports, command slots with fake workers.
set -u
WT=$(cd "$(dirname "$0")/../../../.." && pwd); HERE=$(cd "$(dirname "$0")" && pwd)
QA=$(mktemp -d /tmp/b10qa-XXXX); echo "QA dir: $QA"
O=$QA/transcript.txt
step() { echo "\$ $*" >> $O; }
cd $QA
node $HERE/fakeroom.js $QA/room-posts.txt > $QA/room.port 2>&1 & echo $! > $QA/room.pid
sleep 1; RPORT=$(cat room.port); BPORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
echo $BPORT > board.port
mkdir repo && (cd repo && git init -q -b main && git config user.email t@t && git config user.name t && git config commit.gpgsign false &&
  printf 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n' > math.js && printf '#!/bin/bash\nset -e\nnode --test\n' > verify.sh && chmod +x verify.sh && git add -A && git commit -qm init)
cat > board.json <<EOF
{ "port": $BPORT, "host": "127.0.0.1", "allow_cidrs": ["127.0.0.0/8","::1/128"],
  "db_path": "$QA/board.db", "logs_dir": "$QA/logs", "registry_dir": "$QA/registry", "run_dir": "$QA/run",
  "orchestrator": "Conductor", "room": { "id": "scratch-room", "url": "http://127.0.0.1:$RPORT/r/scratch-room/" },
  "concurrency_cap": 3, "tick_seconds": 2, "idle_shutdown_minutes": 0,
  "watchdog": { "stall_minutes": 1, "check_seconds": 5, "kill_grace_seconds": 2 },
  "retry": { "max_attempts": 4, "escalate_after_failures": 9, "escalate_model": {} },
  "reviewer": { "runner": "command", "cmd": ["bash", "$WT/test/fake-reviewer.sh"], "timeout_minutes": 2 },
  "slots": [
    { "id": "qa-1", "name": "Alpha", "runner": "command", "model": "sonnet", "cmd": ["bash", "$WT/test/fake-worker.sh"] },
    { "id": "qa-2", "name": "Bravo", "runner": "command", "model": "sonnet", "cmd": ["bash", "$WT/test/fake-worker.sh"] },
    { "id": "qa-3", "name": "Charlie", "runner": "command", "model": "opus", "cmd": ["bash", "$WT/test/fake-worker.sh"] } ] }
EOF
printf '#!/bin/bash\nexec env -u BOUNTY_ID -u BOUNTY_SLOT -u BOUNTY_ACTOR BOUNTY_URL=http://127.0.0.1:%s AGENT_NAME=Conductor node %s/bin/bounty "$@"\n' $BPORT $WT > q.sh; chmod +x q.sh; mkdir -p logs
cd $WT; BOUNTY_CONFIG=$QA/board.json BOUNTY_NO_SEED=1 node server.js > $QA/server.out 2>&1 & echo $! > $QA/server.pid; cd $QA
sleep 3
echo "commit $(git -C $WT rev-parse --short HEAD); board port $BPORT, room port $RPORT; pids server $(cat server.pid) room $(cat room.pid)" >> $O
q() { step "q.sh $*"; ./q.sh "$@" >> $O 2>&1; }
q project add scratch --repo $QA/repo --main main --verify ./verify.sh --wt-path "$QA/wt/{task}"
./q.sh incidents --follow > $QA/follow.out 2>&1 & echo $! > $QA/follow.pid; echo "follow pid $(cat follow.pid)" >> $O; sleep 1
q add "Gives up" --desc "mode:giveup" --criteria "math.js exports mul" --slot qa-1 --ready
q add "Goes silent" --desc "mode:stall" --criteria "math.js exports mul" --slot qa-2 --ready
q add "Prints a token" --desc "mode:leak" --criteria "math.js exports mul" --slot qa-3 --ready
sleep 20; q incidents
L=$(sqlite3 board.db "SELECT id FROM incidents WHERE bounty_id=3 ORDER BY id LIMIT 1"); echo $L > leak.inc
step "q.sh incident $L"; ./q.sh incident $L > incident-leak.txt; cat incident-leak.txt >> $O
step "sqlite3 board.db \"SELECT COUNT(*) FROM incidents WHERE report LIKE '%Z9y8%' OR detail LIKE '%Z9y8%' OR cause LIKE '%Z9y8%' OR resolution LIKE '%Z9y8%'\""
sqlite3 board.db "SELECT COUNT(*) FROM incidents WHERE report LIKE '%Z9y8%' OR detail LIKE '%Z9y8%' OR cause LIKE '%Z9y8%' OR resolution LIKE '%Z9y8%'" >> $O
q retry 3 --slot qa-1 --note "do not print credentials; read the token from the environment"; sleep 8
P=$(ls logs/bounty-3-attempt-2-*.prompt.md); step "sed -n '/## A previous attempt broke/,/## End of the incident report/p' $P"
sed -n '/## A previous attempt broke/,/## End of the incident report/p' $P > prompt-section.txt; cat prompt-section.txt >> $O
step "grep -n 'Retry after a broken attempt' $P"; grep -n "Retry after a broken attempt" $P >> $O
q retry 3; sleep 7; q retry 3; sleep 7
q incidents
step "sqlite3 board.db 'SELECT COUNT(*) FROM incidents'"; sqlite3 board.db 'SELECT COUNT(*) FROM incidents' >> $O
q retry 3 --note "last try before the cap"
step "sqlite3 board.db 'SELECT COUNT(*) FROM incidents'"; sqlite3 board.db 'SELECT COUNT(*) FROM incidents' >> $O
C=$(sqlite3 board.db "SELECT MAX(id) FROM incidents WHERE bounty_id=3"); echo $C > cap.inc
step "sqlite3 -header board.db \"SELECT id,bounty_id,attempt_no,status,choice,resolved_by,resolved_at,cause,resolution FROM incidents WHERE id=$C\""
sqlite3 -header board.db "SELECT id,bounty_id,attempt_no,status,choice,resolved_by,resolved_at,cause,resolution FROM incidents WHERE id=$C" >> $O
# wait for the stall (1 min limit, 5 s checks)
for i in $(seq 1 30); do S=$(sqlite3 board.db "SELECT id FROM incidents WHERE bounty_id=2 LIMIT 1"); [ -n "$S" ] && break; sleep 3; done; sleep 4; echo $S > stall.inc
step "q.sh incident $S | head -9"; ./q.sh incident $S | head -9 >> $O
q orchestrator register --pid $(cat room.pid) --name Conductor
for e in state live; do step "curl -s http://127.0.0.1:$BPORT/api/$e | (print orchestrator.open_incidents)"; curl -s http://127.0.0.1:$BPORT/api/$e | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('$e.orchestrator.open_incidents =', JSON.parse(s).orchestrator.open_incidents))" >> $O; done
q incident $S --human "the stall reproduces on this runner; decide whether it needs a longer stall limit"
q incident $C --human "the worker prints credentials on every run; check the brief before anyone retries"
step "sqlite3 -header board.db \"SELECT id,status,choice,resolved_by,detail FROM incidents WHERE id=$C\""; sqlite3 -header board.db "SELECT id,status,choice,resolved_by,detail FROM incidents WHERE id=$C" >> $O
G=$(sqlite3 board.db "SELECT id FROM incidents WHERE bounty_id=1 AND status='open' LIMIT 1")
q retry 1 --note "install nothing; use the node already on PATH"
for B in 2 3; do step "q.sh show $B --json | (print status and blocked_reason)"; ./q.sh show $B --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);console.log("#"+b.id, b.status+":", b.blocked_reason)})' >> $O; done
sleep 5
q project add nowt --repo $QA/repo --main main --verify ./verify.sh --wt-path "$QA/wt2/{task}" --wt-cmd "echo cannot make a worktree; exit 7"
q add "No worktree" --project nowt --criteria "x" --slot qa-2 --ready; sleep 6
W=$(sqlite3 board.db "SELECT MAX(id) FROM incidents WHERE bounty_id=4"); step "q.sh incident $W | sed -n '4,7p'"; ./q.sh incident $W | sed -n '4,7p' >> $O
q retry 4; sleep 6
step "sqlite3 -header board.db \"SELECT id,bounty_id,attempt_no,attempt_id,status,choice FROM incidents WHERE bounty_id=4\""; sqlite3 -header board.db "SELECT id,bounty_id,attempt_no,attempt_id,status,choice FROM incidents WHERE bounty_id=4" >> $O
W=$(sqlite3 board.db "SELECT MAX(id) FROM incidents WHERE bounty_id=4"); step "q.sh incident $W | sed -n '4,7p'"; ./q.sh incident $W | sed -n '4,7p' >> $O
q incidents --all
step "sqlite3 board.db 'SELECT bounty_id, attempt_no, COUNT(*) FROM incidents GROUP BY bounty_id, attempt_no HAVING COUNT(*) > 1'  # expect nothing"
sqlite3 board.db 'SELECT bounty_id, attempt_no, COUNT(*) FROM incidents GROUP BY bounty_id, attempt_no HAVING COUNT(*) > 1' >> $O
step "sqlite3 board.db \"SELECT COUNT(*) FROM attempts WHERE ended_at IS NULL\""; sqlite3 board.db "SELECT COUNT(*) FROM attempts WHERE ended_at IS NULL" >> $O
step "cat follow.out"; cat follow.out >> $O
step "cat room-posts.txt"; cat room-posts.txt >> $O
echo "--- stopping by recorded PID" >> $O
for p in $(cat follow.pid) $(cat server.pid) $(cat room.pid); do echo "$p: $(tr '\0' ' ' < /proc/$p/cmdline)" >> $O; done
step "kill -TERM $(cat follow.pid) $(cat server.pid) $(cat room.pid)"; kill -TERM $(cat follow.pid) $(cat server.pid) $(cat room.pid); sleep 2
for p in $(cat follow.pid) $(cat server.pid) $(cat room.pid); do [ -e /proc/$p ] && echo "$p still alive" >> $O || echo "$p gone" >> $O; done
ss -ltn | grep -E ":$BPORT|:$RPORT" >> $O || echo "ports closed" >> $O
echo DONE >> $O
