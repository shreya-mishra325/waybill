import type { Metadata } from "next";
import { Deliveries } from "../../../../components/dashboard/deliveries";
import "./deliveries.css";

export const metadata: Metadata = { title: "Deliveries | Waybill" };
export default function DeliveriesPage() { return <Deliveries/>; }
