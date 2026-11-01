"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

export function SiteHeader({ docsPage = false }: { docsPage?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    function close(event: KeyboardEvent) { if (event.key === "Escape") { setMenuOpen(false); if (window.matchMedia("(max-width: 767px)").matches) menuButton.current?.focus(); } }
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return <>
    <header className="site-header site-container flex items-center justify-between">
      <a className="brand flex items-center gap-3" href="/" aria-label="Waybill home">
        <img src="/waybill-logo.png" width="48" height="48" alt=""/><span>Waybill</span>
      </a>
      <button ref={menuButton} className="menu-toggle" aria-label={menuOpen ? "Close navigation" : "Open navigation"} aria-controls="public-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
        <span/><span/>
      </button>
      <nav id="public-navigation" aria-label="Main navigation" className={menuOpen ? "navigation is-open" : "navigation"}>
        <a href="/#product" onClick={() => { setMenuOpen(false); document.getElementById("product")?.focus({preventScroll: true}); }}>Product</a>
        <a href="/#features" onClick={() => { setMenuOpen(false); document.getElementById("features")?.focus({preventScroll: true}); }}>Features</a>
        <Link href="/docs" aria-current={docsPage ? "page" : undefined} onClick={() => setMenuOpen(false)}>Docs</Link>
        <Link href="/app" className="button button-primary sign-in" onClick={() => setMenuOpen(false)}>Sign in <Icon name="arrow"/></Link>
      </nav>
    </header>
  </>;
}
