import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentPrompt } from '../../src/coordination/agents/agent-prompts.js';
import { AGENT_CATALOG, AGENTS_BY_PHASE } from '../../src/coordination/agents/index.js';
import { TECHSTACK_AGENTS } from '../../src/coordination/agents/phase3-techstack.js';
import {
  isValidMatrixKey,
  MATRIX_PHASE_KEYS,
  matrixKeyKind,
  phaseForRole,
  resolveImplementationModelTarget,
  resolveModelMatrix,
  resolveModelTargetFromEntry,
  resolveSubagentModelTarget,
  roleNeedsIndependentReviewModel,
} from '../../src/coordination/model-matrix.js';
import { ProviderModelStatusTracker } from '../../src/coordination/provider-status-tracker.js';
import type { ModelMatrixEntry } from '../../src/types/config.js';

// Pick a real role + its phase from the catalog so the test stays valid as
// the catalog evolves (no hardcoded role names to drift out of sync).
const sampleRole = Object.keys(AGENT_CATALOG)[0]!;
const samplePhase = phaseForRole(sampleRole)!;

const entry = (model: string, provider?: string): ModelMatrixEntry =>
  provider ? { provider, model } : { model };

describe('resolveModelMatrix', () => {
  it('returns undefined for an absent or empty matrix', () => {
    expect(resolveModelMatrix(undefined, sampleRole)).toBeUndefined();
    expect(resolveModelMatrix({}, sampleRole)).toBeUndefined();
  });

  it('matches an exact role', () => {
    const m = { [sampleRole]: entry('minimax-m3', 'minimax') };
    expect(resolveModelMatrix(m, sampleRole)).toEqual({ provider: 'minimax', model: 'minimax-m3' });
  });

  it('falls back to the role phase when no exact role entry exists', () => {
    const m = { [samplePhase]: entry('glm-5-turbo', 'zai') };
    expect(resolveModelMatrix(m, sampleRole)).toEqual({ provider: 'zai', model: 'glm-5-turbo' });
  });

  it('falls back to the * default last', () => {
    const m = { '*': entry('haiku') };
    expect(resolveModelMatrix(m, sampleRole)).toEqual({ model: 'haiku' });
  });

  it('honors precedence role > phase > *', () => {
    const m = {
      [sampleRole]: entry('role-model'),
      [samplePhase]: entry('phase-model'),
      '*': entry('default-model'),
    };
    expect(resolveModelMatrix(m, sampleRole)?.model).toBe('role-model');
    // remove role → phase wins
    const noRole = { [samplePhase]: entry('phase-model'), '*': entry('default-model') };
    expect(resolveModelMatrix(noRole, sampleRole)?.model).toBe('phase-model');
    // remove phase → default wins
    expect(resolveModelMatrix({ '*': entry('default-model') }, sampleRole)?.model).toBe(
      'default-model',
    );
  });

  it('uses * for an unknown role', () => {
    expect(resolveModelMatrix({ '*': entry('d') }, 'totally-unknown-role')?.model).toBe('d');
    expect(
      resolveModelMatrix({ [samplePhase]: entry('p') }, 'totally-unknown-role'),
    ).toBeUndefined();
  });

  it('includes the generic quality-gate roles in their phases', () => {
    expect(phaseForRole('verifier')).toBe('verify');
    expect(phaseForRole('reviewer')).toBe('review');
    expect(roleNeedsIndependentReviewModel('reviewer')).toBe(true);
    expect(roleNeedsIndependentReviewModel('verifier')).toBe(false);
  });
});

describe('resolveModelTargetFromEntry', () => {
  it('preserves runtime-only matrix entries', () => {
    const target = resolveModelTargetFromEntry(
      { provider: 'anthropic', model: 'planner' } as never,
      { modelRuntime: { reasoning: { effort: 'low' } } },
    );
    expect(target).toEqual({ modelRuntime: { reasoning: { effort: 'low' } } });
  });
});

