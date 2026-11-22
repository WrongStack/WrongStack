import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestScopedEntries,
  stageDeferredToolSchema,
} from '../../src/core/request-scoped-context.js';
import { providerToolsForVariant } from '../../src/registry/scout-tool-surface.js';
import {
  sessionToolCatalog,
  sessionToolGroupState,
  setProjectToolGroup,
  setSessionToolGroup,
} from '../../src/registry/session-tool-groups.js';
import { ToolRegistry } from '../../src/registry/tool-registry.js';
import { resolveWstackPaths } from '../../src/utils/wstack-paths.js';
import { removeProjectFixtureDirectory } from '../helpers/project-server-harness.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'quick-group-defaults-'));
  vi.stubEnv('WRONGSTACK_HOME', join(root, 'user-state'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeProjectFixtureDirectory(root);
});

const quick = (projectRoot: string) => ({ projectRoot, meta: { systemPromptVariant: 'quick' } });

const tool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  permission: 'auto',
  mutating: false,
  async execute() {},
});

describe('Quick tool group defaults', () => {
  it('persists concurrent changes without overriding a different project or an explicit session choice', async () => {
    const project = join(root, 'project');
    const ctx = quick(project);
    const other = quick(join(root, 'other'));
    setSessionToolGroup(ctx, 'browser', 'off');
    await Promise.all([
      setProjectToolGroup(quick(project), 'browser', 'on'),
      setProjectToolGroup(quick(project), 'kanban', 'on'),
    ]);
    expect(sessionToolGroupState(quick(project), 'browser')).toMatchObject({
      source: 'project',
      enabled: true,
    });
    expect(sessionToolGroupState(quick(project), 'kanban')).toMatchObject({
      source: 'project',
      enabled: true,
    });
    expect(sessionToolGroupState(ctx, 'browser')).toMatchObject({
      source: 'session',
      enabled: false,
    });
    expect(sessionToolGroupState(other, 'browser').enabled).toBe(false);
    expect(setSessionToolGroup(ctx, 'browser', 'inherit')).toMatchObject({
      source: 'project',
      enabled: true,
    });
    await setProjectToolGroup(ctx, 'browser', 'auto');
    expect(sessionToolGroupState(quick(project), 'browser')).toMatchObject({
      mode: 'auto',
      enabled: false,
    });
  });

  it('ignores repository-supplied preferences and preserves an unreadable owner file', async () => {
    const projectRoot = join(root, 'project');
    const paths = resolveWstackPaths({ projectRoot });
    await mkdir(join(projectRoot, '.wrongstack'), { recursive: true });
    const on = JSON.stringify({ version: 1, groups: { browser: 'on' } });
    await writeFile(join(projectRoot, '.wrongstack', 'quick-tool-groups.json'), on);
    const ctx = quick(projectRoot);
    expect(sessionToolGroupState(ctx, 'browser').enabled).toBe(false);
    await mkdir(paths.projectDir, { recursive: true });
    const file = join(paths.projectDir, 'quick-tool-groups.json');
    const invalid = '{"version":2,"groups":{"browser":"on"}}';
    await writeFile(file, invalid);
    expect(sessionToolGroupState(ctx, 'browser')).toMatchObject({
      enabled: false,
      reason: expect.any(String),
    });
    await expect(setProjectToolGroup(ctx, 'browser', 'on')).rejects.toThrow(
      'Invalid Quick tool group settings',
    );
    expect(await readFile(file, 'utf8')).toBe(invalid);
  });

  it('filters late integration tools and keeps the direct Quick list byte-identical', () => {
    const ctx = quick(join(root, 'project'));
    const registry = new ToolRegistry();
    for (const name of ['read', 'tool_search', 'tool_use', 'browser_open', 'tool_script']) {
      registry.register(tool(name));
    }
    const direct = JSON.stringify(providerToolsForVariant(registry, 'quick'));
    setSessionToolGroup(ctx, 'browser', 'on');
    registry.register(tool('mcp__late__inspect'));
    expect(sessionToolCatalog(ctx, registry.list()).map((entry) => entry.name)).toEqual([
      'read',
      'tool_search',
      'tool_use',
      'browser_open',
    ]);
    setSessionToolGroup(ctx, 'mcp', 'on');
    expect(sessionToolCatalog(ctx, registry.list()).map((entry) => entry.name)).toContain(
      'mcp__late__inspect',
    );
    setSessionToolGroup(ctx, 'browser', 'off');
    expect(sessionToolCatalog(ctx, registry.list()).map((entry) => entry.name)).not.toContain(
      'browser_open',
    );
    expect(JSON.stringify(providerToolsForVariant(registry, 'quick'))).toBe(direct);
  });

  it('uses the registered server identity for late tools and lets an explicit parent Off win', async () => {
    const projectRoot = join(root, 'project');
    const ctx = quick(projectRoot);
    const gateway = tool('mcp_use');
    const selected = { ...tool('mcp__team__prod__inspect'), mcpServerName: 'team__prod' };
    const sibling = { ...tool('mcp__team__prod__other'), mcpServerName: 'team' };
    await setProjectToolGroup(ctx, 'mcp:team__prod', 'on');
    const fresh = quick(projectRoot);
    expect(sessionToolCatalog(fresh, [gateway, selected, sibling])).toEqual([gateway, selected]);
    setSessionToolGroup(fresh, 'mcp', 'on');
    setSessionToolGroup(fresh, 'mcp:team', 'off');
    expect(sessionToolCatalog(fresh, [gateway, selected, sibling])).toEqual([gateway, selected]);
    setSessionToolGroup(fresh, 'mcp', 'off');
    expect(sessionToolCatalog(fresh, [gateway, selected, sibling])).toEqual([]);
  });

  it('invalidates a pending MCP schema across a parent Off and On', () => {
    const selected = { ...tool('mcp__fixture__lookup'), mcpServerName: 'fixture' };
    const ctx = {
      ...quick(join(root, 'project')),
      tools: [tool('tool_use')],
      catalogTools: [selected],
    };
    setSessionToolGroup(ctx, 'mcp:fixture', 'on');
    stageDeferredToolSchema(ctx, selected);
    expect(requestScopedEntries(ctx)).toHaveLength(1);
    setSessionToolGroup(ctx, 'mcp', 'off');
    expect(requestScopedEntries(ctx)).toEqual([]);
    setSessionToolGroup(ctx, 'mcp', 'on');
    expect(requestScopedEntries(ctx)).toEqual([]);
  });
});
