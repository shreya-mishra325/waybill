import { AuthReturn } from "../components/auth-return";
import { SiteHeader } from "../components/site-header";
import { Product } from "../components/product";
import { HowItWorks } from "../components/how-it-works";
import { Features } from "../components/features";
import { DeveloperIntegration } from "../components/developer-integration";
import { LandingNetwork } from "../components/landing-network";
import { Hero } from "../components/hero";

export default function Home() {
  return <div className="public-site"><AuthReturn apiOrigin={process.env.AUTH_API_ORIGIN ?? "http://127.0.0.1:3000"}/><LandingNetwork/><a href="#main-content" className="skip-link">Skip to content</a><SiteHeader/><main id="main-content"><Hero/><Product/><HowItWorks/><Features/><DeveloperIntegration/></main></div>;
}
