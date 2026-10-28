BEGIN;
CREATE TABLE "api_keys" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "api_keys_created_by_user_id_tenant_id_fkey" FOREIGN KEY ("created_by_user_id", "tenant_id") REFERENCES "tenant_memberships"("user_id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "api_keys_token_hash_key" ON "api_keys"("token_hash");
CREATE INDEX "api_keys_tenant_id_created_at_id_idx" ON "api_keys"("tenant_id", "created_at", "id");
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'waybill_reader') THEN
    REVOKE ALL ON api_keys FROM waybill_reader;
  END IF;
END $$;
COMMIT;
