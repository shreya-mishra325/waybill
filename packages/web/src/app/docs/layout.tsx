import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { LandingNetwork } from "../../components/landing-network";
import { Icon } from "../../components/icon";
import { DocsSidebar } from "../../components/docs/sidebar";
import { DocsSearch } from "../../components/docs/search";
import { DocsReader } from "../../components/docs/reader";
import "./docs.css";

export const metadata: Metadata = {
  title: "Documentation | Waybill",
  description: "Local setup, API reference, signed delivery, retries, replay and architecture for Waybill.",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <div className="public-site docs-site"><LandingNetwork/><a className="skip-link" href="#docs-article">Skip to documentation</a><SiteHeader docsPage/>
    <main className="site-container docs-shell" id="main-content">
      <div className="docs-intro"><p className="docs-eyebrow">Docs<span aria-hidden="true"/></p><p className="docs-headline">Clear documentation<br/> for real-world use.</p><p className="docs-intro-description">Get up and running with setup guides, API references and delivery behaviour from the current project.</p><a className="button button-secondary docs-repository-link" href="https://github.com/shreya-mishra325/waybill"><Icon name="github"/>View on GitHub</a></div>
      <div className="docs-frame"><DocsSidebar/><DocsReader><DocsSearch/>{children}</DocsReader></div>
    </main>
  </div>;
}
