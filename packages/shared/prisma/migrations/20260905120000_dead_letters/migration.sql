-- CreateTable
CREATE TABLE "dead_letters" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "target_url" TEXT NOT NULL,
    "last_error" TEXT,
    "attempt_count" INTEGER NOT NULL,
    "payload_s3_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dead_letters_delivery_id_key" ON "dead_letters"("delivery_id");

-- CreateIndex
CREATE INDEX "dead_letters_tenant_id_idx" ON "dead_letters"("tenant_id");

-- AddForeignKey
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letters" ADD CONSTRAINT "dead_letters_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
