"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DOC_GROUPS, DOC_TOPICS, docsHref } from "../../lib/docs";
import { Icon } from "../icon";

export function DocsSidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const frame = requestAnimationFrame(() => document.getElementById("docs-article")?.focus({preventScroll: true}));
    return () => cancelAnimationFrame(frame);
  }, [pathname]);
  return <aside className="docs-sidebar">
    <button ref={button} type="button" className="docs-sidebar-toggle" aria-expanded={open} aria-controls="docs-navigation" onClick={() => setOpen(!open)}>Documentation <span aria-hidden="true">{open ? "−" : "+"}</span></button>
    <nav id="docs-navigation" aria-label="Documentation" className={open ? "docs-topic-nav is-open" : "docs-topic-nav"} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); button.current?.focus(); } }}>
      {DOC_GROUPS.map(group => <div className="docs-nav-group" key={group}><p>{group}</p><ul>{DOC_TOPICS.filter(topic => topic.group === group).map(topic => <li key={topic.slug}><Link href={docsHref(topic.slug)} aria-current={pathname === docsHref(topic.slug) ? "page" : undefined} onClick={() => { setOpen(false); moveFocus.current = true; }}><Icon name={group === "Start here" ? "code" : group === "Delivery" ? "archive" : "database"}/>{topic.title}</Link></li>)}</ul></div>)}
    </nav>
  </aside>;
}
