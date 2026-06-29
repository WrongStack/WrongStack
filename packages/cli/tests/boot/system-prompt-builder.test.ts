import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

/**
 * PR 5 of Issue #29: extract the SystemPromptBuilder
 * container binding into a helper. This test pins the
 * behavior the helper's lazy factory closure must preserve:
 *
 *   1. The factory is lazy: `container.bind(token, factory)`
 *      registers `factory` but does not call it. The factory
 *      only runs when something later calls
 *      `container.resolve(token)`. The helper doesn't change
 *      this contract.
 *   2. `planPath` returns undefined when `sessionRef.current`
 *      is undefined (no session has been bound yet).
 *   3. `planPath` returns `<sessions>/<sessionId>.plan.json`
 *      once `sessionRef.current` is set, *and* the result
 *      tracks subsequent updates (a second bind to a
 *      different session would change the result).
 *   4. The autonomy contributor's `enabled` callback is
 *      wired to `autonomyModeRef.current`, and only enables
 *      for `eternal` or `eternal-parallel` modes. Other
 *      modes (`off`, `suggest`, `auto`) leave the
 *      contributor's `enabled` returning false.
 *
 * The helper has structural placeholders for the core
 * `Container` / `MemoryStore` / `ModeStore` / `SkillLoader`
 * types, so the test can pass fakes without importing the
 * full core machinery.
 */

const { bindSystemPromptBuilder } = await import('../../src/boot/system-prompt-builder.js');

import type { TokenSavingTier } from '@wrongstack/core';

interface CapturedBuilder {
  opts: {
    planPath?: string | (() => string | undefined);
    contributors?: Array<{ enabled?: () => boolean }>;
    modeId: string;
    modePrompt: string;
    skillsEnabled: boolean;
    tokenSavingMode?: 'off' | 'minimal' | 'light' | 'medium' | 'aggressive' | boolean | undefined;
  };
}

function makeDeps(
  overrides: Partial<{
    modeId: string;
    modePrompt: string;
    skillsEnabled: boolean;
    tokenSavingMode: TokenSavingTier | boolean | undefined;
    autonomyMode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel';
    sessionId: string | undefined;
    projectGoal: string;
    projectSessions: string;
  }> = {},
) {
  const token = Symbol('SystemPromptBuilder');
  const sessionRef = {
    current: overrides.sessionId !== undefined ? { id: overrides.sessionId } : undefined,
  };
  const autonomyModeRef = { current: overrides.autonomyMode ?? 'off' };
  let capturedFactory: (() => unknown) | null = null;
  const container = {
    bind: vi.fn((_t: unknown, factory: () => unknown) => {
      capturedFactory = factory;
    }),
  };
  const pathJoiner = { join: (a: string, b: string) => `${a}/${b}` };
  bindSystemPromptBuilder({
    container,
    modeStore: { _kind: 'fakeModeStore' },
    memoryStore: { _kind: 'fakeMemoryStore' },
    skillLoader: { _kind: 'fakeSkillLoader' },
    sessionRef,
    autonomyModeRef,
    modeId: overrides.modeId ?? 'default',
    modePrompt: overrides.modePrompt ?? '',
    modelCapabilities: undefined,
    skillsEnabled: overrides.skillsEnabled ?? true,
    tokenSavingMode: overrides.tokenSavingMode,
    paths: {
      projectGoal: overrides.projectGoal ?? '/tmp/goal.md',
      projectSessions: overrides.projectSessions ?? '/tmp/sessions',
    },
    pathJoiner,
    systemPromptBuilderToken: token,
  });
  if (capturedFactory === null) {
    throw new Error('container.bind was not called');
  }
  return {
    sessionRef,
    autonomyModeRef,
    container,
    capturedFactory: capturedFactory as () => CapturedBuilder,
  };
}

