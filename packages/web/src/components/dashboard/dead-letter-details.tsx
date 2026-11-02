"use client";

import { useEffect, useRef, useState } from "react";
import { requestDashboardApi } from "../../lib/dashboard-api";
import { archivedPayloadJson, deadLetterError, deadLetterPath, type DeadLetterRecord, type ReplayReceipt } from "../../lib/dead-letters";
import { formatCount, formatTimestamp } from "../../lib/dashboard-format";
import { useDashboard } from "./provider";
import { DashboardGlyph } from "./ui";
import { ArchivedPayloadViewer } from "./archived-payload-viewer";
import { DeadLetterReplay } from "./dead-letter-replay";

type PayloadState = { status: "loading" } | { status: "ready"; json: string } | { status: "error"; message: string; missing: boolean };
export function DeadLetterDetails({ row, revision, onBusy, onReplay }: { row: DeadLetterRecord; revision: number; onBusy: (busy: boolean) => void; onReplay: (receipt: ReplayReceipt) => void }) {
  const { apiOrigin, invalidate } = useDashboard(); const [retry, setRetry] = useState(0); const heading = useRef<HTMLHeadingElement>(null);
  const [payload, setPayload] = useState<PayloadState>({ status: "loading" });
  const { id, tenantId, eventId } = row;
  useEffect(() => {
    const controller = new AbortController(); setPayload({ status: "loading" });
    requestDashboardApi(apiOrigin, `${deadLetterPath(tenantId, id)}/payload`, { signal: controller.signal }).then(value => archivedPayloadJson(value, row))
      .then(json => { if (!controller.signal.aborted) setPayload({ status: "ready", json }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const failure = deadLetterError(error, "payload");
        if (failure.status === 401) invalidate();
        else setPayload({ status: "error", message: failure.message, missing: failure.status === 410 || failure.status === 404 });
      });
    return () => controller.abort();
  }, [apiOrigin, id, tenantId, eventId, retry, revision, invalidate]);
  useEffect(() => {
    if (!matchMedia("(max-width: 1000px)").matches) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [id]);
  const archived = formatTimestamp(row.createdAt);
  const replayed = row.replay ? formatTimestamp(row.replay.createdAt) : null;
  return <section className="dead-letter-details dashboard-panel" aria-labelledby="dead-letter-selected-title">
    <header><div><h2 id="dead-letter-selected-title" ref={heading} tabIndex={-1}>{row.event.type}</h2><p className="dead-selected-id"><span className="dead-id-label">Dead letter ID ·</span><span className="dead-id-value" title={row.id}>{row.id}</span></p></div><span className="dead-letter-badge"><i aria-hidden="true"/>Dead letter</span></header>
    <p className="dead-selected-caption">Archived after automatic delivery attempts ended.</p>
    <dl className="dead-selected-metadata"><div><dt>Destination</dt><dd>{row.targetUrl}</dd></div><div><dt>Attempts</dt><dd>{formatCount(row.attemptCount)} recorded</dd></div><div><dt>Archived at</dt><dd><time dateTime={row.createdAt}>{archived.day}, {archived.time}</time></dd></div><div><dt>Replay</dt><dd>{row.replay ? "Requested" : "Not requested"}{replayed && <small>{replayed.day}, {replayed.time}</small>}</dd></div></dl>
    {row.replay && <p className="dead-existing-replay">Replay event: <span>{row.replay.eventId}</span></p>}
    <div className="dead-stored-error"><DashboardGlyph name="alert"/><div><strong>Last recorded error</strong><p>{row.lastError || "No error recorded."}</p></div></div>
    {payload.status === "ready" ? <ArchivedPayloadViewer json={payload.json}/> : <section className="dead-payload-state" aria-busy={payload.status === "loading"}><h3>Archived payload</h3>{payload.status === "loading" ? <div role="status">Loading archived payload…<span className="dashboard-skeleton"/></div> : <div role="alert"><strong>{payload.missing ? "Payload unavailable" : "Unable to retrieve payload"}</strong><p>{payload.message}</p><button className="dashboard-button" type="button" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}</section>}
    <DeadLetterReplay row={row} payloadReady={payload.status === "ready"} revision={revision} onBusy={onBusy} onReplay={onReplay}/>
  </section>;
}
