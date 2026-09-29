#!/bin/bash
# Fake reviewer for tests: reads the prompt on stdin; approves when the diff adds mul(),
# rejects otherwise. Prints the verdict JSON to stdout.
prompt=$(cat)
n=$(printf '%s' "$prompt" | awk '/^## Acceptance criteria/{f=1;next} /^#/{f=0} f && /^[0-9]+\./{c++} END{print c+0}')
crit=""
if printf '%s' "$prompt" | grep -q '^+function mul'; then
  for i in $(seq 1 "$n"); do crit+="{\"index\":$i,\"met\":true,\"evidence\":\"math.js adds mul; mul.test.js\"},"; done
  echo "{\"verdict\":\"approve\",\"notes\":\"mul() added with a test\",\"criteria\":[${crit%,}]}"
else
  for i in $(seq 1 "$n"); do crit+="{\"index\":$i,\"met\":false,\"evidence\":\"no mul in the diff\"},"; done
  echo "{\"verdict\":\"reject\",\"notes\":\"the diff does not add mul()\",\"criteria\":[${crit%,}]}"
fi
