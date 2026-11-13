/**
 * Design inspect — reference-free rendered quality rules.
 *
 * Turns `DESIGN_INSPECT_EXTRACTOR` measurements (one per viewport) into
 * findings with a stable id, a FAIL/WARN severity, the measured value and the
 * threshold. FAIL marks a defect any reviewer would call broken (overflow,
 * contrast below WCAG, a target below WCAG 2.2's 24px, a broken image); WARN
 * marks a likely craft problem that may be intentional and must be defended
 * in one sentence or fixed.
 *
 * Rules are deliberately few and measurable. Thresholds depend on the surface:
 * a marketing/content `page` and a dense `app` screen have different honest
 * minimums for body size and type-size count. Everything the measurement
 * cannot see is listed in `notCovered`, so a clean report never reads as a
 * complete review.
 */

export type InspectSeverity = 'FAIL' | 'WARN';
export type InspectSurface = 'page' | 'app';
export type InspectStage = 'hero' | 'full';

export interface InspectSample {
  sel: string;
  t?: string | undefined;
  [measure: string]: unknown;
}

/** One viewport's raw measurement, exactly as the in-page script returns it. */
export interface DesignInspectRaw {
  v: 1;
  url: string;
  vw: number;
  vh: number;
  docH: number;
  scrollW: number;
  overflow: InspectSample[];
  edgeText: InspectSample[];
  edgeCount: number;
  longLines: InspectSample[];
  longCount: number;
  sizes: Record<string, number>;
  families: Record<string, number>;
  loaded: string[];
  headings: Array<{ l: number; lines: number; fs: number; t: string; y: number }>;
  contrast: InspectSample[];
  contrastCount: number;
  contrastChecked: number;
  smallTargets: InspectSample[];
  smallCount: number;
  targetsChecked: number;
  brokenImages: InspectSample[];
  unsizedImages: number;
  hiddenText: InspectSample[];
  hiddenCount: number;
  blankBands: number[];
  bodySizes: Record<string, number>;
  justified: number;
  elements: number;
  heroFold?: { h1Bottom: number; ctaBottom: number | null } | null | undefined;
  heroDeadBand?: number | undefined;
  headingProximity?: InspectSample[] | undefined;
  unboundedCount?: number | undefined;
  unbounded?: InspectSample[] | undefined;
}

/** Browser evidence the manager collected for the same session. */
export interface InspectRuntimeEvidence {
  consoleErrors: string[];
  failedRequests: string[];
}

export interface InspectFinding {
  id: string;
  severity: InspectSeverity;
  viewport: number;
  message: string;
  measured: string;
  threshold: string;
  samples: InspectSample[];
}

export interface DesignInspectReport {
  url: string;
  surface: InspectSurface;
  stage?: InspectStage | undefined;
  viewports: number[];
  findings: InspectFinding[];
  fails: number;
  warns: number;
  /** Rule ids that ran — a missing id was not checked, not passed. */
  checked: string[];
  notCovered: string[];
}

const INSPECT_RULES = [
  'layout.horizontal-overflow',
  'layout.text-at-edge',
  'layout.blank-band',
  'layout.hero-fold',
  'layout.hero-dead-band',
  'layout.heading-proximity',
  'layout.unbounded-ultrawide',
  'type.body-size',
  'type.line-length',
  'type.size-count',
  'type.family-count',
  'type.heading-order',
  'type.headline-wrap',
  'type.justified',
  'a11y.text-contrast',
  'a11y.target-size',
  'media.broken-image',
  'media.unsized-image',
  'content.stuck-hidden',
  'runtime.console-error',
  'runtime.failed-request',
] as const;

const NOT_COVERED = [
  'focus visibility and keyboard order (exercise with Tab — accessibility skill)',
  'hover/active/disabled/loading/error states (only the initial render is measured)',
  'contrast of text over images or gradients (skipped, not passed)',
  'motion and prefers-reduced-motion behaviour',
  'copy quality, imagery and visual direction (design-critique)',
];

/** Thresholds per surface. Documented in design-critique so the model sees the same numbers. */
export const INSPECT_THRESHOLDS = {
  page: { bodyFail: 12, bodyWarn: 16, sizeCount: 6, families: 3, headlineLines: 3 },
  app: { bodyFail: 11, bodyWarn: 13, sizeCount: 8, families: 3, headlineLines: 3 },
  lineLengthCh: 80,
  stuckHidden: 3,
  narrow: 480,
} as const;

