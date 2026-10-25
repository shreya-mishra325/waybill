import { Icon, type IconName } from "./icon";

const highlights: {icon: IconName; first: string; second: string}[] = [
  {icon: "code", first: "Reliable delivery", second: "tracking"},
  {icon: "archive", first: "Dead letter", second: "recovery"},
  {icon: "people", first: "Multi-tenant", second: "ready"},
  {icon: "bulb", first: "Developer", second: "friendly"},
];

export function Hero() {
  return <section className="hero" aria-labelledby="hero-title">
    <div className="site-container hero-content">
      <h1 id="hero-title"><span>Webhooks,</span><span>that actually <em>arrive.</em></span></h1>
      <p className="hero-description">Track, inspect and recover webhook deliveries<br className="desktop-break"/> without the guesswork.</p>
      <div className="hero-actions flex flex-wrap items-center">
        <a className="button button-primary" href="https://github.com/shreya-mishra325/waybill#quick-start">Get started <Icon name="arrow"/></a>
        <a className="button button-secondary" href="https://github.com/shreya-mishra325/waybill"><Icon name="github"/> View on GitHub</a>
      </div>
    </div>
    <ul className="site-container highlights" aria-label="Waybill highlights">
      {highlights.map(item => <li key={item.icon} className="flex items-center"><Icon name={item.icon}/><span>{item.first}<br/>{item.second}</span></li>)}
    </ul>
  </section>;
}
