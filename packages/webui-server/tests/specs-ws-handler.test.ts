import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskGraph } from '@wrongstack/core/types';
import { SpecStore, TaskGraphStore } from '@wrongstack/sdd';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecsWebSocketHandler } from '../src/server/specs-ws-handler.js';

describe('SpecsWebSocketHandler', () => {
  const baseDir = join(tmpdir(), `specs-ws-test-${Date.now()}`);
  const specsDir = join(baseDir, 'specs');
  const graphsDir = join(baseDir, 'graphs');

  beforeEach(() => {
    mkdirSync(specsDir, { recursive: true });
    mkdirSync(graphsDir, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(baseDir, { recursive: true, force: true });
    } catch {}
  });

  it('manages clients, handles specs.list, specs.get, and specs.taskStatus updates', async () => {
    const specStore = new SpecStore({ baseDir: specsDir });
    const graphStore = new TaskGraphStore({ baseDir: graphsDir });

    const spec: import('@wrongstack/core/types').Specification = {
      id: 'spec-01',
      title: 'Auth Spec',
      overview: 'Authentication system',
      status: 'approved',
      version: '1.0.0',
      sections: [],
      requirements: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await specStore.save(spec);

    const graph: TaskGraph = {
      id: 'graph-01',
      specId: spec.id,
      title: 'Auth Tasks',
      nodes: new Map([
        [
          't1',
          {
            id: 't1',
            title: 'Setup DB',
            description: 'Create tables',
            type: 'chore',
            status: 'completed',
            priority: 'high',
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        [
          't2',
          {
            id: 't2',
            title: 'Write API',
            description: 'Create routes',
            type: 'feature',
            status: 'pending',
            priority: 'medium',
            createdAt: 2000,
            updatedAt: 2000,
          },
        ],
      ]),
      edges: [
        {
          id: 'e1',
          from: 't1',
          to: 't2',
          type: 'depends_on',
        },
      ],
      rootNodes: ['t1'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await graphStore.save(graph);

    const handler = new SpecsWebSocketHandler(specsDir, graphsDir);

    const sentMessages: string[] = [];
    const mockWs = new EventEmitter() as unknown as import('ws').WebSocket;
    Object.defineProperty(mockWs, 'readyState', { value: 1 });
    mockWs.send = vi.fn((data: string) => {
      sentMessages.push(data);
    });

    handler.addClient(mockWs);

    // Initial list sent on connect
    await new Promise((r) => setTimeout(r, 20));
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(sentMessages[0]).toContain('specs.list');

    // Handle specs.list
    sentMessages.length = 0;
    await handler.handleMessage({ type: 'specs.list' });
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('Auth Spec');

    // Handle specs.get for existing spec
    sentMessages.length = 0;
    await handler.handleMessage({ type: 'specs.get', payload: { specId: spec.id } });
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('specs.detail');
    expect(sentMessages[0]).toContain('Setup DB');

    // Handle specs.get for nonexistent spec
    sentMessages.length = 0;
    await handler.handleMessage({ type: 'specs.get', payload: { specId: 'non-existent' } });
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toContain('"notFound":true');

    // Handle specs.taskStatus validation errors
    await expect(
      handler.handleMessage({
        type: 'specs.taskStatus',
        payload: { graphId: 'g1', taskId: 't1', status: 'invalid-status' },
      }),
    ).rejects.toThrow('Invalid task status');

    await expect(
      handler.handleMessage({
        type: 'specs.taskStatus',
        payload: { graphId: null, taskId: 't1', status: 'completed' },
      }),
    ).rejects.toThrow('requires string graphId and taskId');

    // Handle valid specs.taskStatus update
    sentMessages.length = 0;
    await handler.handleMessage({
      type: 'specs.taskStatus',
      payload: { graphId: 'graph-01', taskId: 't2', status: 'in_progress' },
    });
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    expect(sentMessages.some((m) => m.includes('specs.list'))).toBe(true);

    // Client close removes client
    mockWs.emit('close');
    handler.dispose();
  });
});
