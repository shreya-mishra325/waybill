"use client";

import { useState } from "react";
import { Icon } from "./icon";

type PreviewStatus = "SUCCEEDED" | "FAILED" | "DEAD_LETTERED";
const examples: {id: string; destination: string; status: PreviewStatus; attempts: number}[] = [
  {id: "8d4e…7a12", destination: "https://hooks.example.com/orders", status: "SUCCEEDED", attempts: 1},
  {id: "b719…3f08", destination: "https://hooks.example.com/payments", status: "FAILED", attempts: 3},
  {id: "c28a…9d41", destination: "https://hooks.example.com/updates", status: "DEAD_LETTERED", attempts: 8},
  {id: "f603…2c76", destination: "https://hooks.example.com/orders", status: "SUCCEEDED", attempts: 1},
];
const filters = [
  {label: "All", status: "ALL"}, {label: "Delivered", status: "SUCCEEDED"},
  {label: "Retrying", status: "FAILED"}, {label: "Dead letters", status: "DEAD_LETTERED"},
] as const;
const statusLabels: Record<PreviewStatus, string> = {
  SUCCEEDED: "Delivered", FAILED: "Retry scheduled", DEAD_LETTERED: "Dead letter",
};

export function ProductPreview() {
  const [filter, setFilter] = useState<typeof filters[number]["status"]>("ALL");
  const visible = filter === "ALL" ? examples : examples.filter(row => row.status === filter);
  return <figure className="product-preview" aria-labelledby="preview-caption">
    <div className="delivery-viewer">
      <div className="viewer-header">
        <span className="viewer-brand"><img src="/waybill-logo.png" width="23" height="23" alt=""/>Waybill</span>
        <span className="viewer-example-label">Example data</span>
      </div>
      <div className="viewer-body">
        <div className="viewer-sidebar" aria-hidden="true">
          <span><Icon name="database"/>Overview</span>
          <span className="viewer-sidebar-active"><Icon name="code"/>Deliveries</span>
          <span><Icon name="archive"/>Dead letters</span>
        </div>
        <div className="viewer-main">
          <h3>Deliveries</h3>
          <div className="viewer-filters" role="group" aria-label="Filter example deliveries">
            {filters.map(item => <button key={item.status} type="button" aria-pressed={filter === item.status} onClick={() => setFilter(item.status)}>{item.label}</button>)}
          </div>
          <div className="viewer-table-scroll" tabIndex={0} role="region" aria-label="Example delivery records">
            <table className="viewer-table">
              <thead><tr><th scope="col">Event</th><th scope="col">Destination</th><th scope="col">Status</th><th scope="col">Attempts</th></tr></thead>
              <tbody>{visible.map(row => <tr key={row.id}>
                <td className="viewer-event">{row.id}</td><td className="viewer-destination">{row.destination}</td>
                <td><span className={`viewer-status viewer-status-${row.status.toLowerCase()}`}>{statusLabels[row.status]}</span></td><td className="viewer-attempts">{row.attempts}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p className="viewer-result" role="status">{visible.length} example {visible.length === 1 ? "delivery" : "deliveries"}<span className="viewer-scroll-hint"> · Scroll to see all columns</span></p>
        </div>
      </div>
    </div>
    <figcaption id="preview-caption">Illustrative delivery viewer. Example records, not connected to an account.</figcaption>
  </figure>;
}
