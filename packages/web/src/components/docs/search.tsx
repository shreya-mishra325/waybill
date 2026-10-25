"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { docsHref, searchDocs } from "../../lib/docs";

export function DocsSearch() {
  const [query, setQuery] = useState("");
  const pathname = usePathname();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const matches = searchDocs(query);
  useEffect(() => { setQuery(""); }, [pathname]);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches[0]) return;
    router.push(docsHref(matches[0].slug));
    setQuery("");
  }
  return <div className="docs-search">
    <form role="search" aria-label="Search documentation topics" onSubmit={submit}>
      <label className="sr-only" htmlFor="docs-search-input">Search documentation topics</label>
      <input id="docs-search-input" ref={input} type="search" autoComplete="off" placeholder="Search documentation…" value={query} aria-describedby="docs-search-status" onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setQuery(""); input.current?.focus(); } }}/>
      <button type="submit" aria-label="Open first matching topic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg></button>
    </form>
    <span id="docs-search-status" className="sr-only" role="status">{query.trim() ? `${matches.length} matching topics` : "Search topic names and keywords. Press Enter to open the first result."}</span>
    {query.trim() && <div className="docs-search-results">{matches.length ? <ul>{matches.slice(0, 6).map(topic => <li key={topic.slug}><Link href={docsHref(topic.slug)} onClick={() => setQuery("")}><strong>{topic.title}</strong><span>{topic.description}</span></Link></li>)}</ul> : <p>No matching topics. Try “events”, “replay”, or “setup”.</p>}</div>}
  </div>;
}
