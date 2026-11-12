import type { Logger } from '@wrongstack/contracts/types';
import { PluginUiRegistry } from '@wrongstack/core/plugin';
import { describe, expect, it, vi } from 'vitest';
import { createPluginUiWsBridge } from '../src/server/plugin-ui-ws-bridge.js';
import type { WSServerMessage } from '../src/server/types.js';

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => makeLogger(),
  } as unknown as Logger;
}

describe('createPluginUiWsBridge', () => {
  it('pushes plugin.ui.updated, plugin.ui.notify, and interactive plugin.ui.prompt frames over WebSocket', async () => {
    const registry = new PluginUiRegistry({ throttleMs: 0 });
    const frames: WSServerMessage[] = [];
    const logger = makeLogger();
    const bridge = createPluginUiWsBridge({
      registry,
      broadcast: (msg) => frames.push(msg),
      logger,
    });

    const chip = registry.registerStatusChip('deploy-guard', {
      id: 'health',
      text: 'healthy',
      tone: 'success',
    });
    expect(frames.some((f) => f.type === 'plugin.ui.updated')).toBe(true);

    registry.notify('deploy-guard', 'Canary rollout 100%', 'warning');
    const notifyFrame = frames.find((f) => f.type === 'plugin.ui.notify');
    expect(notifyFrame?.payload).toEqual({
      owner: 'deploy-guard',
      message: 'Canary rollout 100%',
      tone: 'warning',
    });

    const promptPromise = registry.prompt(
      'deploy-guard',
      {
        kind: 'select',
        title: 'Select region',
        options: [
          { value: 'eu', label: 'EU' },
          { value: 'us', label: 'US' },
        ],
      },
      new AbortController().signal,
    );

    const promptFrame = frames.find((f) => f.type === 'plugin.ui.prompt');
    expect(promptFrame).toBeDefined();
    const requestId = (promptFrame?.payload as { requestId?: string } | undefined)?.requestId ?? '';
    expect(requestId).toBeTruthy();

    expect(
      bridge.handleClientMessage({
        type: 'plugin.ui.prompt_response',
        payload: { requestId, value: 'eu' },
      }),
    ).toBe(true);

    await expect(promptPromise).resolves.toBe('eu');
    expect(frames.some((f) => f.type === 'plugin.ui.prompt_resolved')).toBe(true);

    // Abort / dispose settles in-flight prompts with null cleanly
    const pendingAbort = registry.prompt(
      'deploy-guard',
      { kind: 'confirm', title: 'Approve?' },
      new AbortController().signal,
    );
    bridge.dispose();
    await expect(pendingAbort).resolves.toBeNull();
    chip.dispose();
  });

  it('correlates Desktop EngineCommand requestId separately from promptId on plugin.ui.prompt_response', async () => {
    const registry = new PluginUiRegistry({ throttleMs: 0 });
    const frames: WSServerMessage[] = [];
    const bridge = createPluginUiWsBridge({
      registry,
      broadcast: (msg) => frames.push(msg),
      logger: makeLogger(),
    });

    const confirmPromise = registry.prompt(
      'deploy-guard',
      { kind: 'confirm', title: 'Proceed with canary?' },
      new AbortController().signal,
    );
    const promptFrame = frames.find((f) => f.type === 'plugin.ui.prompt');
    const promptId = (promptFrame?.payload as { promptId?: string } | undefined)?.promptId ?? '';
    expect(promptId).toBeTruthy();

    expect(
      bridge.handleClientMessage({
        type: 'plugin.ui.prompt_response',
        payload: { promptId, requestId: 'desktop-rpc-corr-42', value: true },
      }),
    ).toBe(true);

    await expect(confirmPromise).resolves.toBe(true);
    const resolvedFrame = frames.find((f) => f.type === 'plugin.ui.prompt_resolved');
    expect(resolvedFrame?.payload).toEqual({
      requestId: 'desktop-rpc-corr-42',
      promptId,
    });
    bridge.dispose();
  });
});
