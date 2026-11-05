\set ON_ERROR_STOP on
BEGIN;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM waybill_reader;
GRANT SELECT ON events, deliveries, dead_letters, replays TO waybill_reader;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO waybill_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO waybill_app;
COMMIT;
