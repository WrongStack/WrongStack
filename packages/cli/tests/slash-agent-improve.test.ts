import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  listProjectSkillAugmentations,
  loadConsolidationMetadata,
  loadProjectSkillAugmentation,
  resetCaptureWindows,
} from '@wrongstack/core/agent-catalog';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { Provider, Request, Response } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAgentImproveCommand } from '../src/slash-commands/agent-improve.js';

let projectRoot: string;
let written: string[];

/** Minimal SlashCommandContext: renderer sink + project root + optional model. */
function makeOpts(llm?: { provider: Provider; model: string }, lastAgentOutput?: string) {
  return {
    projectRoot,
    renderer: {
      write: (text: string) => written.push(text),
      writeInfo: (text: string) => written.push(text),
      writeWarning: (text: string) => written.push(text),
      writeError: (text: string) => written.push(text),
    },
    ...(lastAgentOutput !== undefined
      ? { context: { meta: { lastAgentOutput } } }
      : { context: { meta: {} } }),
    ...(llm ? { llmProvider: llm.provider, llmModel: llm.model } : {}),
  } as never;
}

function stubLlm(reply: string, onCall?: (req: Request) => void) {
  return {
    model: 'stub-model',
    provider: {
      capabilities: {},
      async complete(req: Request): Promise<Response> {
        onCall?.(req);
        return { content: [{ type: 'text', text: reply }] } as unknown as Response;
      },
    } as unknown as Provider,
  };
}

function dispatcher(opts: ReturnType<typeof makeOpts>) {
  const reg = new SlashCommandRegistry();
  reg.register(buildAgentImproveCommand(opts));
  return (line: string) => reg.dispatch(line, {} as never);
}

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), 'ws-agent-improve-'));
  written = [];
  resetCaptureWindows();
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  resetCaptureWindows();
});

describe('/agent-improve capture', () => {
  it('persists a tagged LEARNED block from the last turn and reports the routed skill', async () => {
    const run = dispatcher(
      makeOpts(
        undefined,
        '## LEARNED [skill: testing]\nAlways run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.',
      ),
    );
    const res = await run('/agent-improve verifier capture');
    expect(res?.message).toContain('Captured 1 learned item(s)');
    expect(res?.message).toContain('Routed to skill(s): testing');
  });

  it('explains itself instead of reporting "no blocks" when no turn has run yet', async () => {
    // The command used to read a `lastAgentOutput` key nothing ever wrote, so
    // it could only ever answer "no ## LEARNED blocks found" — indistinguishable
    // from a real miss.
    const res = await dispatcher(makeOpts())('/agent-improve verifier capture');
    expect(res?.message).toContain('No agent output recorded yet');
  });

  it('surfaces the quality-gate reason when a block is rejected', async () => {
    const run = dispatcher(makeOpts(undefined, '## LEARNED\nWhen I worked on this today.'));
    const res = await run('/agent-improve verifier capture');
    expect(res?.message).toMatch(/directives, not session logs|no_blocks|quality/i);
  });
});

