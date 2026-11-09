/**
 * Design DNA — fidelity comparison, token mapping and the markdown record.
 *
 * `compareDesignDna` scores how closely an implementation's measured DNA
 * matches a reference's, axis by axis, with explicit tolerances. The overall
 * score is the LOWEST axis (as in design-critique), because a perfect palette
 * does not compensate for the wrong type scale.
 *
 * `dnaToTokenOverrides` maps a reference onto Design Studio's token names so
 * `design {action:"set"}` can carry it into materialize/verify; color roles
 * are scoped to the reference's own theme instead of stomping both.
 */

import { type DesignDna, type DnaLayout, deltaE, hexToOklchString } from './design-dna.js';

export type DnaAxis = 'color' | 'type' | 'space' | 'shape' | 'layout' | 'motion';

export interface DnaFinding {
  axis: DnaAxis;
  /** `match` within tolerance, `near` within twice it, `off` beyond. */
  status: 'match' | 'near' | 'off' | 'missing';
  what: string;
  reference: string;
  implementation: string;
}

export interface DnaComparison {
  /** 0..1 per axis; absent when the reference measured nothing on that axis. */
  axes: Partial<Record<DnaAxis, number>>;
  overall: number;
  weakest: DnaAxis | null;
  findings: DnaFinding[];
  viewports: number[];
}

/** Tolerances. Documented in design-to-code so the model sees the same numbers. */
export const DNA_TOLERANCE = {
  /** OKLab ΔE: ≤ 0.02 is about one just-noticeable difference. */
  color: 0.02,
  /** px for type sizes and spacing values. */
  px: 1,
  /** relative tolerance for container widths and section rhythm. */
  relative: 0.04,
  /** ratio of type scale steps. */
  ratio: 0.04,
  /** relative tolerance for motion duration. */
  duration: 0.25,
} as const;

