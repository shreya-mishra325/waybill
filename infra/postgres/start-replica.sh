#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  exec su-exec postgres sh "$0"
fi

if [ ! -s "$PGDATA/PG_VERSION" ]; then
  if [ -n "$(ls -A "$PGDATA")" ]; then
    echo "Replica directory is not empty; inspect it before retrying initialization." >&2
    exit 1
  fi
  pg_basebackup -h postgres -U waybill_replication -D "$PGDATA" -R -X stream --checkpoint=fast --no-password
fi

if [ ! -f "$PGDATA/standby.signal" ]; then
  echo "Refusing to start a replica directory without standby.signal." >&2
  exit 1
fi

exec postgres -D "$PGDATA" -c hot_standby=on
