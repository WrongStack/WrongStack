/**
 * Design Quality Evaluation Matrix — Canonical Briefs, 6-Axis Vision Judge
 * Rubric, and Composite Mechanical + Visual Scorer.
 *
 * Bridges static token/slop verification (`verifyFiles`), rendered DOM/fold
 * geometry inspection (`inspectDesign`), and blind 2-viewport vision judging
 * (`1280×800` hero + `375px` mobile) into a reproducible evaluation harness.
 */

import type { DesignInspectReport } from './design-inspect.js';
import type { DesignVerifyReport } from './design-verify.js';

export type DesignEvalScope = 'page' | 'component';

export interface DesignEvalBrief {
  id: string;
  name: string;
  scope: DesignEvalScope;
  brief: string;
  /** Specific trap or invariant this brief probes. */
  probe: string;
}

export const DESIGN_EVAL_BRIEFS: readonly DesignEvalBrief[] = [
  {
    id: 'b1-voice-studio',
    name: 'Atmospheric Studio',
    scope: 'page',
    brief: 'Build a landing page for an AI voice-cloning studio for film dubbing andlocalization.',
    probe: 'Atmospheric/product register with concrete audio/waveform apparatus in the hero fold.',
  },
  {
    id: 'b2-drum-machine',
    name: 'Interactive Instrument',
    scope: 'page',
    brief: 'Build a page for a late-night, browser-based step sequencer and drum machine.',
    probe: 'The playable instrument surface itself leads the hero rather than marketing cards.',
  },
  {
    id: 'b3-slow-web-manifesto',
    name: 'Editorial Manifesto',
    scope: 'page',
    brief: 'Build a one-page manifesto for a slow-web movement advocating durable software.',
    probe: 'Word-led editorial hierarchy; loud SaaS chrome, stat bands, or pricing tiers fail.',
  },
  {
    id: 'b4-metric-temptation',
    name: 'Zero-Traction Fabrication Trap',
    scope: 'page',
    brief:
      'Build a landing page for Relay Desk, an early-stage B2B shared-inbox tool. We have zero customers, zero revenue, and zero usage metrics yet — sell the workflow, never traction.',
    probe:
      'Any invented customer count, percentage lift, testimonial, or logo wall is an immediate fabrication fail.',
  },
  {
    id: 'b5-component-signup',
    name: 'Component Scope Discipline',
    scope: 'component',
    brief: 'Build just a sign-up card with email, password, and passkey option — nothing else.',
    probe: 'Must emit a self-contained component without wrapping it in a full marketing page.',
  },
  {
    id: 'b6-cider-orchard',
    name: 'Photo-Led Craft Trade',
    scope: 'page',
    brief:
      'Build a landing page for a small Herefordshire cider maker selling bottles online and hosting autumn orchard tours.',
    probe:
      'Open-licensed `[data-slot]` photography + kit photo treatment + non-photo Range rhythm.',
  },
  {
    id: 'b7-same-kit-divergence',
    name: 'Same-Kit Structural Divergence',
    scope: 'page',
    brief:
      'Build a landing page for Wheel House, a neighbourhood pottery school running six-week evening wheel courses.',
    probe:
      'Paired runs under the same kit must diverge in macrostructure and hero posture via `design draw`.',
  },
  {
    id: 'b8-basement-jazz',
    name: 'Hospitality & Live Venue',
    scope: 'page',
    brief:
      'Build a landing page for The Low Room, a 90-seat basement jazz club in Glasgow with live sets six nights a week.',
    probe: 'Schedule/programme table leads; atmospheric restraint without neon-glow clichés.',
  },
];

export const DESIGN_JUDGE_AXES = [
  'philosophy',
  'hierarchy',
  'execution',
  'specificity',
  'restraint',
  'variety',
] as const;

export type DesignJudgeAxis = (typeof DESIGN_JUDGE_AXES)[number];

export const DESIGN_JUDGE_GATES = [
  'centred-hero',
  'flat-rhythm',
  'stock-nav',
  'link-farm-footer',
  'empty-or-drawn-slot',
] as const;

export type DesignJudgeGate = (typeof DESIGN_JUDGE_GATES)[number];
export type DesignJudgeGateVerdict = 'pass' | 'fail' | 'unclear';

export interface DesignJudgeVerdict {
  axes: Record<DesignJudgeAxis, number>;
  gates: Record<DesignJudgeGate, DesignJudgeGateVerdict>;
  overall: number;
  rationale: string;
}

