import { cn } from '../lib/utils';

export type PageMotifKind = 'network' | 'flow' | 'library' | 'chart' | 'scan' | 'system';

const DRAWINGS: Record<PageMotifKind, string> = {
  network: 'M24 48 70 22l46 26-46 26zM24 48l46 26 46-26M70 22v52M24 48H8m108 0h16',
  flow: 'M10 28h30v40H10zM55 14h30v40H55zM100 38h30v40h-30zM40 48h15m30-14h8v24h7M20 38h10m-10 8h7m38-18h10m-10 8h7m38 16h10m-10 8h7',
  library:
    'M20 22h24v54H20zM51 14h24v62H51zM84 24l22-6 14 52-23 6zM26 32h12m19-8h12M29 62h6m25 0h6m32-29 10-3',
  chart: 'M12 76V14m0 62h118M28 64V49h16v15m13 0V36h16v28m13 0V23h16v41M20 33l29-12 29 4 37-17',
  scan: 'M18 32V16h20m64 0h20v16m0 32v16h-20m-64 0H18V64M37 34h66v28H37zM49 48l10 8 23-20M8 48h15m94 0h15',
  system:
    'M47 25h46v46H47zM57 35h26v26H57zM55 13v12m15-12v12m15-12v12M55 71v12m15-12v12m15-12v12M35 33h12m-12 15h12m-12 15h12m46-30h12M93 48h12M93 63h12',
};

/** Decorative page identity; its accent follows the surrounding page palette. */
export function PageMotif({
  kind = 'network',
  className,
}: {
  kind?: PageMotifKind;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 140 96"
      fill="none"
      className={cn('ws-page-motif', className)}
      aria-hidden="true"
      focusable="false"
    >
      <g className="ws-motif-grid" stroke="currentColor" strokeWidth="0.5">
        <path d="M10 0v96M40 0v96M70 0v96M100 0v96M130 0v96M0 18h140M0 48h140M0 78h140" />
      </g>
      <g
        className="ws-motif-drawing"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d={DRAWINGS[kind]} />
      </g>
      <g className="ws-motif-points" fill="currentColor">
        <circle cx="10" cy="18" r="2.5" />
        <circle cx="130" cy="78" r="2.5" />
        <circle cx="130" cy="18" r="1.5" />
        <circle cx="10" cy="78" r="1.5" />
      </g>
    </svg>
  );
}
