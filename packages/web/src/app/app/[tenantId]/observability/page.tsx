import type { Metadata } from "next";
import { Observability } from "../../../../components/dashboard/observability";
import { grafanaLink } from "../../../../lib/observability";
import "./observability.css";

export const metadata: Metadata = { title: "Observability | Waybill" };
export default function ObservabilityPage() {
  const link = grafanaLink(process.env.GRAFANA_DASHBOARD_URL, process.env.NODE_ENV === "development");
  return <Observability grafana={link}/>;
}