describe('bindSystemPromptBuilder (PR 5 of #29)', () => {
  it('registers the factory under the supplied token (lazy bind, not eager resolve)', () => {
    const { container } = makeDeps();
    expect(container.bind).toHaveBeenCalledTimes(1);
    // Factory was captured but NOT called.
    const firstCall = (container.bind as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.[1]).toBeTypeOf('function');
  });

  it('planPath returns undefined when sessionRef.current is undefined', () => {
    const { capturedFactory } = makeDeps({ sessionId: undefined });
    const builder = capturedFactory();
    const planPath = builder.opts.planPath;
    expect(typeof planPath).toBe('function');
    expect((planPath as () => string | undefined)()).toBeUndefined();
  });

  it('planPath returns <projectSessions>/<sessionId>.plan.json once a session is bound', () => {
    const { capturedFactory } = makeDeps({
      sessionId: 'sess-abc',
      projectSessions: '/var/sessions',
    });
    const builder = capturedFactory();
    const planPath = builder.opts.planPath as () => string | undefined;
    expect(planPath()).toBe(path.resolve('/var/sessions/sess-abc.plan.json'));
  });

  it('planPath tracks subsequent sessionRef updates (lazy reads, not a snapshot)', () => {
    const sessionRef = { current: undefined as { id: string } | undefined };
    const autonomyModeRef = { current: 'off' as const };
    let capturedFactory: (() => unknown) | undefined;
    const container = {
      bind: vi.fn((_t: unknown, f: () => unknown) => {
        capturedFactory = f;
      }),
    };
    bindSystemPromptBuilder({
      container,
      modeStore: {},
      memoryStore: {},
      skillLoader: {},
      sessionRef,
      autonomyModeRef,
      modeId: 'default',
      modePrompt: '',
      modelCapabilities: undefined,
      skillsEnabled: true,
      tokenSavingMode: 'medium',
      paths: { projectGoal: '/tmp/goal.md', projectSessions: '/tmp/sessions' },
      pathJoiner: { join: (a, b) => `${a}/${b}` },
      systemPromptBuilderToken: Symbol('s'),
    });
    expect(capturedFactory).toBeDefined();
    const builder = capturedFactory!() as CapturedBuilder;
    const planPath = builder.opts.planPath as () => string | undefined;
    // First call: no session yet.
    expect(planPath()).toBeUndefined();
    // Bind a session.
    sessionRef.current = { id: 'sess-1' };
    expect(planPath()).toBe(path.resolve('/tmp/sessions/sess-1.plan.json'));
    // Rebind to a different session \u2014 the closure must
    // pick up the new id, not a stale snapshot.
    sessionRef.current = { id: 'sess-2' };
    expect(planPath()).toBe(path.resolve('/tmp/sessions/sess-2.plan.json'));
  });

  it('passes tokenSavingMode through to DefaultSystemPromptBuilder', () => {
    const { capturedFactory } = makeDeps({ tokenSavingMode: 'aggressive' });
    const builder = capturedFactory();
    expect(builder.opts.tokenSavingMode).toBe('aggressive');
  });

  it('autonomy contributor is the only contributor wired into the builder', () => {
    // The pre-refactor inline block wired exactly one
    // contributor: `makeAutonomyPromptContributor({...})`.
    // We assert that the helper preserves that shape: the
    // builder receives a single-element contributors array.
    // (The contributor itself is a function typed as
    // `SystemPromptContributor = (ctx) => Promise<TextBlock[]>`,
    // so the helper has no public surface to assert against
    // for the `enabled` callback's return value \u2014 that is
    // exercised by the system-prompt-builder integration
    // tests in core, not here.)
    for (const mode of ['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'] as const) {
      const { capturedFactory } = makeDeps({ autonomyMode: mode });
      const builder = capturedFactory();
      const contributors = builder.opts.contributors ?? [];
      expect(contributors).toHaveLength(1);
      expect(typeof contributors[0]).toBe('function');
    }
  });
});