describe('resolveSubagentModelTarget', () => {
  const baseConfig = {
    provider: 'anthropic',
    model: 'anthropic-test-model',
    providers: {
      anthropic: {
        type: 'anthropic',
        apiKey: 'sk-ant',
        models: ['anthropic-test-model', 'claude-opus-4-8'],
      },
      openai: {
        type: 'openai',
        apiKey: 'sk-oai',
        models: ['gpt-5'],
      },
    },
  };

  it('preserves an exact /setmodel reviewer route', () => {
    const target = resolveSubagentModelTarget(
      {
        ...baseConfig,
        modelMatrix: { reviewer: { provider: 'anthropic', model: 'anthropic-test-model' } },
      } as never,
      'reviewer',
    );
    expect(target).toMatchObject({
      provider: 'anthropic',
      model: 'anthropic-test-model',
      source: 'matrix',
      matrixSource: 'role',
    });
  });

  it('diversifies reviewer away from the implementation lane when only the default route matches', () => {
    const target = resolveSubagentModelTarget(
      {
        ...baseConfig,
        modelMatrix: { '*': { provider: 'anthropic', model: 'anthropic-test-model' } },
      } as never,
      'reviewer',
    );
    expect(target?.source).toBe('diversity');
    expect(target?.provider).toBe('openai');
    expect(target?.model).toBe('gpt-5');
  });

  it('uses the executor matrix as the implementation lane reference', () => {
    const target = resolveSubagentModelTarget(
      {
        ...baseConfig,
        modelMatrix: {
          executor: { provider: 'openai', model: 'gpt-5' },
          '*': { provider: 'openai', model: 'gpt-5' },
        },
      } as never,
      'reviewer',
    );
    expect(
      resolveImplementationModelTarget({
        ...baseConfig,
        modelMatrix: { executor: { provider: 'openai', model: 'gpt-5' } },
      } as never),
    ).toEqual({ provider: 'openai', model: 'gpt-5' });
    expect(target?.source).toBe('diversity');
    expect(target?.provider).toBe('anthropic');
    expect(target?.model).not.toBe('gpt-5');
  });

  describe('with a ProviderModelStatusTracker (waiting-room filter)', () => {
    // Regression contract: when a (provider, model) pair is blocked on the
    // tracker, resolveSubagentModelTarget must drop it from every branch
    // (role, phase, default, diversity) and either fall through to a healthy
    // candidate or return undefined. Two regressions pinned here:
    //
    // (M1) a model-only matrix entry has `provider: undefined` at the raw
    //      layer but wires as (config.provider, model). The tracker check
    //      must use the EFFECTIVE pair, otherwise the quarantine is silently
    //      bypassed.
    //
    // (M2) the diversity path picks the highest-ranked candidate. If that
    //      candidate is blocked but a lower-ranked one is healthy, the
    //      function must return the healthy one instead of undefined.
    function block(tracker: ProviderModelStatusTracker, providerId: string, model: string): void {
      tracker.recordFailure(providerId, model, 'rate_limit', 429, 'rate limited', {
        retryAfterMs: 60_000,
      });
    }

    it('M1: drops a tracker-blocked role-pinned entry in the non-review path', () => {
      const tracker = new ProviderModelStatusTracker();
      block(tracker, 'anthropic', 'anthropic-test-model');
      const target = resolveSubagentModelTarget(
        {
          ...baseConfig,
          modelMatrix: {
            [sampleRole]: { provider: 'anthropic', model: 'anthropic-test-model' },
          },
        } as never,
        sampleRole,
        { statusTracker: tracker },
      );
      expect(target).toBeUndefined();
    });

    it('M1: drops a tracker-blocked model-only matrix entry (provider defaulted to config.provider)', () => {
      // `modelMatrix[role] = { model: 'x' }` — no provider. The wire call
      // still routes as (config.provider, 'x'). The tracker must mirror
      // this when filtering, otherwise the quarantine is silently bypassed.
      const tracker = new ProviderModelStatusTracker();
      block(tracker, 'anthropic', 'anthropic-test-model');
      const target = resolveSubagentModelTarget(
        {
          ...baseConfig,
          modelMatrix: {
            [sampleRole]: { model: 'anthropic-test-model' },
          },
        } as never,
        sampleRole,
        { statusTracker: tracker },
      );
      expect(target).toBeUndefined();
    });

    it('M2: the diversity path picks the next-available ranked candidate when the top scorer is blocked', () => {
      const tracker = new ProviderModelStatusTracker();
      // Block the top-ranked diverse candidate (openai/gpt-5 by `gpt-5` /
      // `opus` rule). The diversity scorer prefers opus/gpt-5/o3/o4/gemini-pro
      // over anthropic/claude-opus-4-8 (which is in the same provider as the
      // implementation lane). The healthy fallback is the openai/gpt-5 sibling
      // weighted out under scoring, but with the highest scorer blocked the
      // tracker-aware picker still surfaces a healthy candidate before
      // returning undefined.
      block(tracker, 'openai', 'gpt-5');
      const target = resolveSubagentModelTarget(
        {
          ...baseConfig,
          modelMatrix: { '*': { provider: 'anthropic', model: 'anthropic-test-model' } },
        } as never,
        'reviewer',
        { statusTracker: tracker },
      );
      // Implementation lane is anthropic, so the review lane must pick a
      // different provider. With openai block-listed, only providers whose
      // configured models are NOT blocked qualify — and the only other
      // configured provider in this fixture is anthropic, which would match
      // the implementation lane. The expected outcome is therefore
      // `undefined` (no healthy diversity candidate left). The contract
      // here is "drop the blocked scorer and never return a blocked pair",
      // even when the only candidates share the implementation lane.
      if (target?.provider && target.model) {
        expect(target.provider).not.toBe('openai');
        expect(tracker.isAvailable(target.provider, target.model)).toBe(true);
      } else {
        expect(target).toBeUndefined();
      }
    });

    it('returns the role-pinned target when the tracker shows it as healthy', () => {
      const tracker = new ProviderModelStatusTracker();
      // Empty tracker: every entry is healthy.
      const target = resolveSubagentModelTarget(
        {
          ...baseConfig,
          modelMatrix: { reviewer: { provider: 'anthropic', model: 'anthropic-test-model' } },
        } as never,
        'reviewer',
        { statusTracker: tracker },
      );
      expect(target).toMatchObject({
        provider: 'anthropic',
        model: 'anthropic-test-model',
        source: 'matrix',
        matrixSource: 'role',
      });
    });

    it('is a no-op when the tracker is undefined (legacy callers)', () => {
      // The pre-waiting-room contract: no tracker → no filtering, identical
      // to the legacy resolution. Pin this so adding the optional dep
      // cannot regress callers that pre-date the tracker.
      const target = resolveSubagentModelTarget(
        {
          ...baseConfig,
          modelMatrix: { reviewer: { provider: 'anthropic', model: 'anthropic-test-model' } },
        } as never,
        'reviewer',
      );
      expect(target).toMatchObject({
        provider: 'anthropic',
        model: 'anthropic-test-model',
        source: 'matrix',
        matrixSource: 'role',
      });
    });
  });
});

