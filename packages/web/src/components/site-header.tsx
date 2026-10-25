"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icon";

const notices = {
  access: {title: "Waybill is being built in the open.", text: "Hosted sign-in is not available yet. Get started with the local setup in the repository. No account is required to read it."},
};
type Notice = keyof typeof notices;

export function SiteHeader({ docsPage = false }: { docsPage?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<Notice>("access");
  const dialog = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  function explain(event: React.MouseEvent<HTMLAnchorElement>, kind: Notice) {
    event.preventDefault();
    setMenuOpen(false);
    setNotice(kind);
    dialog.current?.showModal();
  }
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
        <a href="#future-access" className="button button-primary sign-in" onClick={event => explain(event, "access")}>Sign in <Icon name="arrow"/></a>
      </nav>
    </header>
    <dialog ref={dialog} onClose={() => { if (window.matchMedia("(max-width: 767px)").matches) menuButton.current?.focus(); }} className="preview-dialog" aria-labelledby="preview-title" onClick={event => { if (event.target === dialog.current) dialog.current.close(); }}>
      <button className="dialog-close" onClick={() => dialog.current?.close()} aria-label="Close notice">×</button>
      <p className="eyebrow">PUBLIC SITE PREVIEW</p>
      <h2 id="preview-title">{notices[notice].title}</h2>
      <p>{notices[notice].text}</p>
      <a className="button button-primary" href="https://github.com/shreya-mishra325/waybill#quick-start">Read the local setup <Icon name="arrow"/></a>
    </dialog>
  </>;
}