/** Distinct values carrying at least `share` of the total weight. */
function used(map: Record<string, number>, share = 0.01): string[] {
  const total = Object.values(map).reduce((s, n) => s + n, 0) || 1;
  return Object.entries(map)
    .filter(([, n]) => n / total >= share)
    .map(([k]) => k);
}

function dominant(map: Record<string, number>): number | null {
  let best: string | null = null;
  for (const [k, n] of Object.entries(map)) if (best === null || n > (map[best] ?? 0)) best = k;
  return best === null ? null : Number(best);
}

const MONO_RE = /mono|code|courier|consol|menlo|monaco/i;

function inspectViewport(
  raw: DesignInspectRaw,
  surface: InspectSurface = 'page',
  runtime?: InspectRuntimeEvidence,
  stage: InspectStage = 'full',
): InspectFinding[] {
  const t = INSPECT_THRESHOLDS[surface];
  const vw = raw.vw;
  const narrow = vw <= INSPECT_THRESHOLDS.narrow;
  const out: InspectFinding[] = [];
  const add = (
    f: Omit<InspectFinding, 'viewport' | 'samples'> & { samples?: InspectSample[] },
  ): void => {
    out.push({ viewport: vw, samples: [], ...f });
  };

  if (raw.scrollW > vw + 1)
    add({
      id: 'layout.horizontal-overflow',
      severity: 'FAIL',
      message: 'The page scrolls sideways.',
      measured: `scrollWidth ${raw.scrollW}px`,
      threshold: '≤ the viewport width',
      samples: raw.overflow,
    });
  if (raw.edgeCount > 0)
    add({
      id: 'layout.text-at-edge',
      severity: narrow ? 'FAIL' : 'WARN',
      message: 'Text sits within 8px of the viewport edge.',
      measured: `${raw.edgeCount} element(s)`,
      threshold: '≥ 8px gutter',
      samples: raw.edgeText,
    });
  const bands = Math.ceil(raw.docH / raw.vh);
  // The last band is often a short tail; only full blank viewports count.
  const blank = raw.blankBands.filter(
    (b) => b < bands - 1 || raw.docH - b * raw.vh >= raw.vh * 0.9,
  );
  if (blank.length)
    add({
      id: 'layout.blank-band',
      severity: 'WARN',
      message: 'A full viewport height shows no text or media.',
      measured: `band(s) ${blank.map((b) => `${b * raw.vh}–${(b + 1) * raw.vh}px`).join(', ')}`,
      threshold: '0',
    });

  if (surface === 'page' && vw >= 1200 && raw.heroFold) {
    const foldFloor = 800;
    const h1Over = raw.heroFold.h1Bottom > foldFloor;
    const ctaOver = raw.heroFold.ctaBottom !== null && raw.heroFold.ctaBottom > foldFloor;
    if (h1Over || ctaOver) {
      add({
        id: 'layout.hero-fold',
        severity: stage === 'hero' ? 'FAIL' : 'WARN',
        message: 'Opening headline or primary CTA falls below the 800px desktop fold.',
        measured: `heading bottom ${raw.heroFold.h1Bottom}px${raw.heroFold.ctaBottom !== null ? `, CTA bottom ${raw.heroFold.ctaBottom}px` : ''}`,
        threshold: '≤ 800px at desktop width',
      });
    }
  }
  if (surface === 'page' && (raw.heroDeadBand ?? 0) > 160) {
    add({
      id: 'layout.hero-dead-band',
      severity: 'WARN',
      message: 'Opening hero has an empty vertical gap taller than 160px.',
      measured: `${raw.heroDeadBand}px empty band inside 0–800px`,
      threshold: '≤ 160px',
    });
  }
  if ((raw.headingProximity?.length ?? 0) > 0) {
    add({
      id: 'layout.heading-proximity',
      severity: 'WARN',
      message:
        'Subheadings sit closer to the preceding block than to the content they introduce (Gestalt proximity).',
      measured: `${raw.headingProximity!.length} heading(s)`,
      threshold: 'space above ≥ space below',
      samples: raw.headingProximity!,
    });
  }
  if (surface === 'page' && vw >= 1600 && (raw.unboundedCount ?? 0) > 0) {
    add({
      id: 'layout.unbounded-ultrawide',
      severity: 'WARN',
      message: 'Text-heavy container stretches uncapped across ultrawide viewports.',
      measured: `${raw.unboundedCount} container(s) > 1640px`,
      threshold: '≤ 1640px max-width',
      samples: raw.unbounded ?? [],
    });
  }

  const body = dominant(raw.bodySizes);
  if (body !== null && body < t.bodyWarn)
    add({
      id: 'type.body-size',
      severity: body < t.bodyFail ? 'FAIL' : 'WARN',
      message: 'Body copy is small for this surface.',
      measured: `${body}px`,
      threshold: `≥ ${t.bodyWarn}px (${surface})`,
    });
  if (raw.longCount > 0)
    add({
      id: 'type.line-length',
      severity: 'WARN',
      message: 'Paragraph lines are longer than comfortable reading.',
      measured: `${raw.longCount} block(s), up to ${Math.max(...raw.longLines.map((s) => Number(s.ch) || 0))}ch`,
      threshold: `≤ ${INSPECT_THRESHOLDS.lineLengthCh}ch`,
      samples: raw.longLines,
    });
  const sizes = used(raw.sizes);
  if (sizes.length > t.sizeCount)
    add({
      id: 'type.size-count',
      severity: 'WARN',
      message: 'Too many distinct font sizes carry text — the scale is not a system.',
      measured: `${sizes.length} sizes (${sizes.sort((a, b) => Number(a) - Number(b)).join(', ')}px)`,
      threshold: `≤ ${t.sizeCount} (${surface})`,
    });
  const families = used(raw.families).filter((f) => !MONO_RE.test(f));
  if (families.length > t.families)
    add({
      id: 'type.family-count',
      severity: 'WARN',
      message: 'More non-monospace font families carry text than a coherent pairing needs.',
      measured: families.join(', '),
      threshold: `≤ ${t.families}`,
    });

  const levels = [...raw.headings].sort((a, b) => a.y - b.y);
  const h1 = levels.filter((h) => h.l === 1).length;
  const skips = levels.filter((h, i) => i > 0 && h.l - (levels[i - 1]?.l ?? h.l) > 1);
  if (skips.length || (surface === 'page' && h1 !== 1))
    add({
      id: 'type.heading-order',
      severity: 'WARN',
      message: 'Heading levels skip or the page does not have exactly one h1.',
      measured: `h1 × ${h1}${skips.length ? `; skips at ${skips.map((h) => `h${h.l} "${h.t}"`).join(', ')}` : ''}`,
      threshold: 'one h1, no skipped level',
    });
  const wrapped = levels.filter((h) => h.l <= 2 && h.lines > t.headlineLines);
  if (wrapped.length)
    add({
      id: 'type.headline-wrap',
      severity: 'WARN',
      message: 'A main heading wraps onto many lines.',
      measured: wrapped.map((h) => `h${h.l} ${h.lines} lines "${h.t}"`).join('; '),
      threshold: `≤ ${t.headlineLines} lines`,
    });
  if (raw.justified > 0)
    add({
      id: 'type.justified',
      severity: 'WARN',
      message: 'Justified paragraphs create uneven word spacing on the web.',
      measured: `${raw.justified} block(s)`,
      threshold: '0',
    });

  if (raw.contrastCount > 0)
    add({
      id: 'a11y.text-contrast',
      severity: 'FAIL',
      message: 'Text is below its WCAG AA contrast minimum against the background behind it.',
      measured: `${raw.contrastCount} of ${raw.contrastChecked} text element(s)`,
      threshold: '≥ 4.5:1 (≥ 3:1 large text)',
      samples: raw.contrast,
    });
  if (raw.smallCount > 0)
    add({
      id: 'a11y.target-size',
      severity: 'FAIL',
      message: 'Interactive targets are below the WCAG 2.2 minimum (inline text links excepted).',
      measured: `${raw.smallCount} of ${raw.targetsChecked} target(s)`,
      threshold: '≥ 24×24px (44px recommended for primary touch controls)',
      samples: raw.smallTargets,
    });
  if (raw.brokenImages.length)
    add({
      id: 'media.broken-image',
      severity: 'FAIL',
      message: 'Images failed to load.',
      measured: `${raw.brokenImages.length} image(s)`,
      threshold: '0',
      samples: raw.brokenImages,
    });
  if (raw.unsizedImages > 0)
    add({
      id: 'media.unsized-image',
      severity: 'WARN',
      message: 'Images without width/height or aspect-ratio shift the layout while loading.',
      measured: `${raw.unsizedImages} image(s)`,
      threshold: '0',
    });
  if (raw.hiddenCount >= INSPECT_THRESHOLDS.stuckHidden)
    add({
      id: 'content.stuck-hidden',
      severity: 'WARN',
      message: 'Text is still invisible after load — an entrance animation may never fire.',
      measured: `${raw.hiddenCount} element(s)`,
      threshold: `< ${INSPECT_THRESHOLDS.stuckHidden}`,
      samples: raw.hiddenText,
    });

  if (runtime?.consoleErrors.length)
    add({
      id: 'runtime.console-error',
      severity: 'WARN',
      message: 'The page logged errors while loading.',
      measured: `${runtime.consoleErrors.length} error(s)`,
      threshold: '0',
      samples: runtime.consoleErrors
        .slice(0, 4)
        .map((text) => ({ sel: 'console', t: text.slice(0, 160) })),
    });
  if (runtime?.failedRequests.length)
    add({
      id: 'runtime.failed-request',
      severity: 'WARN',
      message: 'Requests failed while loading.',
      measured: `${runtime.failedRequests.length} request(s)`,
      threshold: '0',
      samples: runtime.failedRequests
        .slice(0, 4)
        .map((url) => ({ sel: 'network', t: url.slice(0, 160) })),
    });
  return out;
}

