import { describe, expect, it } from 'vitest';
import {
  validateAutonomySwitchPayload,
  validateBrainAskPayload,
  validateBrainRiskPayload,
  validateContextModeCreatePayload,
  validateContextModeDeletePayload,
  validateContextModeSwitchPayload,
  validateContextModeUpdatePayload,
  validateGitDiffPayload,
  validateMailboxAgentsPayload,
  validateMailboxMessagesPayload,
  validateMailboxPurgePayload,
  validateModeSwitchPayload,
  validateModelSwitchPayload,
  validatePlanTemplateUsePayload,
  validatePrefsUpdatePayload,
  validateProcessKillPayload,
  validateProjectsAddPayload,
  validateProjectsSelectPayload,
  validateShellOpenPayload,
  validateSkillsCreatePayload,
  validateSkillsEditPayload,
  validateWorkingDirSetPayload,
} from '../../src/server/ws-payload-validation.js';

describe('WebUI WebSocket payload validation', () => {
  describe('validateModelSwitchPayload', () => {
    it('accepts non-empty provider and model strings', () => {
      expect(validateModelSwitchPayload({ provider: 'anthropic', model: 'test-model' })).toEqual({
        ok: true,
        value: { provider: 'anthropic', model: 'test-model' },
      });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { provider: '', model: 'test-model' },
      { provider: '   ', model: 'test-model' },
      { provider: 'anthropic', model: '' },
      { provider: 'anthropic', model: '   ' },
      { provider: 123, model: 'test-model' },
      { provider: 'anthropic', model: 123 },
    ])('rejects invalid model.switch payload %#', (payload) => {
      const result = validateModelSwitchPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('model.switch');
    });
  });

  describe('validateMailboxMessagesPayload', () => {
    it('accepts undefined or valid mailbox query options', () => {
      expect(validateMailboxMessagesPayload(undefined)).toEqual({ ok: true, value: undefined });
      expect(
        validateMailboxMessagesPayload({
          limit: 10,
          agentId: 'leader',
          unreadOnly: true,
          incompleteOnly: true,
        }),
      ).toEqual({
        ok: true,
        value: { limit: 10, agentId: 'leader', unreadOnly: true, incompleteOnly: true },
      });
    });

    it.each([
      null,
      [],
      'x',
      { limit: 0 },
      { limit: Number.NaN },
      { agentId: 1 },
      { unreadOnly: 'yes' },
      { incompleteOnly: 'yes' },
    ])('rejects invalid mailbox.messages payload %#', (payload) => {
      const result = validateMailboxMessagesPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('mailbox.messages');
    });
  });

  describe('validateMailboxAgentsPayload', () => {
    it('accepts undefined or valid mailbox agents options', () => {
      expect(validateMailboxAgentsPayload(undefined)).toEqual({ ok: true, value: undefined });
      expect(validateMailboxAgentsPayload({ onlineOnly: false })).toEqual({ ok: true, value: { onlineOnly: false } });
    });

    it.each([null, [], 'x', { onlineOnly: 'yes' }])('rejects invalid mailbox.agents payload %#', (payload) => {
      const result = validateMailboxAgentsPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('mailbox.agents');
    });
  });

  describe('validateMailboxPurgePayload', () => {
    it('accepts undefined or valid purge ages', () => {
      expect(validateMailboxPurgePayload(undefined)).toEqual({ ok: true, value: undefined });
      expect(validateMailboxPurgePayload({ completedMaxAgeMs: 0, incompleteMaxAgeMs: 1000 })).toEqual({
        ok: true,
        value: { completedMaxAgeMs: 0, incompleteMaxAgeMs: 1000 },
      });
    });

    it.each([null, [], 'x', { completedMaxAgeMs: -1 }, { completedMaxAgeMs: '1' }, { incompleteMaxAgeMs: Number.NaN }])(
      'rejects invalid mailbox.purge payload %#',
      (payload) => {
        const result = validateMailboxPurgePayload(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain('mailbox.purge');
      },
    );
  });

  describe('validateBrainRiskPayload', () => {
    it.each(['off', 'low', 'medium', 'high', 'all'])('accepts brain risk level %s', (level) => {
      expect(validateBrainRiskPayload({ level })).toEqual({ ok: true, value: { level } });
    });

    it.each([undefined, null, [], {}, { level: '' }, { level: 'extreme' }, { level: 1 }])(
      'rejects invalid brain.risk payload %#',
      (payload) => {
        const result = validateBrainRiskPayload(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain('brain.risk');
      },
    );
  });

  describe('validateBrainAskPayload', () => {
    it('accepts and trims a question', () => {
      expect(validateBrainAskPayload({ question: '  What next?  ' })).toEqual({ ok: true, value: { question: 'What next?' } });
    });

    it.each([undefined, null, [], {}, { question: '' }, { question: '   ' }, { question: 123 }])(
      'rejects invalid brain.ask payload %#',
      (payload) => {
        const result = validateBrainAskPayload(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain('brain.ask');
      },
    );
  });

  describe('validateModeSwitchPayload', () => {
    it('accepts a non-empty mode id', () => {
      expect(validateModeSwitchPayload({ id: 'default' })).toEqual({ ok: true, value: { id: 'default' } });
    });

    it.each([undefined, null, [], {}, { id: '' }, { id: '   ' }, { id: 123 }])(
      'rejects invalid mode.switch payload %#',
      (payload) => {
        const result = validateModeSwitchPayload(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain('mode.switch');
      },
    );
  });

  describe('validateAutonomySwitchPayload', () => {
    it.each(['off', 'suggest', 'auto', 'eternal', 'eternal-parallel'])('accepts autonomy mode %s', (mode) => {
      expect(validateAutonomySwitchPayload({ mode })).toEqual({ ok: true, value: { mode } });
    });

    it.each([undefined, null, [], {}, { mode: '' }, { mode: 'manual' }, { mode: 123 }])(
      'rejects invalid autonomy.switch payload %#',
      (payload) => {
        const result = validateAutonomySwitchPayload(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain('autonomy.switch');
      },
    );
  });

  describe('validatePlanTemplateUsePayload', () => {
    it('accepts a non-empty template string', () => {
      expect(validatePlanTemplateUsePayload({ template: 'bug-fix' })).toEqual({ ok: true, value: { template: 'bug-fix' } });
    });

    it.each([undefined, null, [], {}, { template: '' }, { template: '   ' }, { template: 123 }])(
      'rejects invalid plan.template_use payload %#',
      (payload) => {
        const result = validatePlanTemplateUsePayload(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain('plan.template_use');
      },
    );
  });

  describe('validatePrefsUpdatePayload', () => {
    it('accepts whitelisted preference keys with valid values', () => {
      const prefs = {
        autonomy: 'auto',
        yolo: true,
        autonomyDelayMs: 500,
        autoProceedMaxIterations: 10,
        maxIterations: 100,
        maxConcurrent: 4,
        chime: false,
        confirmExit: true,
        streamFleet: true,
        nextPrediction: false,
        titleAnimation: true,
        enhanceEnabled: true,
        enhanceDelayMs: 30_000,
        enhanceLanguage: 'english',
        featureMcp: true,
        featurePlugins: true,
        featureMemory: true,
        featureSkills: true,
        featureModelsRegistry: true,
        indexOnStart: false,
        contextAutoCompact: true,
        contextStrategy: 'hybrid',
        contextMode: 'balanced',
        tokenSavingTier: 'medium',
        logLevel: 'debug',
        auditLevel: 'standard',
        tgSessionEnd: true,
        tgDelegate: false,
        tgLongToolMs: 30_000,
        fallbackModels: ['anthropic/claude-haiku-4-5', 'openai/gpt-5'],
        fallbackProfiles: {
          default: ['anthropic/anthropic-test-model', 'openai/gpt-5'],
        },
        favoriteModels: ['anthropic/anthropic-test-model'],
        favoriteModelsOnly: true,
        modelMatrix: {
          '*': { fallbackProfile: 'default' },
          review: { provider: 'anthropic', model: 'test-model' },
          planner: {
            modelRuntime: {
              reasoning: { mode: 'on', effort: 'low', preserve: false },
              cache: { ttl: '5m' },
              parameters: { user: 'planner' },
            },
          },
        },
        fallbackAuto: false,
      };
      expect(validatePrefsUpdatePayload(prefs)).toEqual({ ok: true, value: { prefs } });
    });

    it('accepts an empty fallbackModels array', () => {
      expect(validatePrefsUpdatePayload({ fallbackModels: [] })).toEqual({
        ok: true,
        value: { prefs: { fallbackModels: [] } },
      });
    });

    it.each([undefined, null, [], 'prefs', 123, true])('rejects non-object prefs.update payload %#', (payload) => {
      const result = validatePrefsUpdatePayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('prefs.update');
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
      { modelMatrix: [] },
      { modelMatrix: { '*': { provider: 1, model: 'x' } } },
      { modelMatrix: { '*': { provider: 'anthropic' } } },
      { modelMatrix: { '*': { modelRuntime: [] } } },
      { modelMatrix: { '*': { modelRuntime: { reasoning: [] } } } },
      { modelMatrix: { '*': { modelRuntime: { reasoning: { mode: 'yes' } } } } },
      { modelMatrix: { '*': { modelRuntime: { reasoning: { effort: 'ultra' } } } } },
      { modelMatrix: { '*': { modelRuntime: { reasoning: { preserve: 'on' } } } } },
      { modelMatrix: { '*': { modelRuntime: { cache: { ttl: 'default' } } } } },
      { modelMatrix: { '*': { modelRuntime: { parameters: [] } } } },
      { fallbackAuto: 'yes' },
    ])('rejects unknown keys or invalid preference values %#', (payload) => {
      const result = validatePrefsUpdatePayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('prefs.update');
    });
  });

  describe('validateSkillsCreatePayload', () => {
    it('accepts kebab-case name, description, and project/global scope', () => {
      expect(validateSkillsCreatePayload({ name: 'my-skill', description: 'Use this skill when X.', scope: 'project' })).toEqual({
        ok: true,
        value: { name: 'my-skill', description: 'Use this skill when X.', scope: 'project' },
      });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { name: '', description: 'x', scope: 'project' },
      { name: 'Bad_Name', description: 'x', scope: 'project' },
      { name: 'my-skill', description: '', scope: 'project' },
      { name: 'my-skill', description: 'x', scope: 'wrong' },
      { name: 'my-skill', description: 'x' },
    ])('rejects invalid skills.create payload %#', (payload) => {
      const result = validateSkillsCreatePayload(payload);
      expect(result.ok).toBe(false);
    });
  });

  describe('validateSkillsEditPayload', () => {
    it('accepts non-empty name and body', () => {
      expect(validateSkillsEditPayload({ name: 'my-skill', body: '# My Skill' })).toEqual({
        ok: true,
        value: { name: 'my-skill', body: '# My Skill' },
      });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { name: '', body: '# body' },
      { name: 'my-skill', body: '' },
      { name: 'my-skill' },
    ])('rejects invalid skills.edit payload %#', (payload) => {
      const result = validateSkillsEditPayload(payload);
      expect(result.ok).toBe(false);
    });
  });

  describe('validateProcessKillPayload', () => {
    it('accepts a positive integer pid', () => {
      expect(validateProcessKillPayload({ pid: 1234 })).toEqual({ ok: true, value: { pid: 1234 } });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { pid: '1234' },
      { pid: 0 },
      { pid: -1 },
      { pid: 1.5 },
      { pid: Number.NaN },
    ])('rejects invalid process.kill payload %#', (payload) => {
      const result = validateProcessKillPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('pid');
    });
  });

  describe('validateWorkingDirSetPayload', () => {
    it('accepts a non-empty string path', () => {
      expect(validateWorkingDirSetPayload({ path: 'src' })).toEqual({ ok: true, value: { path: 'src' } });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { path: '' },
      { path: '   ' },
      { path: 123 },
    ])('rejects invalid working_dir.set payload %#', (payload) => {
      const result = validateWorkingDirSetPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('path');
    });
  });

  describe('validateProjectsAddPayload', () => {
    it('accepts a non-empty root and optional name', () => {
      expect(validateProjectsAddPayload({ root: '/home/user/project' })).toEqual({
        ok: true,
        value: { root: '/home/user/project', name: undefined },
      });
      expect(validateProjectsAddPayload({ root: '/home/user/project', name: 'My Project' })).toEqual({
        ok: true,
        value: { root: '/home/user/project', name: 'My Project' },
      });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { root: '' },
      { root: 123 },
      { root: '/path', name: 123 },
    ])('rejects invalid projects.add payload %#', (payload) => {
      const result = validateProjectsAddPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('projects.add');
    });
  });

  describe('validateProjectsSelectPayload', () => {
    it('accepts a non-empty root and optional name', () => {
      expect(validateProjectsSelectPayload({ root: '/home/user/project' })).toEqual({
        ok: true,
        value: { root: '/home/user/project', name: undefined },
      });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { root: '' },
      { root: 123 },
      { root: '/path', name: true },
    ])('rejects invalid projects.select payload %#', (payload) => {
      const result = validateProjectsSelectPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('projects.select');
    });
  });

  describe('validateShellOpenPayload', () => {
    it('accepts a non-empty path with optional target', () => {
      expect(validateShellOpenPayload({ path: '/home/user/project' })).toEqual({
        ok: true,
        value: { path: '/home/user/project', target: undefined },
      });
      expect(validateShellOpenPayload({ path: '/home/user/project', target: 'terminal' })).toEqual({
        ok: true,
        value: { path: '/home/user/project', target: 'terminal' },
      });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { path: '' },
      { path: 123 },
      { path: '/path', target: 'invalid' },
    ])('rejects invalid shell.open payload %#', (payload) => {
      const result = validateShellOpenPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('shell.open');
    });
  });

  describe('validateGitDiffPayload', () => {
    it('accepts a string path', () => {
      expect(validateGitDiffPayload({ path: 'src/index.ts' })).toEqual({
        ok: true,
        value: { path: 'src/index.ts' },
      });
    });

    it('accepts missing path as empty string', () => {
      expect(validateGitDiffPayload({})).toEqual({ ok: true, value: { path: '' } });
    });

    it.each([
      undefined,
      null,
      [],
      { path: 123 },
      { path: true },
    ])('rejects invalid git.diff payload %#', (payload) => {
      const result = validateGitDiffPayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('git.diff');
    });
  });

  describe('validateContextModeSwitchPayload', () => {
    it('accepts a non-empty mode id', () => {
      expect(validateContextModeSwitchPayload({ id: 'balanced' })).toEqual({ ok: true, value: { id: 'balanced' } });
    });

    it.each([undefined, null, [], {}, { id: '' }, { id: '   ' }, { id: 123 }])(
      'rejects invalid context.mode.switch payload %#',
      (payload) => {
        const result = validateContextModeSwitchPayload(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain('context.mode.switch');
      },
    );
  });

  describe('validateContextModeDeletePayload', () => {
    it('accepts a non-empty mode id', () => {
      expect(validateContextModeDeletePayload({ id: 'my-mode' })).toEqual({ ok: true, value: { id: 'my-mode' } });
    });

    it.each([undefined, null, [], {}, { id: '' }, { id: '   ' }, { id: 123 }])(
      'rejects invalid context.mode.delete payload %#',
      (payload) => {
        const result = validateContextModeDeletePayload(payload);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.message).toContain('context.mode.delete');
      },
    );
  });

  describe('validateContextModeCreatePayload', () => {
    const validPayload = {
      id: 'my-mode',
      name: 'My Mode',
      description: 'A custom context mode.',
      thresholds: { warn: 0.6, soft: 0.75, hard: 0.9 },
      preserveK: 10,
      eliseThreshold: 2000,
    };

    it('accepts a fully valid payload', () => {
      expect(validateContextModeCreatePayload(validPayload)).toEqual({ ok: true, value: validPayload });
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { ...validPayload, id: '' },
      { ...validPayload, name: '' },
      { ...validPayload, thresholds: 'bad' },
      { ...validPayload, thresholds: { warn: 'x', soft: 0.75, hard: 0.9 } },
      { ...validPayload, preserveK: 'x' },
      { ...validPayload, eliseThreshold: Number.NaN },
      { ...validPayload, eliseThreshold: undefined },
    ])('rejects invalid context.mode.create payload %#', (payload) => {
      const result = validateContextModeCreatePayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('context.mode.create');
    });
  });

  describe('validateContextModeUpdatePayload', () => {
    it('accepts a payload with only id', () => {
      expect(validateContextModeUpdatePayload({ id: 'my-mode' })).toEqual({
        ok: true,
        value: { id: 'my-mode', name: undefined, description: undefined, thresholds: undefined, preserveK: undefined, eliseThreshold: undefined },
      });
    });

    it('accepts a payload with partial fields', () => {
      const result = validateContextModeUpdatePayload({ id: 'my-mode', name: 'New Name', preserveK: 20 });
      expect(result.ok).toBe(true);
    });

    it.each([
      undefined,
      null,
      [],
      {},
      { id: '' },
      { id: 'my-mode', name: 123 },
      { id: 'my-mode', thresholds: 'bad' },
      { id: 'my-mode', thresholds: { warn: 'x' } },
      { id: 'my-mode', preserveK: 'x' },
    ])('rejects invalid context.mode.update payload %#', (payload) => {
      const result = validateContextModeUpdatePayload(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain('context.mode.update');
    });
  });
});
