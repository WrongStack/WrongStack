/**
 * Tests for chronicle/project-access.ts — resolveChronicleProjectServerOptions
 * and createChronicleProjectAccess inline mode.
 */
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
} from '../../src/chronicle/project-access.js';

describe('resolveChronicleProjectServerOptions', () => {
  it('resolves from explicit projectPaths', () => {
    const opts = resolveChronicleProjectServerOptions({
      projectRoot: '/my/project',
      projectPaths: {
        globalRoot: '/global',
        projectId: 'proj-123',
        projectDir: '/global/projects/proj-123',
        workspaceId: 'my-project',
      },
    });
    expect(opts.projectRoot).toBe(path.resolve('/my/project'));
    expect(opts.globalRoot).toBe('/global');
    expect(opts.projectId).toBe('proj-123');
    expect(opts.workspaceId).toBe('my-project');
  });

  it('resolves from wstack paths when no projectPaths', () => {
    const opts = resolveChronicleProjectServerOptions({
      projectRoot: '/my/project',
      userHome: '/home/testuser',
    });
    expect(opts.projectRoot).toBe(path.resolve('/my/project'));
    expect(opts.globalRoot).toBeDefined();
    expect(opts.projectId).toBeDefined();
    expect(opts.projectDir).toBeDefined();
    expect(opts.workspaceId).toBeDefined();
  });

  it('passes through retentionDays when set', () => {
    const opts = resolveChronicleProjectServerOptions({
      projectRoot: '/my/project',
      projectPaths: {
        globalRoot: '/g',
        projectId: 'p',
        projectDir: '/g/p',
        workspaceId: 'w',
      },
      retentionDays: 30,
    });
    expect(opts.retentionDays).toBe(30);
  });

  it('omits retentionDays when not set', () => {
    const opts = resolveChronicleProjectServerOptions({
      projectRoot: '/my/project',
      projectPaths: {
        globalRoot: '/g',
        projectId: 'p',
        projectDir: '/g/p',
        workspaceId: 'w',
      },
    });
    expect(opts.retentionDays).toBeUndefined();
  });
});

describe('createChronicleProjectAccess — inline mode', () => {
  it('returns inline access when no project server is available', () => {
    // In test environment, the project server is not available
    const access = createChronicleProjectAccess({
      projectRoot: '/tmp/test-project',
      userHome: '/tmp/test-home',
    });
    expect(access.mode).toBe('inline');
  });

  it('ping returns health info', async () => {
    const access = createChronicleProjectAccess({
      projectRoot: '/tmp/test-project',
      userHome: '/tmp/test-home',
    });
    const health = await access.call('ping', {});
    expect(health).toBeDefined();
    expect(health.endpoint).toBe('inline');
    expect(health.pid).toBe(process.pid);
    expect(health.protocolVersion).toBeDefined();
    await access.close();
  });
});
