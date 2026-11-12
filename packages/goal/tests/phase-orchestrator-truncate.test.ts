/**
 * Surrogate-safe truncation of untrusted Goal verification text.
 *
 * Goal caps two pieces of checker output — `truncate()` for the failure
 * message/event, `recordVerification` for the persisted attempt — and both
 * cuts fall on the cap boundary, which is where an astral character straddling
 * it would otherwise leave an unpaired surrogate. The convention is the one
 * already pinned for the planner's repair source (`goal-planner.test.ts`,
 * "never splits a surrogate pair when capping the repair source").
 */
import { describe, expect, it } from 'vitest';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { runPhaseVerifyGate } from '../src/phase-orchestrator-gates.js';
import type { IntegrationContext } from '../src/phase-orchestrator-integration.js';
import { truncate } from '../src/phase-orchestrator-queries.js';
import type { PhaseGraph, PhaseNode } from '../src/types.js';

/** A lone high OR low surrogate anywhere: ill-formed UTF-16, `\udXXX` on the wire. */
const LONE_SURROGATE = /(?:[\ud800-\udbff](?![\udc00-\udfff]))|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** `filler` + an astral char, positioned so the cap lands inside the pair. */
function straddling(cap: number, filler = 'x'): string {
  return filler.repeat(cap - 1) + '\u{1F600}' + filler.repeat(cap);
}

describe('truncate() — surrogate-safe head cut', () => {
  it('never emits a lone surrogate when the cap straddles an astral char', () => {
    const source = straddling(500);
    const out = truncate(source, 500);
    expect(LONE_SURROGATE.test(out), 'truncated text carries an ill-formed lone surrogate').toBe(
      false,
    );
    // The cap bounds the KEPT SOURCE; the "(+N chars)" notice is additional and
    // sat past `max` before the fix too, so it is not part of this contract.
    const kept = out.slice(0, out.lastIndexOf('…'));
    expect(kept.length).toBeLessThanOrEqual(500);
    // The straddling code point is dropped whole, not left as half a pair.
    expect(kept).toBe('x'.repeat(499));
    // Dropped: the whole straddling pair (2 units) + the 500 trailing x's.
    expect(out).toContain('(+502 chars)');
  });

  it('control: BMP-only text still truncates at the cap and says how much it dropped', () => {
    const source = 'a'.repeat(1200);
    const out = truncate(source, 500);
    expect(out.startsWith('a'.repeat(500))).toBe(true);
    expect(out).toContain('(+700 chars)');
  });

  it('control: text within the cap is returned unchanged', () => {
    const source = `short \u{1F600} text`;
    expect(truncate(source, 500)).toBe(source);
  });
});

describe('runPhaseVerifyGate() — surrogate-safe tail cut', () => {
  const phase = (): PhaseNode => ({
    id: 'p1',
    name: 'Verify',
    description: '',
    dependsOn: [],
    priority: 'medium',
    parallelizable: false,
    estimatedHours: 1,
    status: 'running',
    taskGraph: { nodes: new Map(), edges: [] },
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
  });

  const context = (output: string): IntegrationContext =>
    ({
      graph: { id: 'g1', phases: new Map(), status: 'running' } as unknown as PhaseGraph,
      ctx: { verifyPhase: async () => ({ ok: false, output }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      worktrees: undefined,
      phaseWorktrees: new Map(),
      phaseMergePromise: new Map(),
      runningPhases: new Map(),
      getMergeQueue: () => Promise.resolve(),
      setMergeQueue: () => {},
      emit: () => {},
      updatePhaseStatus: () => {},
    }) as unknown as IntegrationContext;

  const recordedOutput = (node: PhaseNode): string => {
    const attempts = (node.metadata?.['verificationAttempts'] ?? []) as Array<{ output?: string }>;
    return attempts.at(-1)?.output ?? '';
  };

  it('records the tail without splitting the astral char at the 4000 boundary', async () => {
    const node = phase();
    // High surrogate sits exactly at index length - 4000, so the tail cut opens
    // on the orphaned low half.
    const output = 'y'.repeat(2001) + '\u{1F600}' + 'z'.repeat(3999);
    const verdict = await runPhaseVerifyGate(context(output), node, 0, () => false);
    expect(verdict.ok).toBe(false);

    const kept = recordedOutput(node);
    // Sanity: the gate really recorded a capped tail, so a red below cannot be a
    // fixture mistake (a shape error here would surface as an empty string).
    expect(kept.length).toBeLessThanOrEqual(4000);
    expect(kept.length).toBeGreaterThan(3900);
    expect(LONE_SURROGATE.test(kept), 'recorded verifier output is ill-formed UTF-16').toBe(false);
  });

  it('control: a short verdict is recorded verbatim, and a long BMP tail still caps', async () => {
    const short = phase();
    await runPhaseVerifyGate(context('plain failure'), short, 0, () => false);
    expect(recordedOutput(short)).toBe('plain failure');

    const long = phase();
    const output = 'w'.repeat(9000);
    await runPhaseVerifyGate(context(output), long, 0, () => false);
    expect(recordedOutput(long)).toBe(output.slice(-4000));
  });
});

/**
 * The phase NAME cap is the same rule at a third writer, and the one with the
 * sharpest edge: the name is persisted in the saved graph and reused as the
 * worktree `ownerLabel`/branch slug, so an unpaired surrogate would reach git.
 */
describe('PhaseGraphBuilder phase-name cap — surrogate-safe', () => {
  const graphWith = (title: string) => ({
    id: 'dag',
    specId: 'spec',
    title: 'Titles',
    nodes: new Map([
      [
        't1',
        {
          id: 't1',
          title,
          description: 'd',
          type: 'feature' as const,
          priority: 'medium' as const,
          status: 'pending' as const,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    ]),
    edges: [],
    rootNodes: ['t1'],
    createdAt: 0,
    updatedAt: 0,
  });

  const firstPhaseName = async (title: string): Promise<string> => {
    const graph = await PhaseGraphBuilder.fromTaskGraph(graphWith(title) as never, {
      title: 'Truncation',
      tasksPerPhase: 5,
    });
    return Array.from(graph.phases.values())[0]?.name ?? '';
  };

  it('never puts a lone surrogate into a generated phase name', async () => {
    // High surrogate lands exactly on the last kept unit of the 30-char cap.
    const name = await firstPhaseName(`${'x'.repeat(29)}\u{1F600} tail`);
    expect(name.length).toBeGreaterThan('Phase 1: '.length);
    expect(LONE_SURROGATE.test(name), `phase name is ill-formed UTF-16: ${name}`).toBe(false);
    expect(name).toBe(`Phase 1: ${'x'.repeat(29)}`);
  });

  it('control: an ordinary BMP title is still capped at 30 units', async () => {
    expect(await firstPhaseName('a'.repeat(80))).toBe(`Phase 1: ${'a'.repeat(30)}`);
  });
});