const normFamily = (f: string | undefined): string =>
  (f ?? '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/\s*(variable|var|vf)$/, '')
    .trim();

function grade(diff: number, tol: number): 'match' | 'near' | 'off' {
  return diff <= tol ? 'match' : diff <= tol * 2 ? 'near' : 'off';
}

const weight = { match: 1, near: 0.5, off: 0, missing: 0 } as const;

function fmt(n: number | null | undefined, unit = ''): string {
  return n === null || n === undefined ? '—' : `${Math.round(n * 100) / 100}${unit}`;
}

function nearestDiff(value: number, pool: number[]): number {
  return pool.reduce((best, v) => Math.min(best, Math.abs(v - value)), Number.POSITIVE_INFINITY);
}

export function compareDesignDna(ref: DesignDna, impl: DesignDna): DnaComparison {
  const findings: DnaFinding[] = [];
  const push = (f: DnaFinding): void => {
    findings.push(f);
  };

  // color — each role the reference has
  for (const [role, refHex] of Object.entries(ref.color.roles)) {
    if (!refHex) continue;
    const implHex = impl.color.roles[role as keyof typeof impl.color.roles];
    if (!implHex) {
      push({
        axis: 'color',
        status: 'missing',
        what: `role ${role}`,
        reference: refHex,
        implementation: '—',
      });
      continue;
    }
    const d = deltaE(refHex, implHex);
    push({
      axis: 'color',
      status: grade(d, DNA_TOLERANCE.color),
      what: `role ${role} (ΔE ${d.toFixed(3)})`,
      reference: refHex,
      implementation: implHex,
    });
  }
  if (ref.theme !== impl.theme)
    push({
      axis: 'color',
      status: 'off',
      what: 'theme',
      reference: ref.theme,
      implementation: impl.theme,
    });

  // type
  for (const role of ['text', 'display', 'mono'] as const) {
    if (!ref.type[role]) continue;
    const same = normFamily(ref.type[role]) === normFamily(impl.type[role]);
    push({
      axis: 'type',
      status: impl.type[role] ? (same ? 'match' : 'off') : 'missing',
      what: `${role} family`,
      reference: ref.type[role] ?? '—',
      implementation: impl.type[role] ?? '—',
    });
  }
  if (ref.type.base) {
    const b = impl.type.base;
    push({
      axis: 'type',
      status: b ? grade(Math.abs(b.size - ref.type.base.size), DNA_TOLERANCE.px * 0.5) : 'missing',
      what: 'body size',
      reference: fmt(ref.type.base.size, 'px'),
      implementation: fmt(b?.size, 'px'),
    });
    push({
      axis: 'type',
      status: b ? grade(Math.abs(b.lineHeight - ref.type.base.lineHeight), 0.05) : 'missing',
      what: 'body line-height',
      reference: fmt(ref.type.base.lineHeight),
      implementation: fmt(b?.lineHeight),
    });
  }
  if (ref.type.ratio !== null)
    push({
      axis: 'type',
      status:
        impl.type.ratio === null
          ? 'missing'
          : grade(Math.abs(impl.type.ratio - ref.type.ratio), DNA_TOLERANCE.ratio),
      what: 'scale ratio',
      reference: fmt(ref.type.ratio),
      implementation: fmt(impl.type.ratio),
    });
  const refLargest = ref.type.scale[ref.type.scale.length - 1];
  if (refLargest !== undefined)
    push({
      axis: 'type',
      status: impl.type.scale.length
        ? refLargest === 0
          ? nearestDiff(0, impl.type.scale) === 0
            ? 'match'
            : 'off'
          : grade(nearestDiff(refLargest, impl.type.scale) / refLargest, DNA_TOLERANCE.relative)
        : 'missing',
      what: 'largest display size',
      reference: fmt(refLargest, 'px'),
      implementation: fmt(impl.type.scale[impl.type.scale.length - 1], 'px'),
    });

  // space
  if (ref.space.unit !== null)
    push({
      axis: 'space',
      status: impl.space.unit === ref.space.unit ? 'match' : 'off',
      what: 'spacing unit',
      reference: fmt(ref.space.unit, 'px'),
      implementation: fmt(impl.space.unit, 'px'),
    });
  if (ref.space.scale.length) {
    const hit = ref.space.scale.filter(
      (v) => nearestDiff(v, impl.space.scale) <= DNA_TOLERANCE.px,
    ).length;
    const share = hit / ref.space.scale.length;
    push({
      axis: 'space',
      status: share >= 0.75 ? 'match' : share >= 0.5 ? 'near' : 'off',
      what: `spacing values shared (${hit}/${ref.space.scale.length})`,
      reference: ref.space.scale.join(' '),
      implementation: impl.space.scale.join(' '),
    });
  }
  if (ref.space.sectionPadY !== null)
    push({
      axis: 'space',
      status:
        impl.space.sectionPadY === null
          ? 'missing'
          : ref.space.sectionPadY === 0
            ? impl.space.sectionPadY === 0
              ? 'match'
              : 'off'
            : grade(
                Math.abs(impl.space.sectionPadY - ref.space.sectionPadY) / ref.space.sectionPadY,
                0.15,
              ),
      what: 'section vertical padding',
      reference: fmt(ref.space.sectionPadY, 'px'),
      implementation: fmt(impl.space.sectionPadY, 'px'),
    });

  // shape
  if (ref.shape.radius !== null) {
    const r = impl.shape.radius;
    const status =
      r === null
        ? 'missing'
        : ref.shape.radius === 'full' || r === 'full'
          ? ref.shape.radius === r
            ? 'match'
            : 'off'
          : grade(Math.abs(r - ref.shape.radius), DNA_TOLERANCE.px);
    push({
      axis: 'shape',
      status,
      what: 'dominant radius',
      reference: String(ref.shape.radius),
      implementation: String(r ?? '—'),
    });
  }
  push({
    axis: 'shape',
    status: ref.shape.shadowStyle === impl.shape.shadowStyle ? 'match' : 'off',
    what: 'elevation style',
    reference: ref.shape.shadowStyle,
    implementation: impl.shape.shadowStyle,
  });
  if (ref.components.button) {
    const b = impl.components.button;
    push({
      axis: 'shape',
      status: b ? grade(Math.abs(b.h - ref.components.button.h), 2) : 'missing',
      what: 'primary button height',
      reference: fmt(ref.components.button.h, 'px'),
      implementation: fmt(b?.h, 'px'),
    });
  }

  // layout — per shared viewport
  const viewports = ref.layout
    .map((l) => l.width)
    .filter((w) => impl.layout.some((l) => l.width === w));
  for (const width of viewports) {
    const a = ref.layout.find((l) => l.width === width) as DnaLayout;
    const b = impl.layout.find((l) => l.width === width) as DnaLayout;
    if (a.container > 0)
      push({
        axis: 'layout',
        status: b.container
          ? grade(Math.abs(b.container - a.container) / a.container, DNA_TOLERANCE.relative)
          : 'missing',
        what: `container @${width}`,
        reference: fmt(a.container, 'px'),
        implementation: fmt(b.container, 'px'),
      });
    push({
      axis: 'layout',
      status:
        a.maxGridCols === b.maxGridCols
          ? 'match'
          : Math.abs(a.maxGridCols - b.maxGridCols) === 1
            ? 'near'
            : 'off',
      what: `widest grid columns @${width}`,
      reference: String(a.maxGridCols),
      implementation: String(b.maxGridCols),
    });
    const diff = Math.abs(a.sections.length - b.sections.length);
    push({
      axis: 'layout',
      status: diff === 0 ? 'match' : diff <= 1 ? 'near' : 'off',
      what: `section count @${width}`,
      reference: String(a.sections.length),
      implementation: String(b.sections.length),
    });
    if (a.nav)
      push({
        axis: 'layout',
        status: b.nav ? (a.nav.pos === b.nav.pos ? 'match' : 'off') : 'missing',
        what: `nav position @${width}`,
        reference: a.nav.pos,
        implementation: b.nav?.pos ?? '—',
      });
  }

  // motion
  if (ref.motion.duration !== null)
    push({
      axis: 'motion',
      status:
        impl.motion.duration === null
          ? 'missing'
          : ref.motion.duration === 0
            ? impl.motion.duration === 0
              ? 'match'
              : 'off'
            : grade(
                Math.abs(impl.motion.duration - ref.motion.duration) / ref.motion.duration,
                DNA_TOLERANCE.duration,
              ),
      what: 'dominant transition duration',
      reference: fmt(ref.motion.duration, 'ms'),
      implementation: fmt(impl.motion.duration, 'ms'),
    });
  if (ref.motion.easing)
    push({
      axis: 'motion',
      status:
        impl.motion.easing === ref.motion.easing ? 'match' : impl.motion.easing ? 'off' : 'missing',
      what: 'dominant easing',
      reference: ref.motion.easing,
      implementation: impl.motion.easing ?? '—',
    });

  const axes: Partial<Record<DnaAxis, number>> = {};
  for (const axis of ['color', 'type', 'space', 'shape', 'layout', 'motion'] as const) {
    const own = findings.filter((f) => f.axis === axis);
    if (own.length)
      axes[axis] =
        Math.round((own.reduce((s, f) => s + weight[f.status], 0) / own.length) * 100) / 100;
  }
  let weakest: DnaAxis | null = null;
  for (const [axis, score] of Object.entries(axes) as Array<[DnaAxis, number]>)
    if (weakest === null || score < (axes[weakest] ?? 1)) weakest = axis;
  return { axes, overall: weakest ? (axes[weakest] ?? 0) : 0, weakest, findings, viewports };
}

/**
 * Design Studio token overrides derived from a reference. Color roles are
 * scoped to the reference's theme (`light.` / `dark.`); scale tokens apply to
 * both. Fonts carry a generic fallback so a missing licence degrades safely.
 */
export function dnaToTokenOverrides(dna: DesignDna): Record<string, string> {
  const out: Record<string, string> = {};
  const scope = `${dna.theme}.`;
  for (const [role, hex] of Object.entries(dna.color.roles)) {
    const oklch = hex ? hexToOklchString(hex) : null;
    if (oklch) out[`${scope}${role}`] = oklch;
  }
  const primaryOklch = out[`${scope}primary`];
  if (primaryOklch) out[`${scope}ring`] = primaryOklch;
  const font = (name: string | undefined, fallback: string): string | undefined =>
    name ? `${/\s/.test(name) ? `"${name}"` : name}, ${fallback}` : undefined;
  const sans = font(dna.type.text, 'system-ui, sans-serif');
  const display = font(dna.type.display, 'system-ui, sans-serif');
  const mono = font(dna.type.mono, 'ui-monospace, monospace');
  if (sans) out['font-sans'] = sans;
  if (display) out['font-display'] = display;
  if (mono) out['font-mono'] = mono;
  if (dna.type.base) out['text-base'] = `${dna.type.base.size / 16}rem`;
  const radii = dna.shape.radiusScale;
  if (dna.shape.radius === 0) {
    for (const k of ['radius-sm', 'radius-md', 'radius-lg', 'radius-xl']) out[k] = '0';
  } else if (typeof dna.shape.radius === 'number') {
    const md = dna.shape.radius;
    // Neighbours count only when they are a real step (4 → 4.5 is noise).
    const below = radii.filter((r) => r > 0 && r <= md * 0.8);
    out['radius-sm'] = `${below[below.length - 1] ?? Math.round(md / 2)}px`;
    out['radius-md'] = `${md}px`;
    out['radius-lg'] = `${radii.find((r) => r >= md * 1.25) ?? Math.round(md * 1.5)}px`;
  }
  if (dna.motion.duration !== null) out['duration-base'] = `${dna.motion.duration}ms`;
  if (dna.motion.easing && dna.motion.easing !== 'ease') out['ease-standard'] = dna.motion.easing;
  return out;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** The `.design/references/<slug>/dna.md` record a later turn can read. */
export function renderDesignDnaMarkdown(dna: DesignDna): string {
  const r = dna.color.roles;
  const lines = [
    `# Design DNA — ${dna.source.title || dna.source.url}`,
    '',
    `Source: ${dna.source.url} · measured ${dna.source.capturedAt} · viewports ${dna.source.viewports.join(', ')}px`,
    'Measured = read from the rendered page. Inferred = derived from those measurements (marked).',
    '',
    '## Color',
    `Theme (inferred): ${dna.theme}. Roles (inferred): ${Object.entries(r)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')}`,
    `Visible area (measured): ${dna.color.area
      .slice(0, 8)
      .map((c) => `${c.hex} ${pct(c.share)}`)
      .join(' · ')}`,
    `Text colors (measured, by characters): ${dna.color.text
      .slice(0, 6)
      .map((c) => `${c.hex} ${pct(c.share)}`)
      .join(' · ')}`,
    `Media ${pct(dna.color.mediaShare)} · gradient ${pct(dna.color.gradientShare)} · chromatic ${pct(dna.color.chromaticShare)} of sampled area`,
    '',
    '## Type',
    `Families: text ${dna.type.text ?? '—'} · display ${dna.type.display ?? '—'} · mono ${dna.type.mono ?? '—'} (loaded: ${dna.type.loaded.join(', ') || 'none seen'})`,
    `Body (measured): ${dna.type.base ? `${dna.type.base.size}px / ${dna.type.base.weight} / line-height ${dna.type.base.lineHeight}` : '—'}`,
    `Sizes in use (measured): ${dna.type.scale.join(', ')}px · ratio (inferred) ${fmt(dna.type.ratio)} · heading weight ${fmt(dna.type.headingWeight)} · display tracking ${fmt(dna.type.displayTracking, 'em')} · uppercase ${pct(dna.type.uppercaseShare)}`,
    '',
    '## Space and shape',
    `Spacing unit (inferred): ${fmt(dna.space.unit, 'px')} (fits ${pct(dna.space.unitFit)}) · common values ${dna.space.scale.join(' ')} · section padding ${fmt(dna.space.sectionPadY, 'px')}`,
    `Radius: dominant ${dna.shape.radius ?? '—'} · scale ${dna.shape.radiusScale.join(' ')} · pill share ${pct(dna.shape.pillShare)} · border ${fmt(dna.shape.borderWidth, 'px')}`,
    `Elevation: ${dna.shape.shadowStyle}${dna.shape.shadowSamples.length ? ` — e.g. \`${dna.shape.shadowSamples[0]}\`` : ''}`,
    dna.components.button
      ? `Primary button: ${dna.components.button.h}px high · padding-x ${dna.components.button.padX}px · radius ${dna.components.button.radius} · ${dna.components.button.size}px/${dna.components.button.weight}${dna.components.button.transform !== 'none' ? ` · ${dna.components.button.transform}` : ''}`
      : 'Primary button: none measured',
    '',
    '## Motion',
    `Dominant ${fmt(dna.motion.duration, 'ms')} · durations ${dna.motion.durations.join(', ')}ms · easing ${dna.motion.easing ?? '—'} · running animations ${dna.motion.animated}`,
    '',
    '## Layout',
    ...dna.layout.map(
      (l) =>
        `@${l.width}px: container ${l.container || '—'}px · ${l.sections.length} sections · widest grid ${l.maxGridCols} cols · nav ${l.nav ? `${l.nav.h}px ${l.nav.pos}${l.nav.backdrop ? ' +blur' : ''}` : '—'} · page ${l.docHeight}px\n` +
        `  rhythm: ${l.sections
          .slice(0, 16)
          .map((s) => `${s.h}${s.cols > 1 ? `×${s.cols}c` : ''}${s.media ? `[${s.media}]` : ''}`)
          .join(' → ')}`,
    ),
    '',
    `## Signals (inferred)\n${dna.signals.join(', ') || 'none'}`,
  ];
  const tokens = Object.entries(dna.declaredTokens);
  if (tokens.length)
    lines.push(
      '',
      '## Declared tokens (measured, :root custom properties)',
      tokens
        .slice(0, 40)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · '),
    );
  if (dna.notes.length)
    lines.push('', '## Limits of this measurement', ...dna.notes.map((n) => `- ${n}`));
  return `${lines.join('\n')}\n`;
}

export function renderDnaComparisonMarkdown(
  cmp: DnaComparison,
  refLabel: string,
  implLabel: string,
): string {
  const axisLine = Object.entries(cmp.axes)
    .map(([axis, score]) => `${axis} ${pct(score ?? 0)}`)
    .join(' · ');
  const misses = cmp.findings.filter((f) => f.status !== 'match');
  return [
    `# Fidelity — ${implLabel} vs ${refLabel}`,
    `Overall ${pct(cmp.overall)} (lowest axis: ${cmp.weakest ?? '—'}) · ${axisLine}`,
    `Viewports compared: ${cmp.viewports.join(', ') || 'none shared'}`,
    '',
    misses.length
      ? '| axis | status | what | reference | implementation |\n|---|---|---|---|---|'
      : 'Every measured property is within tolerance.',
    ...misses.map(
      (f) => `| ${f.axis} | ${f.status} | ${f.what} | ${f.reference} | ${f.implementation} |`,
    ),
    '',
    `Matched within tolerance: ${cmp.findings.length - misses.length}/${cmp.findings.length}. Fix the lowest axis first; a measured match is not a visual review — compare the screenshots too.`,
  ].join('\n');
}
