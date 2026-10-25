import type { CSSProperties } from "react";

export type IconName = "arrow" | "code" | "archive" | "people" | "bulb" | "database" | "globe" | "worker" | "github" | "retry" | "lock" | "activity" | "copy" | "check";

export function Icon({name, className, style}: {name: IconName; className?: string; style?: CSSProperties}) {
  const paths: Record<Exclude<IconName, "github">, React.ReactNode> = {
    retry: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>,
    lock: <><rect x="4" y="10" width="16" height="12" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3m-5 5v3"/></>,
    activity: <><rect x="3" y="12" width="4" height="9" rx="1"/><rect x="10" y="6" width="4" height="15" rx="1"/><rect x="17" y="2" width="4" height="19" rx="1"/></>,
    copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
    check: <><path d="m5 12 4 4L20 5"/></>,
    arrow: <><path d="M4 12h15m-6-6 6 6-6 6"/></>,
    code: <><path d="m8 5-7 7 7 7m8-14 7 7-7 7"/></>,
    archive: <><rect x="3" y="6" width="18" height="15" rx="2"/><path d="M8 6V3h8v3m-8 5 4 4 4-4"/></>,
    people: <><circle cx="8" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><path d="M1 21v-2a7 7 0 0 1 14 0v2Zm15-9a6 6 0 0 1 7 6v3h-5"/></>,
    bulb: <><path d="M8 18c0-5-4-5-4-10a8 8 0 0 1 16 0c0 5-4 5-4 10Zm1 3h6m-5 2h4"/></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0M4 17c0 4 16 4 16 0"/></>,
    globe: <><circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="12" rx="4" ry="10"/><path d="M2 12h20M4 6h16M4 18h16"/></>,
    worker: <><path d="m10 2-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3Z"/><circle cx="12" cy="12" r="4"/></>,
  };
  return <svg width="24" height="24" className={className} style={style} viewBox="0 0 24 24" fill={name === "github" ? "currentColor" : "none"} stroke={name === "github" ? "none" : "currentColor"} strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === "github" ? <path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.2.8-.5v-2c-3.3.7-4-1.4-4-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.4-1.3-5.4-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.8 5.4-5.4 5.7.4.4.8 1.1.8 2.2v3.1c0 .3.2.6.8.5A11.4 11.4 0 0 0 12 .8Z"/> : paths[name]}
  </svg>;
}
