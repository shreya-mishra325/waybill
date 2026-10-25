CREATE TABLE "replays" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "source_dead_letter_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "replays_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "replays_source_dead_letter_id_key" ON "replays"("source_dead_letter_id");
CREATE UNIQUE INDEX "replays_event_id_key" ON "replays"("event_id");
CREATE UNIQUE INDEX "replays_tenant_id_idempotency_key_key" ON "replays"("tenant_id", "idempotency_key");
CREATE INDEX "replays_tenant_id_created_at_idx" ON "replays"("tenant_id", "created_at");

ALTER TABLE "replays" ADD CONSTRAINT "replays_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replays" ADD CONSTRAINT "replays_source_dead_letter_id_fkey" FOREIGN KEY ("source_dead_letter_id") REFERENCES "dead_letters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "replays" ADD CONSTRAINT "replays_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
