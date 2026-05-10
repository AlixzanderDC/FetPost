#!/usr/bin/env bash
# Shut down FetPost on Linux / macOS.

cd "$(dirname "$0")"

kill_port() {
  local port=$1 label=$2
  local pids
  pids=$(lsof -ti :$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    kill -9 $pids 2>/dev/null && echo "  stopped $label (pid $pids)"
  fi
}

echo "Stopping FetPost services..."
kill_port 3747 "FetLife service"
kill_port 4000 "UI"

# Clean up tracked PIDs
rm -f .logs/fetlife-poster.pid .logs/ui.pid 2>/dev/null
echo "Done."
