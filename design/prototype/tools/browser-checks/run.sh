#!/usr/bin/env bash
# Runs one of the browser checks against the built prototype, with real Windows Edge.
#
#   bun design/prototype/tools/build.mjs            # build first
#   design/prototype/tools/browser-checks/run.sh keyboard
#   design/prototype/tools/browser-checks/run.sh layout
#   design/prototype/tools/browser-checks/run.sh audit worst    # or: full (112 screenshots, a few minutes)
#
# Why Windows Edge through node.exe: WSL runs in NAT mode, so it cannot reach a debugging port on the
# Windows localhost. node.exe talks to Edge there; the prototype is served from WSL and Windows reaches it
# through localhost forwarding. Nothing listens on a non-loopback address.
set -euo pipefail

check="${1:?usage: run.sh keyboard|layout|audit [worst|full]}"
here="$(cd "$(dirname "$0")" && pwd)"
dist="$here/../../dist"
[ -f "$dist/index.html" ] || { echo "build first: bun design/prototype/tools/build.mjs" >&2; exit 2; }

node_exe="${NODE_EXE:-/mnt/c/Program Files/nodejs/node.exe}"
win_temp="$(wslpath "$(cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')")"
work="$win_temp/chatapp-d/harness"
mkdir -p "$work"
cp "$here"/*.mjs "$work"/

port="${PROTO_PORT:-8790}"
(cd "$dist" && exec python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1) &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$port/index.html" && break; sleep 0.2; done

export PROTO_URL="http://127.0.0.1:$port/index.html"
status=0
"$node_exe" "$(wslpath -w "$work/$check.mjs")" "${@:2}" || status=$?

if [ "$check" = audit ]; then
  python3 "$here/analyze-audit.py" "$win_temp/chatapp-d/shots" || status=$?
fi
exit "$status"
