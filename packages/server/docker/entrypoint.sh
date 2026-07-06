#!/bin/bash
set -e

node dist/index.js &
node_pid=$!

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
caddy_pid=$!

trap 'kill -TERM "$node_pid" "$caddy_pid" 2>/dev/null' TERM INT

wait -n "$node_pid" "$caddy_pid"
exit_code=$?

kill -TERM "$node_pid" "$caddy_pid" 2>/dev/null
wait "$node_pid" "$caddy_pid" 2>/dev/null
exit "$exit_code"
