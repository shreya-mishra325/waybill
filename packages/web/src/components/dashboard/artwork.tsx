export function DashboardArtwork({ full = false }: { full?: boolean }) {
  return <svg className={full ? "dashboard-artwork dashboard-artwork-full" : "dashboard-artwork"} viewBox="0 0 820 170" fill="none" aria-hidden="true">
    <path className="dashboard-route dashboard-route-primary" d="M-20 126C110 25 169 35 280 90S448 -4 555 18 689 132 832 42"/>
    <path className="dashboard-route" d="M-20 144C110 43 169 71 280 122S448 34 555 58 689 150 832 60"/>
    <path className="dashboard-route" d="M-20 162C110 61 169 89 280 140S448 52 555 76 689 168 832 78"/>
    <path className="dashboard-route dashboard-route-faint" d="M-20 108C110 7 169 35 280 86S448-2 555 22 689 114 832 24"/>
    <circle className="dashboard-route-node" cx="350" cy="87" r="4.5" fill="var(--dash-accent)"/>
    <image className="dashboard-plane" href="/waybill-paper-airplane.svg" x="540" y="66" width="58" height="46"/>
  </svg>;
}
