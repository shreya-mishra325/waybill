#!/bin/bash
set -euo pipefail
cd /opt/waybill/current
if [[ "${1:-}" == web ]]; then
  cd packages/web
  exec /usr/local/bin/bun --bun next start --hostname 127.0.0.1 --port 3001
fi
case "${1:-}" in
  api) entry=packages/api/src/index.ts ;;
  publisher) entry=packages/worker/src/outbox-poller.ts ;;
  worker) entry=packages/worker/src/index.ts ;;
  receiver) entry=packages/shared/scripts/test-receiver.ts ;;
  *) echo "Use web, api, publisher, worker, or receiver." >&2; exit 64 ;;
esac
lease() { /usr/local/bin/bun infra/oracle/guard.ts lease; }
lease || exit 78
/usr/local/bin/bun "$entry" &
child=$!
stop_child() {
  kill -TERM "$child" 2>/dev/null || true
  for attempt in {1..30}; do
    kill -0 "$child" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL "$child" 2>/dev/null || true
}
trap 'stop_child; exit 0' TERM INT
while kill -0 "$child" 2>/dev/null; do
  if ! lease; then
    stop_child
    exit 78
  fi
  sleep 10 &
  wait $! || true
done
wait "$child"
