import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startWebUILiveStatusLogger } from '../src/server/webui-status-logger.js';

describe('startWebUILiveStatusLogger', () => {
  it('formats active sessions and running agents correctly', async () => {
    const events = new EventEmitter();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const sessions = [
      {
        id: 'sess_abc123',
        model: 'claude-3-5-sonnet',
        provider: 'anthropic',
        isRunning: true,
      },
      {
        id: 'sess_def456',
        model: 'glm-5.3',
        provider: 'zai',
        isRunning: false,
      },
    ];

    const stop = startWebUILiveStatusLogger({
      events,
      getSessionList: () => sessions,
    });

    events.emit('agent_spawned', {
      agentId: 'sub_1',
      role: 'coder',
      sessionId: 'sess_abc123',
    });

    events.emit('iteration_started', {
      index: 2,
      maxIterations: 10,
      sessionId: 'sess_abc123',
    });

    // Wait for debounced logger
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(consoleSpy).toHaveBeenCalled();
    const loggedText = consoleSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(loggedText).toContain('sess_abc123');
    expect(loggedText).toContain('anthropic / claude-3-5-sonnet');
    expect(loggedText).toContain('RUNNING');
    expect(loggedText).toContain('iter 2/10');
    expect(loggedText).toContain('coder');
    expect(loggedText).toContain('sess_def456');

    stop();
    consoleSpy.mockRestore();
  });
});
