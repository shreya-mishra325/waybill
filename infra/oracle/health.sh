#!/bin/bash
set -euo pipefail
cd /opt/waybill/current
timeout 3 timedatectl show --property=NTPSynchronized --value | grep -qx yes
curl --silent --show-error --fail --max-time 3 http://127.0.0.1:3000/health > /dev/null
dc=(docker compose --env-file /etc/waybill/infra.env -f infra/oracle/compose.yml)
(( $(df -Pk /opt/waybill | awk 'NR==2 {print $4}') >= 10 * 1024 * 1024 ))
(( $(awk '/MemAvailable/ {print $2}' /proc/meminfo) >= 512 * 1024 ))
timeout 5 "${dc[@]}" exec -T postgres pg_isready -U webhook -d webhook_platform >/dev/null
timeout 5 "${dc[@]}" exec -T postgres-replica psql -U webhook -d webhook_platform -Atc "SELECT pg_is_in_recovery() AND EXISTS (SELECT 1 FROM pg_stat_wal_receiver WHERE status = 'streaming')" | grep -qx t
timeout 5 "${dc[@]}" exec -T redis redis-cli ping | grep -qx PONG
