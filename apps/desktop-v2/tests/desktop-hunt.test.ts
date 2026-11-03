import { parseBugHuntMessage } from '@wrongstack/project-surfaces/lib/bug-hunt-message';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type DesktopCommandContext, runDesktopCommand } from '../src/desktop-command-runner';
import { parseDesktopCommand } from '../src/desktop-commands';
import {
  clearHuntStop,
  HUNT_COMMANDS,
  type HuntRequest,
  huntContinues,
  huntStopped,
  latestHuntRound,
  nextHuntRound,
  prepareHunt,
  requestHuntStop,
} from '../src/desktop-hunt';
import { HuntRoundCard } from '../src/HuntRounds';

const user = (text: string) => ({ role: 'user' as const, text });
// The first round as prepareHunt builds it, around a stand-in protocol.
const firstHuntRound = (protocol: string, request: HuntRequest) =>
  prepareHunt(request, async () => ({ found: true, content: protocol }), {
    subagentsAllowed: false,
  });
const answer = (text: string) => ({ role: 'assistant' as const, text });

function contextWith(running = false) {
  return {
    command: vi.fn(async () => ({})),
    prefs: {},
    running,
    stopHunt: vi.fn((): string | null => 'stopping'),
    openHelp: vi.fn(),
    openPrompts: vi.fn(),
    openContext: vi.fn(),
    stop: vi.fn(),
    toggleEnhance: vi.fn(),
    openSettings: vi.fn(),
    openQueue: vi.fn(() => true),
    setMode: vi.fn(),
    navigate: vi.fn(),
    notify: vi.fn(),
    fail: vi.fn(),
  } satisfies DesktopCommandContext;
}

describe('desktop hunt commands', () => {
  it('lists every hunt once under its WebUI command, with the WebUI aliases', () => {
    expect(HUNT_COMMANDS.map((hunt) => hunt.name)).toEqual([
      '/bughunt',
      '/sechunt',
      '/racehunt',
      '/debloat',
      '/uipolish',
      '/typehunt',
      '/testgap',
    ]);
    expect(parseDesktopCommand('/secproof')?.command).toMatchObject({
      name: '/sechunt',
      action: 'hunt',
      hunt: 'sechunt',
    });
    expect(parseDesktopCommand('/FLAKEHUNT')?.command?.hunt).toBe('racehunt');
  });

  it('starts a hunt with its rounds and scope, and refuses while a turn runs', () => {
    expect(runDesktopCommand('/bughunt --rounds 3 packages/core', contextWith())).toEqual({
      kind: 'hunt',
      request: { mode: 'bughunt', maxBugs: 3, scope: 'packages/core' },
    });
    expect(runDesktopCommand('/deadcode', contextWith())).toEqual({
      kind: 'hunt',
      request: { mode: 'debloat', maxBugs: 1, scope: '' },
    });
    expect(runDesktopCommand('/bughunt --rounds 11', contextWith())).toMatchObject({
      kind: 'refused',
    });
    expect(runDesktopCommand('/sechunt', contextWith(true))).toMatchObject({ kind: 'refused' });
  });

  it('answers help and stop without sending anything', () => {
    const context = contextWith(true);
    expect(runDesktopCommand('/typehunt help', context)).toEqual({ kind: 'handled' });
    expect(context.notify).toHaveBeenLastCalledWith(
      expect.stringContaining('Usage: /typehunt [--rounds 1..10] [scope]'),
    );
    expect(runDesktopCommand('/typehunt stop', context)).toEqual({ kind: 'handled' });
    expect(context.stopHunt).toHaveBeenCalledOnce();
    expect(context.notify).toHaveBeenLastCalledWith('stopping');
  });
});

describe('desktop hunt rounds', () => {
  const request = { mode: 'sechunt' as const, maxBugs: 2 as const, scope: 'src/auth' };

  it('marks the first round with the WebUI metadata and the desktop run rules', async () => {
    const text = await firstHuntRound('PROTOCOL', request);
    expect(parseBugHuntMessage(text)).toEqual({
      scope: 'src/auth',
      maxBugs: 2,
      currentRound: 1,
      mode: 'sechunt',
    });
    expect(text).toContain('PROTOCOL\n\n## desktop run configuration (mandatory)');
    expect(text).toContain('This is round 1/2.');
  });

  it('continues from the latest prompt until the last round', async () => {
    const messages = [
      user('earlier'),
      user(await firstHuntRound('P', request)),
      answer('round report'),
    ];
    const round = latestHuntRound(messages);
    expect(round?.currentRound).toBe(1);
    const second = nextHuntRound(round!);
    expect(second && parseBugHuntMessage(second)).toMatchObject({ currentRound: 2, maxBugs: 2 });
    expect(nextHuntRound(parseBugHuntMessage(second!)!)).toBeNull();
    expect(latestHuntRound([...messages, user('something else')])).toBeUndefined();
  });

  it('stops a running hunt after its round and ends one waiting between rounds', async () => {
    const messages = [user(await firstHuntRound('P', request))];
    const state = { messages, sessionId: 'stop-a', running: true };
    expect(huntContinues(state)).toBe(true);
    expect(requestHuntStop(state)).toContain('stops after round 1/2 finishes');
    expect(huntStopped('stop-a')).toBe(true);
    expect(huntContinues(state)).toBe(false);
    expect(requestHuntStop(state)).toBeNull();
    clearHuntStop('stop-a');
    expect(requestHuntStop({ ...state, sessionId: 'stop-b', running: false })).toContain(
      'ended after round 1/2',
    );
    const last = [user(nextHuntRound(parseBugHuntMessage(messages[0]!.text)!)!)];
    expect(requestHuntStop({ messages: last, sessionId: 'stop-c', running: false })).toBeNull();
  });

  it('turns subagents off, reads the builtin protocol and refuses a missing one', async () => {
    const command = vi.fn(async (type: string) =>
      type === 'prompts.content' ? { found: true, content: '  PROTOCOL  ' } : {},
    );
    const text = await prepareHunt(request, command, { subagentsAllowed: true });
    expect(command.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      ['prefs.update', { subagentsAllowed: false, subagentCompanionsAllowed: true }],
      ['prompts.content', { slug: 'proof-driven-security-hardener' }],
    ]);
    expect(text).toContain('PROTOCOL\n\n## desktop run configuration');
    const solo = vi.fn(async () => ({ found: false }));
    await expect(prepareHunt(request, solo, { subagentsAllowed: false })).rejects.toThrow(
      'did not start',
    );
    expect(solo).toHaveBeenCalledOnce();
  });

  it('shows a round as a card instead of its protocol text', async () => {
    const html = renderToStaticMarkup(
      createElement(HuntRoundCard, {
        round: parseBugHuntMessage(await firstHuntRound('P', request))!,
      }),
    );
    expect(html).toContain('Proof-Driven Security Hardener');
    expect(html).toContain('Round 1 of 2');
    expect(html).toContain('src/auth and below');
    expect(html).not.toContain('desktop run configuration');
  });
});
