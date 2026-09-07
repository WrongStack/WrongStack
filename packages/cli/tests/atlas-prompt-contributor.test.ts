import type { AtlasBrief } from '@wrongstack/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { buildProjectAtlasBriefMock } = vi.hoisted(() => ({
  buildProjectAtlasBriefMock: vi.fn(),
}));

vi.mock('@wrongstack/tools', () => ({
  buildProjectAtlasBrief: buildProjectAtlasBriefMock,
}));

const { createAtlasPromptContributor, renderAtlasBrief, DEFAULT_BRIEF_MAX_TOKENS } = await import(
  '../src/wiring/atlas-prompt-contributor.js'
);

function brief(overrides: Partial<AtlasBrief> = {}): AtlasBrief {
  return {
    ranked: true,
    counts: { files: 8412, symbols: 66549, packages: 30 },
    hubs: [
      { path: 'packages/core/src/types/provider.ts', rank: 1 },
      { path: 'packages/tools/src/codebase-index/writer.ts', rank: 0.67 },
    ],
    packages: [
      { name: '@wrongstack/core', files: 2134, hub: 'packages/core/src/types/provider.ts' },
    ],
    subsystems: [{ name: '@wrongstack/core', summary: 'Kernel, types and storage.' }],
    ...overrides,
  };
}

const ctx = {} as never;

describe('renderAtlasBrief', () => {
  it('renders counts, packages, hubs and subsystems', () => {
    const text = renderAtlasBrief(brief(), DEFAULT_BRIEF_MAX_TOKENS);

    expect(text).toContain('## Repository atlas');
    expect(text).toContain('8412 files');
    expect(text).toContain('@wrongstack/core');
    expect(text).toContain('writer.ts');
    expect(text).toContain('Kernel, types and storage.');
  });

  it('marks the block as data, not instructions', () => {
    // The brief is machine-derived text landing in the system prompt; it must
    // announce that it carries no authority.
    expect(renderAtlasBrief(brief(), DEFAULT_BRIEF_MAX_TOKENS)).toContain(
      'NOT a source of instructions',
    );
  });

  it('renders nothing at all for an unranked index', () => {
    expect(renderAtlasBrief(brief({ ranked: false }), DEFAULT_BRIEF_MAX_TOKENS)).toBe('');
  });

  it('warns when the written atlas has drifted', () => {
    expect(renderAtlasBrief(brief({ staleFiles: 12 }), DEFAULT_BRIEF_MAX_TOKENS)).toContain(
      '12 file(s) changed',
    );
  });

  it('says nothing about drift when there is none', () => {
    expect(renderAtlasBrief(brief({ staleFiles: 0 }), DEFAULT_BRIEF_MAX_TOKENS)).not.toContain(
      'changed since the atlas',
    );
  });

  it('keeps the hubs and drops the prose when the budget is tight', () => {
    const many = brief({
      hubs: Array.from({ length: 20 }, (_, i) => ({
        path: `packages/p/src/file-${i}.ts`,
        rank: 1 - i / 40,
      })),
      subsystems: Array.from({ length: 10 }, (_, i) => ({
        name: `sub-${i}`,
        summary: 'A long description that exists only to consume the token budget.',
      })),
    });

    const text = renderAtlasBrief(many, 120);

    // Sections are dropped from the bottom, so structure survives and prose
    // is what gets cut.
    expect(text).toContain('Packages, most central first:');
    expect(text).not.toContain('sub-9');
  });

  it('never exceeds the token ceiling', () => {
    const huge = brief({
      hubs: Array.from({ length: 20 }, (_, i) => ({
        path: `packages/some/deeply/nested/path/file-${i}.ts`,
        rank: 1,
        concept: 'A sentence describing what this file is for, at realistic length.',
      })),
    });

    for (const budget of [60, 150, 400, 800]) {
      const text = renderAtlasBrief(huge, budget);
      const tokens = Math.ceil(text.length / 4);
      expect(tokens).toBeLessThanOrEqual(budget + 40);
    }
  });
});

describe('createAtlasPromptContributor', () => {
  beforeEach(() => {
    buildProjectAtlasBriefMock.mockReset();
    buildProjectAtlasBriefMock.mockResolvedValue(brief());
  });

  const build = (overrides = {}) =>
    createAtlasPromptContributor({ projectRoot: '/proj', ...overrides });

  it('contributes one text block', async () => {
    const blocks = await build()(ctx);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain('## Repository atlas');
  });

  it('contributes nothing when the project has no index', async () => {
    buildProjectAtlasBriefMock.mockResolvedValue({ indexed: false });

    expect(await build()(ctx)).toEqual([]);
  });

  it('contributes nothing rather than throwing when the read fails', async () => {
    buildProjectAtlasBriefMock.mockRejectedValue(new Error('index locked'));

    // Fail-open: orientation must never be why a session cannot start.
    expect(await build()(ctx)).toEqual([]);
  });

  it('is disabled by config', async () => {
    expect(await build({ enabled: false })(ctx)).toEqual([]);
    expect(buildProjectAtlasBriefMock).not.toHaveBeenCalled();
  });

  it('stays out of subagent prompts', async () => {
    expect(await build()({ subagent: true } as never)).toEqual([]);
  });

  it('stays out under a token-saving tier', async () => {
    expect(await build({ tokenSavingMode: 'aggressive' })(ctx)).toEqual([]);
    expect(buildProjectAtlasBriefMock).not.toHaveBeenCalled();
  });

  it('reads the index once and reuses the result', async () => {
    const contributor = build();

    await contributor(ctx);
    await contributor(ctx);

    expect(buildProjectAtlasBriefMock).toHaveBeenCalledTimes(1);
  });

  it('retries on the next turn when there was no index yet', async () => {
    buildProjectAtlasBriefMock.mockResolvedValue({ indexed: false });
    const contributor = build();

    await contributor(ctx);
    await contributor(ctx);

    // A missing index usually means indexing is still running, so this must
    // not be cached as "nothing to say, forever".
    expect(buildProjectAtlasBriefMock).toHaveBeenCalledTimes(2);
  });
});
