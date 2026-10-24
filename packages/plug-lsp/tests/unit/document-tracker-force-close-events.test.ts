import * as path from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import type { LSPServer } from '../../src/server/lsp-server.js';

function makeServer(name: string, state: 'ready' | 'starting' = 'ready'): LSPServer {
  return {
    name,
    state,
    config: { languages: ['typescript'] },
    notifyDidOpen: () => {},
    notifyDidChange: () => {},
    notifyDidClose: () => {},
  } as unknown as LSPServer;
}

describe('DocumentTracker.forceCloseAll event emission', () => {
  it('emits lsp.document.closed exactly once per tracked document regardless of ready server count', async () => {
    const closedPaths: string[] = [];
    const didCloseCalls: Array<{ server: string; uri: string }> = [];
    const events = {
      emit(event: string, payload: { path: string }) {
        if (event === 'lsp.document.closed') closedPaths.push(path.basename(payload.path));
      },
    } as unknown as EventBus;

    const log = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger;

    const s1 = makeServer('ts-1', 'ready');
    const s2 = makeServer('ts-2', 'ready');
    s1.notifyDidClose = (uri: string) => didCloseCalls.push({ server: 'ts-1', uri });
    s2.notifyDidClose = (uri: string) => didCloseCalls.push({ server: 'ts-2', uri });

    let servers: LSPServer[] = [s1, s2];
    const tracker = new DocumentTracker(
      () => ({ list: () => servers }),
      log,
      process.cwd(),
      events,
    );

    await tracker.open('/workspace/a.ts', 'const a = 1;\n');
    servers = [makeServer('ts-1', 'starting'), makeServer('ts-2', 'starting')];
    await tracker.open('/workspace/b.ts', 'const b = 2;\n');
    servers = [s1, s2];

    await tracker.forceCloseAll();
    expect(closedPaths).toEqual(['a.ts', 'b.ts']);
    expect(didCloseCalls).toHaveLength(2);
  });
});
