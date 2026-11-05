#!/bin/sh
set -eu
: "${APP_PASSWORD:?}" "${READER_PASSWORD:?}" "${REPLICATION_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_PASSWORD" --set=reader_password="$READER_PASSWORD" \
  --set=replication_password="$REPLICATION_PASSWORD" <<'SQL'
CREATE ROLE waybill_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_password';
CREATE ROLE waybill_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'reader_password';
CREATE ROLE waybill_replication LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION PASSWORD :'replication_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE webhook_platform TO waybill_app, waybill_reader;
GRANT USAGE ON SCHEMA public TO waybill_app, waybill_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE webhook IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO waybill_app;
ALTER DEFAULT PRIVILEGES FOR ROLE webhook IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO waybill_app;
SELECT pg_create_physical_replication_slot('waybill_local_replica', true);
SQL
printf '\nhost replication waybill_replication samenet scram-sha-256\n' >> "$PGDATA/pg_hba.conf"
