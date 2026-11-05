#!/bin/bash
set -euo pipefail
if ! /usr/local/bin/bun /opt/waybill/current/infra/oracle/guard.ts lease; then
  systemctl --no-block start waybill-stop.service
fi