export function inspectDesign(
  raws: Array<{ raw: DesignInspectRaw; runtime?: InspectRuntimeEvidence | undefined }>,
  surface: InspectSurface = 'page',
  options?: { stage?: InspectStage | undefined },
): DesignInspectReport {
  const stage: InspectStage = options?.stage ?? 'full';
  const ordered = [...raws].sort((a, b) => b.raw.vw - a.raw.vw);
  const findings = ordered.flatMap(({ raw, runtime }) =>
    inspectViewport(raw, surface, runtime, stage),
  );
  return {
    url: ordered[0]?.raw.url ?? '',
    surface,
    ...(options?.stage ? { stage } : {}),
    viewports: ordered.map(({ raw }) => raw.vw),
    findings,
    fails: findings.filter((f) => f.severity === 'FAIL').length,
    warns: findings.filter((f) => f.severity === 'WARN').length,
    checked: [...INSPECT_RULES],
    notCovered: NOT_COVERED,
  };
}

function sampleLine(s: InspectSample): string {
  const extra = Object.entries(s)
    .filter(([k]) => k !== 'sel' && k !== 't')
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  return `\`${s.sel}\`${extra ? ` ${extra}` : ''}${s.t ? ` "${s.t}"` : ''}`;
}

export function renderInspectMarkdown(report: DesignInspectReport): string {
  const lines = [
    `# Inspect — ${report.url}`,
    `Surface: ${report.surface} · viewports ${report.viewports.join(', ')}px · ${report.fails} FAIL · ${report.warns} WARN`,
    report.fails === 0
      ? 'Gate: PASS (no FAIL). Fix or defend each WARN in one sentence.'
      : 'Gate: FAIL. Fix every FAIL, re-run inspect, at most 3 rounds; then report what remains.',
    '',
  ];
  for (const sev of ['FAIL', 'WARN'] as const) {
    const own = report.findings.filter((f) => f.severity === sev);
    if (!own.length) continue;
    lines.push(`## ${sev}`);
    // One line per rule; the same defect at three widths is one defect.
    const ids = [...new Set(own.map((f) => f.id))];
    for (const id of ids) {
      const group = own.filter((f) => f.id === id);
      const first = group[0] as InspectFinding;
      const at = group.map((f) => `${f.viewport}: ${f.measured}`).join(' · ');
      lines.push(`- [${id}] ${first.message} ${at}; threshold ${first.threshold}.`);
      const samples = group.find((f) => f.samples.length)?.samples ?? [];
      for (const s of samples.slice(0, 3)) lines.push(`  - ${sampleLine(s)}`);
    }
    lines.push('');
  }
  lines.push(
    `Rules run: ${report.checked.join(', ')}`,
    '',
    'Not covered by this measurement:',
    ...report.notCovered.map((n) => `- ${n}`),
  );
  return `${lines.join('\n')}\n`;
}
