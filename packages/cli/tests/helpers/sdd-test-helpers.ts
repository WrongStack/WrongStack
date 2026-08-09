import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskNode } from '@wrongstack/core/types';
import { AISpecBuilder, DefaultTaskStore, SpecStore, TaskTracker } from '@wrongstack/sdd';
import { sddState } from '../../src/services/sdd/state.js';

/**
 * Create a minimal TaskNode fixture. The `description` and `type` fields
 * are required by the TaskNode interface and always populated here to
 * avoid test-typecheck failures (TS6059 / release gate).
 */
export function taskNode(
  id: string,
  title: string,
  status: TaskNode['status'] = 'pending',
): TaskNode {
  return {
    id,
    title,
    description: '',
    type: 'feature',
    status,
    priority: 'medium',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: [],
  };
}

/**
 * Create a TaskTracker with a minimal graph containing the given nodes.
 * @param nodes  Each entry is `[id, title, status?]`.
 * @returns The newly created TaskTracker (already registered via sddState.setTaskTracker).
 */
export function createMockTracker(
  nodes: Array<[id: string, title: string, status?: TaskNode['status']]>,
): TaskTracker {
  const store = new DefaultTaskStore();
  const tracker = new TaskTracker({ store });
  tracker.setGraph({
    id: 'test-graph',
    specId: 'test-spec',
    title: 'Test',
    nodes: new Map(
      nodes.map(([id, title, status]) => [id, taskNode(id, title, status ?? 'pending')]),
    ),
    edges: [],
    rootNodes: nodes.map(([id]) => id),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  sddState.setTaskTracker(tracker);
  return tracker;
}

/**
 * Create a minimal SDD session directory structure under `tmpDir` and
 * return a configured AISpecBuilder that has already been injected via
 * sddState.setBuilder. The session has a draft spec set, so
 * `sddState.getBuilder()` will find it immediately.
 *
 * @param title      Spec title
 * @param tmpDir     Temp directory (the helper creates .wrongstack/ under it)
 * @returns The created AISpecBuilder instance
 */
export async function createTestSddSession(title: string, tmpDir: string): Promise<AISpecBuilder> {
  const specsDir = path.join(tmpDir, '.wrongstack', 'specs');
  const sessionsDir = path.join(tmpDir, '.wrongstack', 'sessions');
  await fs.mkdir(specsDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });
  const store = new SpecStore({ baseDir: specsDir });
  const builder = new AISpecBuilder({
    store,
    projectContext: 'test project',
    sessionPath: path.join(sessionsDir, 'session.json'),
  });
  builder.setSpec({
    id: 'test-spec',
    title,
    version: '1.0.0',
    status: 'draft',
    overview: '',
    sections: [],
    requirements: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await builder.saveSession();
  sddState.setBuilder(builder);
  return builder;
}
