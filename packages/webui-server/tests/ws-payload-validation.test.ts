import { describe, expect, it } from 'vitest';
import {
  validateAutonomySwitchPayload,
  validateBrainAskPayload,
  validateBrainConfigSetPayload,
  validateBrainRiskPayload,
  validateContextModeCreatePayload,
  validateContextModeDeletePayload,
  validateContextModeSwitchPayload,
  validateContextModeUpdatePayload,
  validateGitDiffPayload,
  validateMailboxAgentsPayload,
  validateMailboxMessagesPayload,
  validateMailboxPurgePayload,
  validateMailboxSendPayload,
  validateModelSwitchPayload,
  validateModeSwitchPayload,
  validatePlanTemplateUsePayload,
  validatePrefsUpdatePayload,
  validateProcessKillPayload,
  validateProjectsAddPayload,
  validateProjectsSelectPayload,
  validateShellOpenPayload,
  validateSkillsCreatePayload,
  validateSkillsEditPayload,
  validateWorkingDirSetPayload,
} from '../src/server/ws-payload-validation.js';

type ValidationResult = { ok: boolean };
type Validator = (payload: unknown) => ValidationResult;

function expectInvalid(validator: Validator, payloads: readonly unknown[]): void {
  for (const payload of payloads) {
    expect(validator(payload)).toMatchObject({ ok: false });
  }
}

