import { describe, expect, it } from 'vitest';
import { formatAcpAgentList } from '../src/acp-agent-list.js';

describe('formatAcpAgentList', () => {
  it('labels the bundled catalog when no registry cache exists', () => {
    const text = formatAcpAgentList({
      live: null,
      detected: [
        { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true, version: '0.59.0' },
        { id: 'goose', displayName: 'Goose', installed: false, reason: 'binary not found' },
      ] as never,
    });
    expect(text).toContain('Bundled offline catalog');
    expect(text).toContain('/acp sync');
    expect(text).toContain('gemini-cli');
    expect(text).toContain('1 of 2 bundled agents installed locally');
    expect(text).not.toContain('Official ACP registry');
  });

  it('renders synced registry ids as the primary list', () => {
    const text = formatAcpAgentList({
      live: {
        fetchedAt: '2026-09-09T12:00:00.000Z',
        byId: {
          gemini: { command: 'gemini', args: ['--acp'] },
          'grok-build': { command: 'npx', args: ['-y', '@xai-official/grok@1.0.24'] },
          'claude-acp': { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
        },
        agents: [
          { id: 'gemini', displayName: 'Gemini CLI', acp: { command: 'gemini', args: ['--acp'] } },
          {
            id: 'grok-build',
            displayName: 'Grok Build',
            acp: { command: 'npx', args: ['-y', '@xai-official/grok@1.0.24'] },
          },
          {
            id: 'claude-acp',
            displayName: 'Claude Agent',
            acp: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
          },
        ] as never,
      },
      detected: [
        { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true, version: '0.59.0' },
        { id: 'openhands', displayName: 'OpenHands', installed: false, reason: 'binary not found' },
      ] as never,
    });
    expect(text).toContain('Official ACP registry — 3 agents');
    expect(text).toContain('grok-build');
    expect(text).toContain('claude-acp');
    expect(text).toContain('(also claude-code)');
    expect(text).toContain('gemini');
    expect(text).toContain('0.59.0');
    expect(text).toContain('Bundled extras');
    expect(text).toContain('openhands');
    expect(text).not.toContain('bundled agents installed locally');
  });
});
