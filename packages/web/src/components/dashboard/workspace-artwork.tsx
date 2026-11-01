export function WorkspaceArtwork() {
  return <div className="dashboard-workspace-artwork" aria-hidden="true">
    <svg className="dashboard-workspace-curves" viewBox="0 0 1536 830" preserveAspectRatio="none" fill="none">
      <path className="dashboard-route dashboard-route-primary" d="M-30 330C150 230 210 520 390 570S680 450 850 520 1130 770 1270 695 1450 540 1560 560"/>
      <path className="dashboard-route" d="M-30 165C150 170 205 350 390 420S680 330 850 400 1130 595 1270 510 1450 285 1560 325"/>
      <path className="dashboard-route" d="M-30 200C150 205 205 385 390 455S680 365 850 435 1130 630 1270 545 1450 375 1560 410"/>
      <path className="dashboard-route dashboard-route-faint" d="M-30 125C150 130 205 310 390 380S680 290 850 360 1130 555 1270 470 1450 255 1560 295"/>
      <path className="dashboard-route" d="M-30 410C150 310 210 600 390 650S680 530 850 600 1130 850 1270 775 1450 620 1560 640"/>
      <path className="dashboard-route dashboard-route-faint" d="M-30 495C150 395 210 685 390 735S680 615 850 685 1130 935 1270 860 1450 705 1560 725"/>
      <path className="dashboard-route" d="M-30 270C150 170 210 460 390 510S680 390 850 460 1130 710 1270 635 1450 480 1560 500"/>
    </svg>
    <svg className="dashboard-workspace-flight" viewBox="0 0 300 160" fill="none">
      <path d="M10 125C66 128 112 77 77 64S51 109 115 115 210 57 244 40" stroke="var(--dash-accent)" strokeWidth="1" strokeDasharray="5 10" strokeLinecap="round"/>
      <svg className="dashboard-plane" x="240" y="0" width="60" height="48" viewBox="0 0 42 34" overflow="visible"><path d="M1 15.5 41 1 29.7 33 20.5 23.7 11.3 33 13.3 20.6 1 15.5ZM13.3 20.6 41 1 20.5 23.7M13.3 20.6 20.5 23.7" stroke="var(--dash-accent)" strokeWidth="1" strokeLinejoin="round"/></svg>
    </svg>
  </div>;
}