describe('/agent-improve optimize', () => {
  async function seed(role: string, text: string, skill?: string) {
    const heading = skill ? `## LEARNED [skill: ${skill}]` : '## LEARNED';
    await dispatcher(makeOpts(undefined, `${heading}\n${text}`))(`/agent-improve ${role} capture`);
  }

  it('writes the skill addendum, the consolidated doc and prunes the buffer', async () => {
    await seed(
      'verifier',
      'Always run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.',
      'testing',
    );
    const systems: string[] = [];
    const run = dispatcher(
      makeOpts(
        stubLlm('# Consolidated\n\n- Verify from the repo root.', (req) => {
          systems.push(req.system?.[0]?.text ?? '');
        }),
      ),
    );
    const res = await run('/agent-improve verifier optimize');

    expect(res?.message).toContain('Optimized "verifier"');
    expect(res?.message).toContain('Skill addenda refreshed: testing');
    expect(res?.message).toContain('Raw buffer archived and reset');
    // One synthesis for the skill addendum, one for the role document.
    expect(systems).toHaveLength(2);
    expect(listProjectSkillAugmentations('verifier', projectRoot)).toEqual(['testing']);
    const meta = loadConsolidationMetadata('verifier', projectRoot);
    expect(meta?.pruned).toBe(true);
    expect(readFileSync(meta?.archivePath ?? '', 'utf8')).toContain('vitest run');
  });

  it('`consolidate` remains an alias for `optimize`', async () => {
    await seed(
      'executor',
      'Always rebase onto the latest main before opening a pull request.',
      'git-flow',
    );
    const res = await dispatcher(makeOpts(stubLlm('# Consolidated')))(
      '/agent-improve executor consolidate',
    );
    expect(res?.message).toContain('Optimized "executor"');
  });

  it('still develops the skill layer with no model configured', async () => {
    await seed(
      'executor',
      'Always rebase onto the latest main before opening a pull request.',
      'git-flow',
    );
    const res = await dispatcher(makeOpts())('/agent-improve executor optimize');
    // Falls back to routing the role document through the chat agent…
    expect(res?.message).toContain('No active model');
    expect(res?.runText).toContain('rebase onto the latest main');
    // …but the addendum is written regardless, rather than being stranded.
    expect(loadProjectSkillAugmentation('executor', 'git-flow', projectRoot)).toContain(
      'rebase onto the latest main',
    );
  });

  it('reports a clean no-op for a role with nothing to optimize', async () => {
    const res = await dispatcher(makeOpts(stubLlm('unused')))('/agent-improve verifier optimize');
    expect(res?.message).toContain('No raw learned entries');
  });
});

describe('/agent-improve skills', () => {
  it('lists candidates with affinity and marks the developed ones', async () => {
    await dispatcher(
      makeOpts(
        undefined,
        '## LEARNED [skill: testing]\nAlways run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.',
      ),
    )('/agent-improve verifier capture');

    const res = await dispatcher(makeOpts())('/agent-improve verifier skills');
    expect(res?.message).toContain('testing');
    expect(res?.message).toContain('1 learned');
    // Curated siblings are listed too, as unused candidates.
    expect(res?.message).toContain('security-scanner');
  });

  it('prints one skill addendum and reports an absent one plainly', async () => {
    const run = dispatcher(makeOpts());
    expect((await run('/agent-improve verifier skills testing'))?.message).toContain(
      'No project addendum for skill "testing"',
    );
  });

  it('pins and unpins a skill', async () => {
    const run = dispatcher(makeOpts());
    expect((await run('/agent-improve verifier skills testing pin'))?.message).toContain(
      'Pinned skill "testing"',
    );
    expect((await run('/agent-improve verifier skills testing unpin'))?.message).toContain(
      'Unpinned skill "testing"',
    );
    expect((await run('/agent-improve verifier skills testing bogus'))?.message).toContain(
      'Unknown skill action',
    );
  });
});

describe('/agent-improve routing', () => {
  it('rejects an unknown action with the current action list', async () => {
    const res = await dispatcher(makeOpts())('/agent-improve verifier frobnicate');
    expect(res?.message).toContain('Unknown action "frobnicate"');
    expect(res?.message).toContain('optimize');
    expect(res?.message).toContain('skills');
  });

  it('shows developed skills in the per-role summary', async () => {
    await dispatcher(
      makeOpts(
        undefined,
        '## LEARNED [skill: testing]\nAlways run `pnpm vitest run` from the repository root; a package-local run resolves the wrong config.',
      ),
    )('/agent-improve verifier capture');
    await dispatcher(makeOpts(stubLlm('# Consolidated')))('/agent-improve verifier optimize');

    const res = await dispatcher(makeOpts())('/agent-improve verifier show');
    expect(res?.message).toContain('skills developed: testing');
  });
});
