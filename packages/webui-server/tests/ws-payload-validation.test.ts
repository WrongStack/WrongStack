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
        tokenSavingTier: 'light',
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
      expect(validatePrefsUpdatePayload({ autoReviewModelSelection: 'round-robin' })).toMatchObject({
        ok: true,
      });
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
});
