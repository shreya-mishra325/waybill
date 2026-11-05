#!/bin/bash
set -euo pipefail
[[ "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] || { echo "Requires ARM64 Linux." >&2; exit 1; }
[[ "$(/usr/local/bin/bun --version)" == 1.4.3 ]] || { echo "Install Bun 1.4.3." >&2; exit 1; }
openssl version
mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
(( mem_kb >= 8 * 1024 * 1024 )) || { echo "Less than 8 GiB visible RAM; review capacity before proceeding." >&2; exit 1; }
available_kb=$(df -Pk /opt/waybill | awk 'NR==2 {print $4}')
(( available_kb >= 20 * 1024 * 1024 )) || { echo "Need at least 20 GiB free for build/data headroom." >&2; exit 1; }
free -h
df -h /opt/waybill
docker compose version
ss -ltn | awk 'NR==1 || $4 ~ /:(80|443|3000|3001|4000|6379|9090|9100|9101|9102|3300|15432|15433)$/'
printf 'Host prerequisites passed; inspect listed ports for conflicts. Resource use is not yet measured.\n'
