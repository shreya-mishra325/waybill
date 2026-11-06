"use client";

import { useState } from "react";
import { DashboardBrand, DashboardGlyph, StatusChip } from "./dashboard/ui";
import { formatTimestamp, statusLabels } from "../lib/dashboard-format";
import { deliveryStatuses, type DeliveryRecord, type DeliveryStatus } from "../lib/dashboard-types";

type PreviewDelivery = Pick<DeliveryRecord, "id" | "event" | "targetUrl" | "status" | "attemptCount" | "createdAt" | "nextAttemptAt">;
const destination = "https://hooks.example.com/webhook";
const examples: PreviewDelivery[] = [
  { id: "8d4e30a2-307e-4fd7-9ef3-a29c71ef7a12", event: { type: "order.shipped" }, targetUrl: destination, status: "SUCCEEDED", attemptCount: 1, createdAt: "2026-11-07T12:04:00Z", nextAttemptAt: null },
  { id: "b719e052-8dfc-42b8-920e-573fed623f08", event: { type: "payment.received" }, targetUrl: destination, status: "FAILED", attemptCount: 3, createdAt: "2026-11-07T12:03:00Z", nextAttemptAt: "2026-11-07T12:05:00Z" },
  { id: "c28a47f9-fd71-49d8-b92a-6b75fd7e9d41", event: { type: "account.updated" }, targetUrl: destination, status: "DEAD_LETTERED", attemptCount: 8, createdAt: "2026-11-07T12:02:00Z", nextAttemptAt: null },
  { id: "f603a648-0a55-47ad-b01b-0432e49b2c76", event: { type: "order.created" }, targetUrl: destination, status: "FAILED", attemptCount: 1, createdAt: "2026-11-07T12:01:00Z", nextAttemptAt: null },
];
const filters: { label: string; status: "ALL" | DeliveryStatus }[] = [
  { label: "All", status: "ALL" },
  ...deliveryStatuses.map(status => ({ label: statusLabels[status], status })),
];

export function ProductPreview() {
  const [filter, setFilter] = useState<"ALL" | DeliveryStatus>("ALL");
  const visible = filter === "ALL" ? examples : examples.filter(row => row.status === filter);
  return <figure className="product-preview" aria-labelledby="preview-caption">
    <div className="delivery-viewer">
      <div className="viewer-header">
        <div className="viewer-brand"><DashboardBrand/></div>
        <span className="viewer-menu-icon" aria-hidden="true"><DashboardGlyph name="menu"/></span>
        <div className="viewer-navigation" aria-hidden="true"><span>Overview</span><span className="viewer-navigation-active">Deliveries</span><span>Dead letters</span><span>Observability</span></div>
        <span className="viewer-example-label">Example data</span>
      </div>
      <div className="viewer-main">
        <h3>Deliveries</h3>
        <p className="viewer-subtitle">Browse webhook deliveries for this workspace.</p>
        <div className="viewer-panel">
          <div className="viewer-filters" role="group" aria-label="Filter example deliveries">
            {filters.map(item => <button key={item.status} type="button" aria-pressed={filter === item.status} onClick={() => setFilter(item.status)}>{item.label}</button>)}
          </div>
          <div className="viewer-table-scroll" tabIndex={0} role="region" aria-label="Example delivery records; scroll horizontally to view all columns">
            <table className="viewer-table">
              <colgroup>{[19, 14, 8, 20, 18, 8, 13].map((width, index) => <col key={index} style={{ width: `${width}%` }}/>)}</colgroup>
              <thead><tr>{["Event", "Delivery ID", "Method", "Destination", "Status", "Attempts", "Created at"].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
              <tbody>{visible.map(row => {
                const timestamp = formatTimestamp(row.createdAt);
                return <tr key={row.id}>
                  <td className="viewer-event"><span className={`viewer-event-dot dashboard-status-${row.status.toLowerCase()}`} aria-hidden="true"/><span title={row.event.type}>{row.event.type}</span></td>
                  <td><code className="viewer-id" title={row.id}>{row.id.slice(0, 8)}…</code></td>
                  <td><span className="viewer-method">POST</span></td>
                  <td><span className="viewer-destination" title={row.targetUrl}>{row.targetUrl}</span></td>
                  <td><StatusChip row={row}/></td><td className="viewer-attempts">{row.attemptCount}</td>
                  <td><time dateTime={row.createdAt}>{timestamp.day}<small>{timestamp.time}</small></time></td>
                </tr>;
              })}{!visible.length && <tr><td className="viewer-empty" colSpan={7}>No example deliveries with this status.</td></tr>}</tbody>
            </table>
          </div>
          <p className="viewer-result" role="status">{visible.length} example {visible.length === 1 ? "delivery" : "deliveries"}<span className="viewer-scroll-hint"> · Scroll to see all columns</span></p>
        </div>
      </div>
    </div>
    <figcaption id="preview-caption">Interactive dashboard preview. Example records, not connected to an account.</figcaption>
  </figure>;
}
