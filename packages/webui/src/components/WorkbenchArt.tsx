/** Theme-aware, decorative vectors. No timers, external assets or SVG IDs. */
export function WorkbenchArt() {
  return (
    <svg
      className="ws-workbench-art"
      viewBox="0 0 360 240"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g className="ws-art-grid" stroke="currentColor" strokeWidth="0.6">
        <path d="M0 60h360M0 120h360M0 180h360M60 0v240M120 0v240M180 0v240M240 0v240M300 0v240" />
        <circle cx="180" cy="120" r="104" />
        <circle cx="180" cy="120" r="76" strokeDasharray="2 7" />
      </g>
      <g className="ws-art-traces" stroke="currentColor" strokeWidth="1.2">
        <path d="M38 78h52l29 29M322 78h-52l-29 29M38 174h52l30-31M322 174h-52l-30-31" />
        <path d="M180 17v34M180 189v34" strokeDasharray="3 5" />
        <circle cx="38" cy="78" r="4" />
        <circle cx="322" cy="78" r="4" />
        <circle cx="38" cy="174" r="4" />
        <circle cx="322" cy="174" r="4" />
      </g>
      <g className="ws-art-stack ws-art-stack-back">
        <path d="m180 110 76 38-76 39-76-39z" />
        <path d="m104 148 76 38 76-38" />
      </g>
      <g className="ws-art-stack ws-art-stack-middle">
        <path d="m180 81 76 38-76 39-76-39z" />
        <path d="m104 119 76 38 76-38" />
      </g>
      <g className="ws-art-stack ws-art-stack-front">
        <path d="m180 52 76 38-76 39-76-39z" />
        <path d="m104 90 76 38 76-38" />
        <path className="ws-art-code" d="m166 79-18 11 18 10m28-21 18 11-18 10m-10-25-9 30" />
      </g>
      <g className="ws-art-orbit">
        <circle cx="180" cy="16" r="4" className="ws-art-signal" />
        <circle cx="180" cy="224" r="3" className="ws-art-secondary" />
      </g>
      <g className="ws-art-signal" fill="currentColor">
        <path d="M57 113v10m-5-5h10M298 113v10m-5-5h10" stroke="currentColor" />
        <circle cx="91" cy="38" r="2" />
        <circle cx="269" cy="203" r="2" />
      </g>
    </svg>
  );
}

export function LauncherArt({ kind }: { kind: 'audit' | 'performance' | 'design' }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" focusable="false">
      <path d="M5 16V5h11M32 5h11v11M43 32v11H32M16 43H5V32" stroke="currentColor" opacity="0.35" />
      <path d="M5 5h38v38H5z" fill="currentColor" opacity="0.04" />
      {kind === 'audit' ? (
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <circle cx="24" cy="24" r="11" strokeDasharray="3 4" />
          <circle cx="24" cy="24" r="5" />
          <path d="M24 9v6m0 18v6M9 24h6m18 0h6" />
          <path d="m21.5 24 1.7 1.7 3.5-3.5" />
        </g>
      ) : kind === 'design' ? (
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="10" y="11" width="28" height="26" rx="3" />
          <path d="M10 18h28M18 18v19" />
          <circle cx="14" cy="14.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="17.5" cy="14.5" r="1" fill="currentColor" stroke="none" />
          <rect x="22" y="22" width="12" height="5" rx="1.5" />
          <path d="M22 31h7m3 0h2" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 32a14 14 0 1 1 24 0M24 12v3M13.6 17.6l2 2m18.8-2-2 2M10 27h4m20 0h4" />
          <path d="m24 27 8-8" />
          <circle cx="24" cy="27" r="3" />
          <path d="M19 36h10" />
        </g>
      )}
    </svg>
  );
}
