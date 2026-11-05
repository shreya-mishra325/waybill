#!/bin/bash
set -euo pipefail
[[ "$EUID" == 0 ]] || exit 77
install -d -m 0755 /run/waybill-guard
install -d -m 0700 /var/lib/waybill-guard
printf 'Backend stopped; account, policy, health, or backup review required.\n' > /var/lib/waybill-guard/STOPPED
rm -f /run/waybill-guard/allowed.json
install -m 0644 /opt/waybill/current/infra/oracle/preview.caddy /etc/caddy/waybill-mode.caddy
if ! timeout 10 systemctl reload caddy; then
  echo "Caddy reload failed; backend shutdown will still proceed." >&2
fi
systemctl stop waybill-backend@api.service waybill-backend@publisher.service waybill-backend@worker.service waybill-backend@receiver.service
