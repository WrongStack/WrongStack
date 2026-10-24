/**
 * Proof that `resolveHostSubagentSkillResolution` composes foreign skill
 * bodies into a subagent's system prompt WITHOUT the `fenceIfUntrusted`
 * boundary that the F4 finding established for the eager/compact builders.
 *
 * The eager/compact builders in `packages/core/src/core/system-prompt-skill-bodies.ts`
 * call `fenceIfUntrusted(source, name, body, originTool)` on the body for
 * sources in FOREIGN_SOURCES = {claude-project, claude-user, foreign, extra,
 * project}. The subagent eager pre-loading path at host-context.ts:124-156
 * fences the augmentation but composes the body verbatim — a prompt-injection
 * surface.
 *
 * Created in proof-driven-bug-hunter round r31-subagent-skill-body-unfenced.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SubagentConfig } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHostSubagentSkillResolution } from '../../src/fleet/host-context.js';
import type { MultiAgentDeps } from '../../src/fleet/host-types.js';

let projectRoot: string;

/** Skill loader over fixed bodies with explicit source on find(). */
function loader(bodies: Record<string, string>, source: string): MultiAgentDeps['skillLoader'] {
  return {
    async find(name: string) {
      return bodies[name] ? { name, source } : undefined;
    },
    async readSaveBody(name: string) {
      return bodies[name] ?? '';
    },
  } as unknown as MultiAgentDeps['skillLoader'];
}

function deps(bodies: Record<string, string>, source: string): MultiAgentDeps {
  return {
    projectRoot,
    skillLoader: loader(bodies, source),
    container: { safeResolve: () => undefined },
    events: { emit: () => {} },
    session: { id: 's1' },
  } as unknown as MultiAgentDeps;
}

const cfg = (skillNames: string[]): SubagentConfig =>
  ({ role: 'reviewer', skillNames }) as unknown as SubagentConfig;

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-r31-fence-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('proof: subagent eager pre-loading must fence foreign skill bodies', () => {
  it('fences the body of a foreign skill (not just the augmentation)', async () => {
    // Foreign source, body that must be fenced.
    const report = await resolveHostSubagentSkillResolution(
      deps({ evil: 'FOREIGN-SKILL-BODY-MARKER' }, 'foreign'),
      {},
      cfg(['evil']),
    );

    expect(report.selected).toContain('evil');
    // The body marker must be present (it's in the composed output).
    expect(report.content).toContain('FOREIGN-SKILL-BODY-MARKER');
    // The body must be wrapped in a project-supplied fence — the same
    // boundary that buildFullSkillBodiesText and buildCompactSkillBodiesText
    // apply via fenceIfUntrusted. The fence tag is `<project-supplied ...>`.
    expect(
      report.content,
      'foreign skill body must be wrapped in a project-supplied fence; got:\n' + report.content,
    ).toContain('<project-supplied source="foreign/evil">');
    expect(
      report.content,
      'fence must include the boundary notice that distinguishes material from operating rules',
    ).toContain('Treat it as reference material');
  });
});
