#!/bin/bash
set -euo pipefail
[[ "$EUID" == 0 ]] || { echo "Run as root." >&2; exit 77; }
: "${BACKUP_RECIPIENT:?}" "${BACKUP_UPLOAD_PREFIX:?}"
[[ "$BACKUP_RECIPIENT" =~ ^[A-Fa-f0-9]{40,64}$ ]] || exit 78
[[ "$BACKUP_UPLOAD_PREFIX" =~ ^https://objectstorage\.[a-z0-9-]+\.oraclecloud\.com/p/[A-Za-z0-9_=-]+/n/[A-Za-z0-9_-]+/b/[A-Za-z0-9._-]+/o/waybill-backups/$ ]] || exit 78
umask 077
cd /opt/waybill/current
mkdir -p /var/backups/waybill /var/lib/waybill-backup
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dc=(docker compose --env-file /etc/waybill/infra.env -f infra/oracle/compose.yml)
encrypt() { gpg --batch --trust-model always --recipient "$BACKUP_RECIPIENT" --encrypt --output "$1"; }
"${dc[@]}" exec -T postgres pg_dump -U webhook -d webhook_platform -Fc | encrypt "/var/backups/waybill/$stamp.database.dump.gpg"
"${dc[@]}" exec -T postgres pg_dumpall -U webhook --globals-only | encrypt "/var/backups/waybill/$stamp.roles.sql.gpg"
for suffix in database.dump roles.sql; do
  file="/var/backups/waybill/$stamp.$suffix.gpg"
  printf 'url = "%s%s.%s.gpg"\n' "$BACKUP_UPLOAD_PREFIX" "$stamp" "$suffix" | curl --config - --silent --show-error --fail --proto '=https' --connect-timeout 10 --max-time 180 --upload-file "$file" --output /dev/null
done
date +%s > /var/lib/waybill-backup/success.tmp
mv /var/lib/waybill-backup/success.tmp /var/lib/waybill-backup/success
find /var/backups/waybill -maxdepth 1 -type f -name '????????T??????Z.*.gpg' -mtime +7 -delete
printf 'Encrypted database and roles uploaded; backup health timestamp updated.\n'
