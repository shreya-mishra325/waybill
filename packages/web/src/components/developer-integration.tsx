import { Icon, type IconName } from "./icon";
import { IntegrationCode } from "./integration-code";

const details: { title: string; text: string; icon: IconName }[] = [
  { title: "Start with plain HTTP", text: "Send a tenant ID, event type and JSON payload. Use your own HTTP client.", icon: "code" },
  { title: "Keep the receiver verifiable", text: "Workers sign each outgoing webhook with the tenant’s HMAC secret.", icon: "lock" },
  { title: "Inspect the outcome", text: "Read delivery status, attempt counts and scheduled retries through the history API.", icon: "activity" },
];

export function DeveloperIntegration() {
  return <section className="developer-section" id="developers" aria-labelledby="developer-title">
    <div className="site-container developer-layout">
      <div className="developer-copy">
        <p className="phase-five-eyebrow">Built for developers<span aria-hidden="true"/></p>
        <h2 id="developer-title">Integrate<br/> in minutes.</h2>
        <p className="developer-description">One endpoint. A familiar request. Connect your application using the tools you already work with.</p>
        <ul className="developer-details">{details.map(item => <li key={item.title}><Icon name={item.icon}/><div><h3>{item.title}</h3><p>{item.text}</p></div></li>)}</ul>
        <p className="developer-local-note">Examples target the local API on port 3000. The current API requires no authentication header.</p>
        <a className="developer-setup-link" href="https://github.com/shreya-mishra325/waybill#quick-start">Read the local setup <Icon name="arrow"/></a>
      </div>
      <IntegrationCode/>
    </div>
  </section>;
}