describe('WebUI payload validation', () => {
  describe('small command payloads', () => {
    const cases: Array<{
      name: string;
      validator: Validator;
      valid: unknown;
      invalid: readonly unknown[];
    }> = [
      {
        name: 'model.switch',
        validator: validateModelSwitchPayload,
        valid: { provider: 'openai', model: 'gpt-5' },
        invalid: [null, [], {}, { provider: '', model: 'gpt-5' }, { provider: 'openai', model: 1 }],
      },
      {
        name: 'brain.risk',
        validator: validateBrainRiskPayload,
        valid: { level: 'medium' },
        invalid: [null, { level: 'extreme' }, { level: 1 }],
      },
      {
        name: 'brain.ask',
        validator: validateBrainAskPayload,
        valid: { question: '  continue?  ' },
        invalid: [null, {}, { question: '' }, { question: 1 }],
      },
      {
        name: 'brain.config.set',
        validator: validateBrainConfigSetPayload,
        valid: { patch: { mode: 'headless' } },
        invalid: [null, {}, { patch: 'headless' }, { patch: 3 }, { patch: null }],
      },
      {
        name: 'autonomy.switch',
        validator: validateAutonomySwitchPayload,
        valid: { mode: 'eternal-parallel' },
        invalid: [null, { mode: 'forever' }, { mode: 1 }],
      },
      {
        name: 'plan.template_use',
        validator: validatePlanTemplateUsePayload,
        valid: { template: 'release' },
        invalid: [null, { template: '' }, { template: 1 }],
      },
      {
        name: 'skills.edit',
        validator: validateSkillsEditPayload,
        valid: { name: 'review', body: '# Review' },
        invalid: [
          null,
          { name: '', body: 'x' },
          { name: 'review', body: '' },
          { name: 'review', body: 1 },
        ],
      },
      {
        name: 'process.kill',
        validator: validateProcessKillPayload,
        valid: { pid: 42 },
        invalid: [null, { pid: 0 }, { pid: 1.5 }, { pid: '42' }],
      },
      {
        name: 'working_dir.set',
        validator: validateWorkingDirSetPayload,
        valid: { path: '/workspace' },
        invalid: [null, { path: '' }, { path: 1 }],
      },
      {
        name: 'mode.switch',
        validator: validateModeSwitchPayload,
        valid: { id: 'deep' },
        invalid: [null, { id: '' }, { id: 1 }],
      },
      {
        name: 'context.mode.switch',
        validator: validateContextModeSwitchPayload,
        valid: { id: 'deep' },
        invalid: [null, { id: '' }, { id: 1 }],
      },
      {
        name: 'context.mode.delete',
        validator: validateContextModeDeletePayload,
        valid: { id: 'custom' },
        invalid: [null, { id: '' }, { id: 1 }],
      },
    ];

    it.each(cases)(
      'accepts valid and rejects invalid $name payloads',
      ({ validator, valid, invalid }) => {
        expect(validator(valid)).toMatchObject({ ok: true });
        expectInvalid(validator, invalid);
      },
    );

    it('normalizes the brain question while preserving other valid values', () => {
      expect(validateBrainAskPayload({ question: '  continue?  ' })).toEqual({
        ok: true,
        value: { question: 'continue?' },
      });
      expect(validateModelSwitchPayload({ provider: 'openai', model: 'gpt-5' })).toEqual({
        ok: true,
        value: { provider: 'openai', model: 'gpt-5' },
      });
      expect(
        validateModelSwitchPayload({
          provider: ' openai ',
          model: ' gpt-5 ',
          requestId: ' req-1 ',
        }),
      ).toEqual({
        ok: true,
        value: { provider: 'openai', model: 'gpt-5', requestId: 'req-1' },
      });
    });
  });

  describe('optional mailbox payloads', () => {
    it('validates mailbox sends and normalizes broadcast recipients', () => {
      expect(
        validateMailboxSendPayload({
          requestId: 'req-1',
          to: 'leader',
          type: 'result',
          audience: 'leaders',
          subject: 'Done',
          body: 'Evidence',
          priority: 'normal',
        }),
      ).toEqual({
        ok: true,
        value: {
          requestId: 'req-1',
          to: 'leader',
          type: 'result',
          audience: 'leaders',
          subject: 'Done',
          body: 'Evidence',
          priority: 'normal',
        },
      });
      expect(
        validateMailboxSendPayload({
          requestId: 'req-2',
          to: 'ignored',
          type: 'broadcast',
          audience: 'all',
          subject: 'Status',
          body: 'Milestone',
          priority: 'low',
        }),
      ).toMatchObject({ ok: true, value: { to: '*' } });
    });

    it('rejects malformed, control, and ambiguous mailbox sends', () => {
      const base = {
        requestId: 'req',
        to: 'leader',
        type: 'note',
        audience: 'all',
        subject: 'Subject',
        body: 'Body',
        priority: 'normal',
      };
      expectInvalid(validateMailboxSendPayload, [
        undefined,
        { ...base, requestId: '' },
        { ...base, to: '' },
        { ...base, type: 'control' },
        { ...base, audience: 'workers' },
        { ...base, subject: '' },
        { ...base, body: '' },
        { ...base, priority: 'urgent' },
        { ...base, type: 'steer', to: '*' },
      ]);
    });

    it('accepts omitted and fully populated mailbox message filters', () => {
      expect(validateMailboxMessagesPayload(undefined)).toEqual({ ok: true, value: undefined });
      expect(
        validateMailboxMessagesPayload({
          limit: 25,
          agentId: 'leader',
          unreadOnly: true,
          incompleteOnly: false,
        }),
      ).toEqual({
        ok: true,
        value: { limit: 25, agentId: 'leader', unreadOnly: true, incompleteOnly: false },
      });
      expect(validateMailboxMessagesPayload({})).toEqual({ ok: true, value: {} });
    });

    it('rejects each malformed mailbox message filter', () => {
      expectInvalid(validateMailboxMessagesPayload, [
        null,
        [],
        { limit: 0 },
        { limit: Number.NaN },
        { limit: '1' },
        { agentId: 1 },
        { unreadOnly: 1 },
        { incompleteOnly: 1 },
      ]);
    });

    it('validates mailbox agent filters', () => {
      expect(validateMailboxAgentsPayload(undefined)).toEqual({ ok: true, value: undefined });
      expect(validateMailboxAgentsPayload({})).toEqual({ ok: true, value: {} });
      expect(validateMailboxAgentsPayload({ onlineOnly: true })).toEqual({
        ok: true,
        value: { onlineOnly: true },
      });
      expectInvalid(validateMailboxAgentsPayload, [null, { onlineOnly: 1 }]);
    });

    it('validates mailbox purge ages independently', () => {
      expect(validateMailboxPurgePayload(undefined)).toEqual({ ok: true, value: undefined });
      expect(validateMailboxPurgePayload({})).toEqual({ ok: true, value: {} });
      expect(validateMailboxPurgePayload({ completedMaxAgeMs: 0, incompleteMaxAgeMs: 5 })).toEqual({
        ok: true,
        value: { completedMaxAgeMs: 0, incompleteMaxAgeMs: 5 },
      });
      expectInvalid(validateMailboxPurgePayload, [
        null,
        { completedMaxAgeMs: -1 },
        { completedMaxAgeMs: Number.POSITIVE_INFINITY },
        { completedMaxAgeMs: '1' },
        { incompleteMaxAgeMs: -1 },
        { incompleteMaxAgeMs: Number.NaN },
        { incompleteMaxAgeMs: '1' },
      ]);
    });
  });

  describe('preference payloads', () => {
    it('accepts every preference value family', () => {
      const result = validatePrefsUpdatePayload({
        yolo: true,
        maxIterations: 50,
        hqUrl: 'http://127.0.0.1:3499',
        fallbackModels: ['fast', 'safe'],
        fallbackProfiles: { default: ['fast', 'safe'] },
        autonomy: 'auto',
        contextStrategy: 'hybrid',
        contextMode: 'deep',
        tokenSavingTier: 'auto',
        enhanceLanguage: 'english',
        logLevel: 'debug',
        auditLevel: 'full',
        reasoningMode: 'on',
        reasoningEffort: 'xhigh',
        cacheTtl: '1h',
      });

      expect(result).toMatchObject({ ok: true });
    });

    // v11 + v13 Display parity regression: the WebUI SettingsPanel sends
    // these v11/v13 fields through `prefs.update` (Display section + Agent
    // section). Before this fix the server rejected them with
    // "unknown preference key: …", breaking the WebUI settings save flow.
    it('accepts every v11 + v13 Display parity preference key', () => {
      const result = validatePrefsUpdatePayload({
        // v11 booleans.
        showModelReasoning: true,
        showAgentSwarmPanel: 'sidebar',
        allowOutsideProjectRoot: true,
        // v13 booleans (TUI SettingsPicker fields 42 & 43).
        readSymbols: true,
        showSageMemoryInject: false,
        // v13 numbers (TUI SettingsPicker fields 21, 41, 44).
        preRefineSeconds: 3,
        multiDiffSummaryThreshold: 5,
        sageMemoryInjectThreshold: 0.85,
        // Agent section number that previously slipped through the
        // whitelist (`enhanceCountdownMs`).
        enhanceCountdownMs: 3_000,
      });

      expect(result).toMatchObject({ ok: true });
    });

    it('rejects v13 Display parity keys with the wrong type', () => {
      expectInvalid(validatePrefsUpdatePayload, [
        { readSymbols: 'yes' },
        { showSageMemoryInject: 1 },
        { preRefineSeconds: '3' },
        { multiDiffSummaryThreshold: Number.NaN },
        { sageMemoryInjectThreshold: '0.85' },
        { enhanceCountdownMs: '3000' },
        // showAgentSwarmPanel is now an enum, not boolean
        { showAgentSwarmPanel: true },
        { showAgentSwarmPanel: 'top' },
      ]);
    });

    it('accepts Chimera round-robin/random selection and rejects invalid modes', () => {
      expect(validatePrefsUpdatePayload({ autoReviewModelSelection: 'round-robin' })).toMatchObject(
        {
          ok: true,
        },
      );
      expect(validatePrefsUpdatePayload({ autoReviewModelSelection: 'random' })).toMatchObject({
        ok: true,
      });
      expectInvalid(validatePrefsUpdatePayload, [
        { autoReviewModelSelection: 'fallback' },
        { autoReviewModelSelection: true },
      ]);
    });

    it('accepts complete and runtime-only model matrix entries', () => {
      expect(
        validatePrefsUpdatePayload({
          modelMatrix: {
            coder: {
              provider: 'openai',
              model: 'gpt-5',
              fallbackProfile: 'reliable',
              modelRuntime: {
                reasoning: { mode: 'auto', effort: 'high', preserve: true },
                cache: { ttl: '5m' },
                parameters: { temperature: 0.2 },
              },
            },
            reviewer: { modelRuntime: {} },
          },
        }),
      ).toMatchObject({ ok: true });
    });

    it('rejects non-object payloads and unknown preference keys', () => {
      expectInvalid(validatePrefsUpdatePayload, [null, [], { notASetting: true }]);
    });

    it.each([
      ['yolo', 'yes'],
      ['maxIterations', Number.NaN],
      ['maxConcurrent', '4'],
      ['hqUrl', 42],
      ['fallbackModels', 'fast'],
      ['fallbackModels', ['fast', 1]],
      ['fallbackProfiles', []],
      ['fallbackProfiles', { default: 'fast' }],
      ['fallbackProfiles', { default: ['fast', 1] }],
      ['autonomy', 'forever'],
      ['contextStrategy', 1],
    ])('rejects malformed %s preference values', (key, value) => {
      expect(validatePrefsUpdatePayload({ [key]: value })).toMatchObject({ ok: false });
    });

    it.each([
      ['matrix is not an object', []],
      ['entry is not an object', { coder: 'gpt-5' }],
      ['provider is not a string', { coder: { provider: 1, model: 'gpt-5' } }],
      ['model is not a string', { coder: { model: 1 } }],
      ['fallback profile is not a string', { coder: { fallbackProfile: 1 } }],
      ['runtime is not an object', { coder: { modelRuntime: true } }],
      ['entry has no routing value', { coder: { provider: 'openai' } }],
      ['reasoning is not an object', { coder: { modelRuntime: { reasoning: true } } }],
      ['reasoning mode is invalid', { coder: { modelRuntime: { reasoning: { mode: 'always' } } } }],
      [
        'reasoning effort is invalid',
        { coder: { modelRuntime: { reasoning: { effort: 'huge' } } } },
      ],
      [
        'reasoning preserve is invalid',
        { coder: { modelRuntime: { reasoning: { preserve: 1 } } } },
      ],
      ['cache is not an object', { coder: { modelRuntime: { cache: true } } }],
      ['cache ttl is default', { coder: { modelRuntime: { cache: { ttl: 'default' } } } }],
      ['cache ttl is not a string', { coder: { modelRuntime: { cache: { ttl: 5 } } } }],
      ['parameters are not an object', { coder: { modelRuntime: { parameters: true } } }],
    ])('rejects model matrix when %s', (_name, modelMatrix) => {
      expect(validatePrefsUpdatePayload({ modelMatrix })).toMatchObject({ ok: false });
    });

    // B-01 regression (docs/audit/webui-full-review-2026-09-03.md).
    // `modelTiers` was in pref-helpers' PREF_KEYS with a working persist
    // branch, but in no validator set — so it fell through to "unknown
    // preference key" and the rejection took the WHOLE payload with it. The
    // WebUI's Model Tiers editor sends the entire object on every keystroke,
    // so the panel showed the edit while the config file never changed.
    it('accepts the full modelTiers object the WebUI tier editor sends', () => {
      expect(
        validatePrefsUpdatePayload({
          modelTiers: {
            enabled: true,
            default: 'standard',
            levels: {
              budget: {
                fallbackProfile: 'cheap',
                maxCostUsd: 0.5,
                maxIterations: 20,
                maxToolCalls: 40,
                maxTokens: 120_000,
                timeoutMs: 300_000,
                description: 'Cheap and fast.',
                modelRuntime: { reasoning: { mode: 'off' }, cache: { ttl: '1h' } },
              },
              premium: { provider: 'anthropic', model: 'claude-opus-5' },
            },
            routing: { '*': 'standard', reviewer: 'premium' },
            leader: {
              mode: 'propose',
              dwellTurns: 6,
              minSavingsUsd: 0.1,
              maxContextFillForSwitch: 0.8,
              maxTier: 'premium',
            },
          },
        }),
      ).toMatchObject({ ok: true });
    });

    it('accepts a modelTiers object that only flips the master switch', () => {
      expect(validatePrefsUpdatePayload({ modelTiers: { enabled: false } })).toMatchObject({
        ok: true,
      });
      expect(validatePrefsUpdatePayload({ modelTiers: {} })).toMatchObject({ ok: true });
    });

    it.each([
      ['the value is not an object', 'standard'],
      ['the value is an array', []],
      ['enabled is not a boolean', { enabled: 'yes' }],
      ['levels is not an object', { levels: [] }],
      ['a level is not an object', { levels: { budget: 'cheap' } }],
      ['a level budget is negative', { levels: { budget: { maxIterations: 0 } } }],
      ['a level budget is not finite', { levels: { budget: { maxCostUsd: Number.NaN } } }],
      ['a level field has the wrong type', { levels: { budget: { fallbackProfile: 1 } } }],
      [
        'a level runtime is invalid',
        { levels: { budget: { modelRuntime: { reasoning: { effort: 'huge' } } } } },
      ],
      ['routing is not an object', { routing: 'premium' }],
      ['a routing target is not a string', { routing: { reviewer: 3 } }],
      ['leader mode is unknown', { leader: { mode: 'whenever' } }],
      ['leader context fill is out of range', { leader: { maxContextFillForSwitch: 1.5 } }],
    ])('rejects modelTiers when %s', (_name, modelTiers) => {
      expect(validatePrefsUpdatePayload({ modelTiers })).toMatchObject({ ok: false });
    });

    // The KEYS of `levels` and `routing` become property names on
    // `config.modelTiers` (pref-helpers.ts), exactly like modelMatrix's role
    // names — so both records need the same prototype-pollution guard.
    // JSON.parse, not an object literal: it makes `__proto__` an OWN
    // enumerable key — what an incoming WS frame actually produces. A literal
    // would invoke the prototype setter and leave the guard nothing to see.
    it.each([
      ['levels', '{"modelTiers":{"levels":{"__proto__":{"fallbackProfile":"cheap"}}}}'],
      ['routing', '{"modelTiers":{"routing":{"__proto__":"premium"}}}'],
    ])('rejects a forbidden prototype key in modelTiers.%s', (_name, frame) => {
      const result = validatePrefsUpdatePayload(JSON.parse(frame) as unknown);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('forbidden key');
    });
  });

  describe('skills payloads', () => {
    it('accepts project and global skill creation', () => {
      expect(
        validateSkillsCreatePayload({
          name: 'code-review',
          description: 'Reviews code',
          scope: 'project',
        }),
      ).toMatchObject({ ok: true });
      expect(
        validateSkillsCreatePayload({
          name: 'review',
          description: 'Reviews code',
          scope: 'global',
        }),
      ).toMatchObject({ ok: true });
    });

    it('rejects malformed skill creation payloads', () => {
      expectInvalid(validateSkillsCreatePayload, [
        null,
        { name: '', description: 'x', scope: 'project' },
        { name: 'Bad_Name', description: 'x', scope: 'project' },
        { name: 'review', description: '', scope: 'project' },
        { name: 'review', description: 1, scope: 'project' },
        { name: 'review', description: 'x', scope: 'local' },
      ]);
    });
  });

  describe('custom context mode payloads', () => {
    const validCreate = {
      id: 'focused',
      name: 'Focused',
      description: 'Small working set',
      thresholds: { warn: 1, soft: 2, hard: 3 },
      preserveK: 4,
      eliseThreshold: 5,
    };

    it('accepts a complete create payload', () => {
      expect(validateContextModeCreatePayload(validCreate)).toEqual({
        ok: true,
        value: validCreate,
      });
    });

    it('rejects each invalid create field', () => {
      expectInvalid(validateContextModeCreatePayload, [
        null,
        { ...validCreate, id: '' },
        { ...validCreate, id: 1 },
        { ...validCreate, name: '' },
        { ...validCreate, name: 1 },
        { ...validCreate, description: 1 },
        { ...validCreate, thresholds: null },
        { ...validCreate, thresholds: { warn: Number.NaN, soft: 2, hard: 3 } },
        { ...validCreate, thresholds: { warn: 1, soft: Number.NaN, hard: 3 } },
        { ...validCreate, thresholds: { warn: 1, soft: 2, hard: Number.NaN } },
        { ...validCreate, preserveK: Number.NaN },
        { ...validCreate, eliseThreshold: Number.POSITIVE_INFINITY },
      ]);
    });

    it('accepts minimal and complete update payloads', () => {
      expect(validateContextModeUpdatePayload({ id: 'focused' })).toEqual({
        ok: true,
        value: { id: 'focused' },
      });
      expect(
        validateContextModeUpdatePayload({
          id: 'focused',
          name: 'Focused 2',
          description: 'Updated',
          thresholds: { warn: 2, soft: 3, hard: 4 },
          preserveK: 5,
          eliseThreshold: 6,
        }),
      ).toMatchObject({ ok: true });
      expect(validateContextModeUpdatePayload({ id: 'focused', thresholds: {} })).toMatchObject({
        ok: true,
      });
    });

    it('rejects each invalid update field', () => {
      expectInvalid(validateContextModeUpdatePayload, [
        null,
        { id: '' },
        { id: 1 },
        { id: 'focused', name: 1 },
        { id: 'focused', description: 1 },
        { id: 'focused', thresholds: null },
        { id: 'focused', thresholds: { warn: Number.NaN } },
        { id: 'focused', thresholds: { soft: Number.NaN } },
        { id: 'focused', thresholds: { hard: Number.NaN } },
        { id: 'focused', preserveK: Number.NaN },
        { id: 'focused', eliseThreshold: Number.NaN },
      ]);
    });
  });

  describe('filesystem-oriented payloads', () => {
    it('validates shell targets and optional target omission', () => {
      expect(validateShellOpenPayload({ path: '/tmp/a' })).toEqual({
        ok: true,
        value: { path: '/tmp/a' },
      });
      expect(validateShellOpenPayload({ path: '/tmp/a', target: 'file' })).toMatchObject({
        ok: true,
      });
      expect(validateShellOpenPayload({ path: '/tmp/a', target: 'terminal' })).toMatchObject({
        ok: true,
      });
      expectInvalid(validateShellOpenPayload, [
        null,
        { path: '' },
        { path: 1 },
        { path: '/tmp/a', target: 'browser' },
      ]);
    });

    it('normalizes an omitted git diff path', () => {
      expect(validateGitDiffPayload({})).toEqual({ ok: true, value: { path: '' } });
      expect(validateGitDiffPayload({ path: null })).toEqual({ ok: true, value: { path: '' } });
      expect(validateGitDiffPayload({ path: 'src/a.ts' })).toEqual({
        ok: true,
        value: { path: 'src/a.ts' },
      });
      expectInvalid(validateGitDiffPayload, [null, { path: 1 }]);
    });

    it.each([
      ['projects.add', validateProjectsAddPayload],
      ['projects.select', validateProjectsSelectPayload],
    ])('validates %s payloads', (_name, validator) => {
      expect(validator({ root: '/workspace' })).toEqual({
        ok: true,
        value: { root: '/workspace' },
      });
      expect(validator({ root: '/workspace', name: 'WrongStack' })).toMatchObject({ ok: true });
      expectInvalid(validator, [null, { root: '' }, { root: 1 }, { root: '/workspace', name: 1 }]);
    });
  });

  // ---------------------------------------------------------------------------
  // B-07: migrated from packages/webui/tests/server/ws-payload-validation.test.ts.
  // The webui suite re-tests every validator with broader / differently-shaped
  // payloads. The cases below pin contracts that the server's existing suite
  // did not cover: the requestId whitespace guard, all five levels / modes
  // parameterized (vs. a single representative), empty-string-array acceptance
  // for `fallbackModels`, and additional non-object types for `prefs.update`.
  // ---------------------------------------------------------------------------

  describe('B-07 migrated coverage (model.switch / brain / autonomy)', () => {
    it('rejects an empty (whitespace-only) model.switch requestId', () => {
      // Server's `'accepts valid and rejects invalid model.switch payloads'`
      // exercises provider/model/rejection but never a requestId field. A
      // regression that dropped the requestId.trim() guard would let an
      // empty echoed requestId round-trip back to the WS client and break
      // the per-session switch-routing key.
      expect(
        validateModelSwitchPayload({ provider: 'openai', model: 'gpt-5', requestId: '  ' }),
      ).toMatchObject({ ok: false });
    });

    it.each(['off', 'low', 'medium', 'high', 'all'])('accepts brain.risk level %s', (level) => {
      // Server's suite uses `valid: { level: 'medium' }` only. Pinning all
      // five valid levels guards against an `AUTONOMY_VALUES` /
      // `BRAIN_RISK_VALUES` set shrinking accidentally (e.g. someone deletes
      // 'off' thinking it's redundant).
      expect(validateBrainRiskPayload({ level })).toEqual({ ok: true, value: { level } });
    });

    it.each(['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'])(
      'accepts autonomy.switch mode %s',
      (mode) => {
        expect(validateAutonomySwitchPayload({ mode })).toEqual({ ok: true, value: { mode } });
      },
    );
  });

  describe('B-07 migrated coverage (mailbox primitives)', () => {
    it('rejects a string sentinel for mailbox.purge (not just null/array/number)', () => {
      // Server's invalid list for `validateMailboxPurgePayload` covers
      // null, array, and wrong-typed numbers. It never covers the bare
      // string `'x'`, which an opponent payload could supply to exercise
      // an unhandled branch.
      const result = validateMailboxPurgePayload('x');
      expect(result.ok).toBe(false);
    });

    it('rejects a string sentinel for mailbox.agents (not just null/array/bad onlineOnly)', () => {
      const result = validateMailboxAgentsPayload('x');
      expect(result.ok).toBe(false);
    });
  });

  describe('B-07 migrated coverage (prefs.update)', () => {
    it('accepts an empty fallbackModels array (clear vs. accept-defaults)', () => {
      // Server covers array-element validation (`'rejects fallbackModels: ['fast', 1]'`)
      // but never pins that `[]` is explicitly valid. The WebUI "Clear fallback
      // list" button sends exactly this — a regression that treated `[]` as
      // "no models" and rejected it would leave the user unable to reset.
      expect(validatePrefsUpdatePayload({ fallbackModels: [] })).toMatchObject({ ok: true });
    });

    it.each([
      undefined,
      null,
      [],
      'prefs',
      123,
      true,
    ])('rejects non-object prefs.update payload %#', (payload) => {
      // Server covers `[null, [], { notASetting: true }]`. The webui side
      // additionally sends literal strings / numbers / booleans when an
      // upstream serializer corrupts the envelope — those must reject too.
      const result = validatePrefsUpdatePayload(payload);
      expect(result.ok).toBe(false);
    });

    it.each([
      { typoPreference: true },
      { yolo: 'yes' },
      { maxIterations: Number.NaN },
      { maxConcurrent: '4' },
      { autonomy: 'manual' },
      { contextStrategy: 'random' },
      { logLevel: 'trace' },
      { auditLevel: 'verbose' },
      { fallbackModels: 'anthropic/claude' },
      { fallbackModels: [1, 2] },
      { fallbackProfiles: ['bad'] },
      { fallbackProfiles: { default: 'anthropic/claude' } },
      { favoriteModels: 'anthropic/claude' },
      { favoriteModelsOnly: 'yes' },
      { fallbackAuto: 'yes' },
    ])('rejects unknown keys or invalid preference values %#', (payload) => {
      const result = validatePrefsUpdatePayload(payload);
      expect(result.ok).toBe(false);
    });
  });

  describe('B-07 migrated coverage (context.mode.create)', () => {
    it('rejects eliseThreshold: undefined explicitly (not just non-finite numbers)', () => {
      // The server's `'rejects each invalid create field'` covers
      // `{ ...validCreate, eliseThreshold: Number.POSITIVE_INFINITY }` but
      // not the undefined case. The validator's `isFiniteNumber` check
      // returns false for undefined — this pins that explicit undefined
      // is rejected (a future refactor that switched to `?? <default>`
      // would silently start accepting omitted `eliseThreshold` instead of
      // demanding it as a required finite number).
      const validPayload = {
        id: 'my-mode',
        name: 'My Mode',
        description: 'A custom context mode.',
        thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
        preserveK: 10,
      };
      const result = validateContextModeCreatePayload({
        ...validPayload,
        eliseThreshold: undefined as unknown as number,
      });
      expect(result.ok).toBe(false);
    });
  });
});
