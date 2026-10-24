import { TOKENS } from '@wrongstack/contracts/kernel';
import { describe, expect, it, vi } from 'vitest';

const setupSession = vi.hoisted(() => vi.fn());
vi.mock('../src/wiring/session.js', () => ({ setupSession }));
const seedScoutLearnedTools = vi.hoisted(() => vi.fn());
const attachScoutToolLearning = vi.hoisted(() => vi.fn());
vi.mock('@wrongstack/core/storage', () => ({
  attachScoutToolLearning,
  getSessionRegistry: () => ({}),
  seedScoutLearnedTools,
}));
vi.mock('@wrongstack/core/utils', () => ({ addFatalSalvageHook: () => undefined }));

import { setupSessionEstablishment } from '../src/wiring/session-establishment.js';

function args(config: Parameters<typeof setupSessionEstablishment>[0]['config']) {
  const resolved = new Map<unknown, unknown>([
    [TOKENS.SessionStore, {}],
    [TOKENS.TokenCounter, { setSessionId: () => undefined }],
  ]);
  return {
    container: { resolve: (token: unknown) => resolved.get(token) },
    config,
    wpaths: { globalRoot: '/g', projectSlug: 'p' },
    projectRoot: '/repo',
    cwd: '/repo',
    systemPrompt: [],
    provider: {},
    renderer: {},
    flags: {},
    events: {},
    logger: {},
    sessionRef: { current: undefined },
    onlineAgents: [],
    tuiOwnsScreen: false,
  } as never;
}

describe('setupSessionEstablishment', () => {
  it('hands setupSession the config fields that scope the leader context', async () => {
    setupSession.mockResolvedValue({ context: { meta: {} }, session: { id: 's' } });
    const config = {
      model: 'm',
      provider: 'p',
      features: { allowOutsideProjectRoot: false },
      tools: { restrictToProjectRoot: true },
      systemPrompt: { variant: 'scout' },
    };

    await setupSessionEstablishment(args(config));

    // The filesystem scope and the identity variant must survive the hop:
    // without them the context opened with access outside the project root.
    expect(setupSession).toHaveBeenCalledWith(expect.objectContaining({ config }));
  });

  it('seeds the learned Scout tools into the new context and starts learning', async () => {
    const meta: Record<string, unknown> = {};
    setupSession.mockResolvedValue({ context: { meta }, session: { id: 's' } });
    const input = args({ model: 'm', provider: 'p' }) as unknown as {
      wpaths: { projectDir: string };
      events: unknown;
    };
    input.wpaths.projectDir = '/proj';

    await setupSessionEstablishment(input as never);

    expect(seedScoutLearnedTools).toHaveBeenCalledWith(meta, '/proj');
    expect(attachScoutToolLearning).toHaveBeenCalledWith(input.events, '/proj');
  });
});
