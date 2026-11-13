import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { type ContentRouteContext, handleContentRoute } from '../src/server/content-routes.js';

it.each([
  'design.list',
  'design.state',
  'design.use',
  'design.swap',
  'design.set',
  'design.tune',
  'design.materialize',
  'design.verify',
  'design.draw',
  'design.photos',
  'design.snapshot',
  'design.kept',
])('correlates the real %s result and preserves session ownership', async (type) => {
  const base = resolve(tmpdir()),
    dir = mkdtempSync(join(base, 'content-design-correlation-'));
  const frames: { type: string; payload: Record<string, unknown> }[] = [];
  const socket = {
    readyState: 1,
    send(this: unknown, value: string) {
      expect(this).toBe(socket);
      frames.push(JSON.parse(value));
    },
  };
  const context = {
    getProjectRoot: () => dir,
    getSkillsContext: () => {
      throw Error('Not skills');
    },
    getPromptsContext: () => {
      throw Error('Not prompts');
    },
    getDesignContext: () => ({ projectRoot: dir, agentMeta: { meta: {} } }),
  } satisfies ContentRouteContext;
  try {
    await handleContentRoute(
      context,
      socket as unknown as WebSocket,
      {
        type,
        payload: {
          requestId: `request-${type}`,
          sessionId: 'native-project-service',
          kit: 'missing-native-design-kit',
          overrides: { primary: '#112233' },
          tune: { radius: 'md' },
        },
      } as never,
    );
    const result = frames.find((frame) => frame.type === type)?.payload;
    expect(result?.['requestId']).toBe(`request-${type}`);
    expect(result?.['sessionId']).toBe('native-project-service');
    if (!['design.list', 'design.state', 'design.draw', 'design.snapshot'].includes(type)) {
      expect(result?.['ok']).toBe(false);
    }
  } finally {
    expect(dir.startsWith(base + sep)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
