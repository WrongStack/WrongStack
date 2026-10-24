import { TOKENS } from '@wrongstack/contracts/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  promptAndTools: vi.fn(),
  managementTools: vi.fn(),
  infrastructure: vi.fn(),
}));
vi.mock('../src/wiring/cli-prompt-and-tools-setup.js', () => ({
  setupCliPromptAndTools: mocks.promptAndTools,
}));
vi.mock('../src/wiring/management-tools.js', () => ({
  registerCliManagementTools: mocks.managementTools,
}));
vi.mock('../src/cli-infrastructure.js', () => ({
  setupCliInfrastructure: mocks.infrastructure,
}));

import { setupInitialCliTools } from '../src/cli-initial-tools.js';

type Input = Parameters<typeof setupInitialCliTools>[0];

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('WRONGSTACK_RESTRICTED', '');
  vi.stubEnv('WRONGSTACK_SAFE_MODE', '');
});

function fixture(flags: Record<string, string | boolean> = {}) {
  const skillLoader = {};
  const promptLoader = {};
  const toolRegistry = {};
  const infrastructure = {
    metricsSink: {},
    healthRegistry: {},
    metricsStatus: {},
    tracer: {},
    tuiOwnsScreen: true,
    evOn: vi.fn(),
    eventWiring: {},
    promptBuilder: {},
    onlineAgents: [],
    systemPrompt: 'system prompt',
  };
  const config = { features: {} };
  const input = {
    flags,
    container: {
      resolve: vi.fn((token: symbol) => {
        if (token === TOKENS.SkillLoader) return skillLoader;
        if (token === TOKENS.PromptLoader) return promptLoader;
        throw new Error('unexpected service');
      }),
    },
    getConfig: () => config,
    renderer: { writeWarning: vi.fn() },
    modeStore: {},
    memoryStore: {},
    modeId: 'default',
    modePrompt: 'mode',
    modelCapabilitiesRef: { current: undefined },
    wpaths: {},
    projectRoot: 'project',
    events: {},
    vectorMemoryStore: undefined,
    configStore: {},
    profileConfigPath: 'profile/config.json',
    modelsRegistry: {},
    logger: {},
    teardownHandlers: [],
    activeMode: null,
    cwd: 'project',
    provider: {},
  } as unknown as Input;
  mocks.promptAndTools.mockResolvedValue({ toolRegistry });
  mocks.infrastructure.mockResolvedValue(infrastructure);
  return { input, skillLoader, promptLoader, toolRegistry, infrastructure, config };
}

describe('initial CLI tool wiring', () => {
  it('shares startup refs and keeps management callbacks late-bound', async () => {
    const f = fixture();
    const result = await setupInitialCliTools(f.input);
    const promptInput = mocks.promptAndTools.mock.calls[0]![0];
    const managementInput = mocks.managementTools.mock.calls[0]![0];
    const infrastructureInput = mocks.infrastructure.mock.calls[0]![0];
    expect(result).toMatchObject({
      ...f.infrastructure,
      skillLoader: f.skillLoader,
      promptLoader: f.promptLoader,
      toolRegistry: f.toolRegistry,
    });
    expect(promptInput.sessionRef).toBe(result.sessionRef);
    expect(infrastructureInput.sessionRef).toBe(result.sessionRef);
    expect(promptInput.autonomyModeRef).toBe(result.autonomyModeRef);
    expect(result.autonomyModeRef.current).toBe('off');
    expect(managementInput.toolRegistry).toBe(f.toolRegistry);
    expect(managementInput.getHookRunner()).toBeNull();
    expect(managementInput.getSwitchProviderAndModel()).toBeNull();
    const hookRunner = { preToolUse: vi.fn(async () => ({})) };
    const switchModel = vi.fn(async () => null);
    result.hookRunnerRef.current = hookRunner;
    result.switchProviderAndModelRef.current = switchModel;
    expect(managementInput.getHookRunner()).toBe(hookRunner);
    expect(managementInput.getSwitchProviderAndModel()).toBe(switchModel);
    promptInput.warn('warning');
    expect(f.input.renderer.writeWarning).toHaveBeenCalledWith('warning');
  });

  it('forwards safe mode, appended instructions, and combined tool restrictions', async () => {
    const f = fixture({
      restricted: true,
      'safe-mode': true,
      'only-tools': 'read,grep',
      'disallowed-tools': 'write',
      'append-system-prompt': 'extra instruction',
    });
    await setupInitialCliTools(f.input);
    expect(mocks.promptAndTools.mock.calls[0]![0]).toMatchObject({
      config: f.config,
      safeMode: true,
      appendedInstructions: 'extra instruction',
      toolRestriction: {
        only: ['read', 'grep'],
        deny: ['write', 'mcp__*'],
        requireDeclaredCapabilities: true,
        denyCapabilities: expect.arrayContaining(['shell.arbitrary']),
      },
    });
  });
});