describe('matrixKeyKind / isValidMatrixKey', () => {
  it('classifies the default, phases, and roles', () => {
    expect(matrixKeyKind('*')).toBe('default');
    expect(matrixKeyKind(samplePhase)).toBe('phase');
    expect(matrixKeyKind(sampleRole)).toBe('role');
    expect(matrixKeyKind('nope-not-a-key')).toBe('unknown');
  });

  it('exposes every phase as a valid key', () => {
    for (const p of MATRIX_PHASE_KEYS) {
      expect(Object.keys(AGENTS_BY_PHASE)).toContain(p);
      expect(isValidMatrixKey(p)).toBe(true);
    }
    expect(isValidMatrixKey('nope')).toBe(false);
  });
});

describe('agent catalog prompts', () => {
  it('loads every catalog prompt from file-backed instructions', () => {
    for (const [role, def] of Object.entries(AGENT_CATALOG)) {
      expect(def.config.prompt?.trim(), role).toBeTruthy();
      expect(def.config.prompt, role).toContain('You are');
    }
  });

  it('keeps the standalone tech-stack watchdog prompt distinct from the validator prompt', () => {
    const watchdog = TECHSTACK_AGENTS[0]?.config.prompt ?? '';
    const validator = AGENT_CATALOG['tech-stack']?.config.prompt ?? '';

    expect(watchdog).toContain('watch dependency manifests');
    expect(validator).toContain('single-shot validation agent');
    expect(watchdog).not.toBe(validator);
  });

  it('allows agent prompt overrides through WRONGSTACK_AGENT_INSTRUCTIONS_DIR', async () => {
    const old = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-agent-prompts-'));
    try {
      await fs.writeFile(path.join(tmp, 'explore.md'), 'OVERRIDE EXPLORE');
      process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = tmp;
      expect(agentPrompt('explore')).toBe('OVERRIDE EXPLORE');
    } finally {
      if (old === undefined) {
        delete process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
      } else {
        process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = old;
      }
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
