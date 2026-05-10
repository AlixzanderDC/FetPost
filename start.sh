#!/usr/bin/env bash
# Launch FetPost on Linux / macOS.

set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

if [ ! -f .env ]; then
  echo ".env not found. Run ./setup.sh first."
  exit 1
fi

# Stop any prior instance still holding the ports
kill_port() {
  local port=$1
  local pids
  pids=$(lsof -ti :$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  stopping prior process on :$port (pid $pids)"
    kill -9 $pids 2>/dev/null || true
  fi
}
kill_port 3747
kill_port 4000
sleep 1

mkdir -p "$ROOT/.logs"

echo "Starting FetLife service..."
( cd "$ROOT/fetlife-poster" && nohup node --env-file="$ROOT/.env" src/server.js >"$ROOT/.logs/fetlife-poster.log" 2>&1 ) &
echo $! > "$ROOT/.logs/fetlife-poster.pid"

# Give the FetLife service a moment to bind its port before the UI tries to reach it.
sleep 4

echo "Starting UI..."
( cd "$ROOT/nexuspost-ui" && nohup node --env-file="$ROOT/.env" src/server.js >"$ROOT/.logs/ui.log" 2>&1 ) &
echo $! > "$ROOT/.logs/ui.pid"

sleep 3

URL="http://127.0.0.1:4000"
echo
echo "FetPost is running at $URL"
echo "Logs: $ROOT/.logs/{fetlife-poster,ui}.log"
echo "Run ./stop.sh to shut down."
echo

# Open browser if we can
case "$(uname)" in
  Darwin) open "$URL" ;;
  Linux)  command -v xdg-open >/dev/null && xdg-open "$URL" >/dev/null 2>&1 || true ;;
esac
