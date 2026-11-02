"use client";

import { createContext, useContext, useRef } from "react";
import type { DeliveryRecord } from "../../lib/dashboard-types";

type Selection = { select: (record: DeliveryRecord) => void; read: (id: string) => DeliveryRecord | null };
const Context = createContext<Selection | null>(null);
export function DeliverySelectionProvider({ tenantId, children }: { tenantId: string | null; children: React.ReactNode }) {
  const selected = useRef<DeliveryRecord | null>(null);
  return <Context.Provider value={{
    select(record) { if (record.tenantId === tenantId) selected.current = record; },
    read(id) { const record = selected.current; return record?.tenantId === tenantId && record.id === id ? record : null; },
  }}>{children}</Context.Provider>;
}
export function useDeliverySelection() {
  const value = useContext(Context);
  if (!value) throw new Error("Delivery selection context is required");
  return value;
}
