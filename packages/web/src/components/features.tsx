import { Icon, type IconName } from "./icon";

const features: { title: string; description: string; icon: IconName }[] = [
  { title: "Transactional outbox", description: "Commit the event and its outbox entry together, then publish saved work to SQS.", icon: "database" },
  { title: "Retries and backoff", description: "Retry failed deliveries with exponential backoff, jitter and a bounded attempt budget.", icon: "retry" },
  { title: "Dead-letter recovery", description: "Inspect archived payloads and explicitly replay a failed delivery as a new event.", icon: "archive" },
  { title: "Multi-tenant fairness", description: "Rotate outbox publication across tenants and bound each tenant’s dispatch turns.", icon: "people" },
  { title: "Secure delivery", description: "Verify outbound webhook authenticity with a tenant-specific HMAC-SHA256 signature.", icon: "lock" },
  { title: "Delivery visibility", description: "Query delivery status, attempt counts and retry state through replica-backed history APIs.", icon: "activity" },
];

export function Features() {
  return <section className="features-section" id="features" aria-labelledby="features-title" tabIndex={-1}>
    <div className="site-container">
      <div className="features-heading">
        <div><p className="phase-five-eyebrow">Features<span aria-hidden="true"/></p><h2 id="features-title">Everything you need<br/> for reliable delivery.</h2></div>
        <p className="features-intro">From ingestion to recovery, the pieces to deliver webhooks and understand their outcome.</p>
      </div>
      <ul className="features-grid">{features.map(feature => <li key={feature.title}><Icon name={feature.icon}/><h3>{feature.title}</h3><p>{feature.description}</p></li>)}</ul>
    </div>
  </section>;
}
