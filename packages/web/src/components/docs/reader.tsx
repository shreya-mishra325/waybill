"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname } from "next/navigation";

export function DocsReader({children}: {children: ReactNode}) {
  const pathname = usePathname();
  const reader = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const anchor = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
    if (anchor) anchor.scrollIntoView({block: "start"});
    else reader.current?.scrollTo({top: 0, behavior: "instant"});
  }, [pathname]);
  return <div ref={reader} className="docs-reading" tabIndex={0} role="region" aria-label="Documentation article">{children}</div>;
}
