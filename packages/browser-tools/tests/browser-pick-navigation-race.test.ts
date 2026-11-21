import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserSessionManager } from '../src/manager.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(phase: 'stable' | 'screenshot' | 'title') {
  const manager = new BrowserSessionManager({
    artifactRoot: path.join(os.tmpdir(), `browser-pick-${phase}`),
  });
  const entered = deferred();
  const release = deferred();
  let currentUrl = 'https://old.example/page';
  const waitAt = async (at: 'screenshot' | 'title') => {
    if (phase !== at) return;
    entered.resolve();
    await release.promise;
  };
  const page = {
    url: () => currentUrl,
    evaluate: async () => ({
      selector: '#submit',
      tag: 'button',
      role: 'button',
      text: 'Submit',
      styles: {},
      bounds: { x: 10, y: 10, width: 80, height: 30 },
      viewport: { width: 800, height: 600 },
    }),
    screenshot: async () => {
      await waitAt('screenshot');
      return Buffer.from([0xff, 0xd8, 0xff]);
    },
    title: async () => {
      await waitAt('title');
      return currentUrl.includes('new.example') ? 'New page' : 'Old page';
    },
  };
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set('browser-1', {
    id: 'browser-1',
    ownerId: 'leader',
    conversationId: 'conversation-1',
    page,
    context: { close: async () => undefined },
    createdAt: new Date(0).toISOString(),
    lastUsedAt: new Date(0).toISOString(),
    tracing: false,
    console: [],
    network: [],
    viewers: new Set(),
  });
  return {
    manager,
    entered: entered.promise,
    navigate() {
      currentUrl = 'https://new.example/page';
      release.resolve();
    },
  };
}

const point = { x: 0.5, y: 0.5, url: 'https://old.example/page' };

describe('browser element selection navigation fencing', () => {
  it('returns a coherent selection while the page stays stable', async () => {
    const { manager } = fixture('stable');
    await expect(manager.pickElement('browser-1', 'conversation-1', point)).resolves.toMatchObject({
      url: 'https://old.example/page',
      title: 'Old page',
      selector: '#submit',
    });
  });

  it.each(['screenshot', 'title'] as const)(
    'rejects navigation during the awaited %s capture step',
    async (phase) => {
      const gate = fixture(phase);
      const pending = gate.manager.pickElement('browser-1', 'conversation-1', point);
      await gate.entered;
      gate.navigate();
      await expect(pending).rejects.toThrow('navigated during inspection');
    },
  );
});
