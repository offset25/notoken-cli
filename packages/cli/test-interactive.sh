#!/bin/bash
# Quick interactive mode test — uses expect to simulate real TTY input
# Usage: bash test-interactive.sh [phrase]
#   bash test-interactive.sh           # tests "hi"
#   bash test-interactive.sh "restart nginx"
#   bash test-interactive.sh "status"

set -e
cd "$(dirname "$0")/../.."

PHRASE="${1:-hi}"
CLI="packages/cli/src/index.ts"

echo "=== Testing interactive mode: \"$PHRASE\" ==="

if ! command -v expect &>/dev/null; then
  echo "ERROR: expect not installed. Run: apt install expect"
  exit 1
fi

OUTPUT=$(expect -c "
  log_user 0
  set timeout 20
  spawn npx tsx $CLI
  sleep 4
  expect -re {>}
  send \"$PHRASE\r\"
  sleep 4
  log_user 1
  expect -re {.+}
  send \"exit\r\"
  expect eof
" 2>&1)

# Strip ANSI codes for clean output
CLEAN=$(echo "$OUTPUT" | sed 's/\x1b\[[0-9;]*m//g' | sed 's/\r//g')

echo "$CLEAN"
echo ""

# Check for known bad patterns
if echo "$CLEAN" | grep -qi "authenticate.*codex\|You need to authenticate"; then
  echo "FAIL: Codex auth message appeared"
  exit 1
fi

if echo "$CLEAN" | grep -qi "chat.greeting\|Hello\|Hey\|Hi!\|What's up\|Reporting\|deploy\|boss\|agenda"; then
  echo "PASS: Got greeting response"
elif echo "$CLEAN" | grep -qi "service.restart\|disk.cleanup\|tool.install\|openclaw\|ollama"; then
  echo "PASS: Got intent match"
elif echo "$CLEAN" | grep -qi "unknown\|Could not determine"; then
  echo "WARN: Unknown intent"
else
  echo "INFO: Got response (check output above)"
fi