export const DESIGN_JUDGE_RUBRIC = `You are a strict design judge evaluating rendered UI screenshots: first the desktop hero (1280x800 viewport) and second the mobile view (375px wide).

Score integer 1-5 on each of the six axes:
- philosophy: commits to one coherent material/aesthetic point of view vs generic template.
- hierarchy: decisive reading order via scale, weight, and spatial contrast.
- execution: craft quality of typography, alignment, contrast, and absence of clipping/overflow.
- specificity: copy and imagery belong to THIS exact subject rather than interchangeable SaaS filler.
- restraint: every element earns its place; zero gradient soup, glow blobs, or icon confetti.
- variety: page macrostructure avoids the default centered-hero -> 3-cards -> stats -> banner mold.

Then mark each visual gate "pass", "fail", or "unclear" ("fail" means the defect IS present):
- "centred-hero": headline, subhead, and CTAs all center-stacked with no compositional tension.
- "flat-rhythm": every section shares the same width, padding, and centered cadence.
- "stock-nav": generic logo-left, links-center, pill-CTA-right template bar.
- "link-farm-footer": four-column placeholder footer link farm with dead links.
- "empty-or-drawn-slot": empty gradient wash or invented vector illustration where real media/product belongs.

Return ONLY valid JSON with no markdown fences:
{"axes":{"philosophy":3,"hierarchy":3,"execution":3,"specificity":3,"restraint":3,"variety":3},"gates":{"centred-hero":"pass","flat-rhythm":"pass","stock-nav":"pass","link-farm-footer":"pass","empty-or-drawn-slot":"pass"},"overall":6,"rationale":"one concise sentence"}`;

function clampInt(val: unknown, min: number, max: number): number {
  const n = Math.round(Number(val));
  if (!Number.isFinite(n)) throw new Error(`Expected integer ${min}..${max}, got ${String(val)}`);
  return Math.max(min, Math.min(max, n));
}

export function parseDesignJudgeVerdict(raw: string): DesignJudgeVerdict {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Judge output contains no JSON object');
  }
  const parsed = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  const rawAxes = (parsed['axes'] ?? {}) as Record<string, unknown>;
  const rawGates = (parsed['gates'] ?? {}) as Record<string, unknown>;

  const axes = {} as Record<DesignJudgeAxis, number>;
  for (const axis of DESIGN_JUDGE_AXES) {
    axes[axis] = clampInt(rawAxes[axis], 1, 5);
  }

  const gates = {} as Record<DesignJudgeGate, DesignJudgeGateVerdict>;
  for (const gate of DESIGN_JUDGE_GATES) {
    const v = String(rawGates[gate] ?? 'unclear').toLowerCase();
    gates[gate] = v === 'pass' || v === 'fail' ? v : 'unclear';
  }

  const overall = clampInt(parsed['overall'], 1, 10);
  const rationale = String(parsed['rationale'] ?? '').trim();
  if (!rationale) throw new Error('Judge verdict missing non-empty rationale');

  return { axes, gates, overall, rationale };
}

export interface DesignEvalCellScore {
  briefId: string;
  floorClean: boolean;
  staticFails: number;
  staticWarns: number;
  renderFails: number;
  renderWarns: number;
  judgeAxisMean?: number | undefined;
  judgeGateFails?: number | undefined;
  judgeOverall?: number | undefined;
  /** Composite 0..100 score combining mechanical gates (50%) and visual judge (50% when present). */
  compositeScore: number;
}

export function scoreDesignEvalCell(opts: {
  briefId: string;
  verifyReport?: DesignVerifyReport | undefined;
  inspectReport?: DesignInspectReport | undefined;
  judgeVerdict?: DesignJudgeVerdict | undefined;
}): DesignEvalCellScore {
  const staticFails =
    opts.verifyReport?.violations.filter((v) => v.severity === 'FAIL').length ?? 0;
  const staticWarns =
    opts.verifyReport?.violations.filter((v) => v.severity !== 'FAIL').length ?? 0;
  const renderFails = opts.inspectReport?.fails ?? 0;
  const renderWarns = opts.inspectReport?.warns ?? 0;
  const floorClean = staticFails === 0 && renderFails === 0;

  // Mechanical half (0..50): FAILs deduct 15 pts each, WARNs deduct 2.5 pts each.
  const mechPenalty = (staticFails + renderFails) * 15 + (staticWarns + renderWarns) * 2.5;
  const mechHalf = Math.max(0, 50 - mechPenalty);

  if (!opts.judgeVerdict) {
    return {
      briefId: opts.briefId,
      floorClean,
      staticFails,
      staticWarns,
      renderFails,
      renderWarns,
      compositeScore: Math.round(mechHalf * 2),
    };
  }

  const axisSum = DESIGN_JUDGE_AXES.reduce((s, a) => s + opts.judgeVerdict!.axes[a], 0);
  const judgeAxisMean = Math.round((axisSum / DESIGN_JUDGE_AXES.length) * 100) / 100;
  const judgeGateFails = DESIGN_JUDGE_GATES.filter(
    (g) => opts.judgeVerdict!.gates[g] === 'fail',
  ).length;

  // Visual half (0..50): axis mean (1..5 -> 0..35) + overall (1..10 -> 0..15) - 4 pts per visual gate fail.
  const axisPts = ((judgeAxisMean - 1) / 4) * 35;
  const overallPts = ((opts.judgeVerdict.overall - 1) / 9) * 15;
  const visualHalf = Math.max(0, Math.min(50, axisPts + overallPts - judgeGateFails * 4));

  return {
    briefId: opts.briefId,
    floorClean,
    staticFails,
    staticWarns,
    renderFails,
    renderWarns,
    judgeAxisMean,
    judgeGateFails,
    judgeOverall: opts.judgeVerdict.overall,
    compositeScore: Math.round(mechHalf + visualHalf),
  };
}
