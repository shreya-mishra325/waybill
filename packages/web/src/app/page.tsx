import { SiteHeader } from "../components/site-header";
import { Product } from "../components/product";
import { HowItWorks } from "../components/how-it-works";
import { Features } from "../components/features";
import { DeveloperIntegration } from "../components/developer-integration";
import { LandingNetwork } from "../components/landing-network";
import { Hero } from "../components/hero";

export default function Home() {
  return <div className="public-site"><LandingNetwork/><a href="#main-content" className="skip-link">Skip to content</a><SiteHeader/><main id="main-content"><Hero/><Product/><HowItWorks/><Features/><DeveloperIntegration/></main></div>;
}
