import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  requestScopedEntries,
  stageDeferredToolSchema,
} from '../../src/core/request-scoped-context.js';
import {
  providerToolSurfaceForVariant,
  providerToolsForVariant,
} from '../../src/registry/scout-tool-surface.js';
import {
  bindSessionToolRegistry,
  sessionToolCatalog,
  sessionToolGroupState,
  setProjectToolGroup,
  setSessionToolGroup,
} from '../../src/registry/session-tool-groups.js';
import { isToolReachable } from '../../src/registry/session-tool-reach.js';
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
  it('keeps Kanban and Codebase out of new Pro requests and only discovers enabled groups', () => {
    const registry = new ToolRegistry();
    for (const name of ['tool_search', 'tool_use', 'kanban', 'kanban_queue', 'codebase-search']) {
      registry.register(tool(name));
    }
    const ctx = {
      projectRoot: root,
      meta: { systemPromptVariant: 'pro' },
      session: { providerToolSchemaVersion: 6 },
      tools: [registry.get('tool_search')!, registry.get('tool_use')!],
    };
    const direct = () =>
      providerToolSurfaceForVariant(registry, 'pro', ctx.meta, undefined, ctx.session).tools;
    bindSessionToolRegistry(ctx, registry);
    const v5 = { providerToolSchemaVersion: 5 };
    expect(providerToolSurfaceForVariant(registry, 'pro', ctx.meta, undefined, v5).tools).toEqual(
      registry.list(),
    );
    expect(direct()).toEqual(ctx.tools);
    expect(sessionToolCatalog(ctx, registry.list())).toEqual(ctx.tools);
    expect(isToolReachable(ctx, 'kanban')).toBe(false);
    expect(isToolReachable(ctx, 'codebase-search')).toBe(false);

    setSessionToolGroup(ctx, 'kanban', 'on');
    expect(sessionToolCatalog(ctx, registry.list()).map(({ name }) => name)).toEqual([
      'tool_search',
      'tool_use',
      'kanban',
      'kanban_queue',
    ]);
    setSessionToolGroup(ctx, 'codebase', 'on');
    expect(sessionToolCatalog(ctx, registry.list())).toEqual(registry.list());
    expect(direct()).toEqual(ctx.tools);
  });

  it('enables linked boards and indexed Codebase in Auto, with per-session overrides', async () => {
    const index = join(root, 'index');
    const meta = { systemPromptVariant: 'scout', codebaseIndexDir: index };
    const session = { providerToolSchemaVersion: 6 };
    const owner = { projectRoot: root, meta, session, currentKanbanBoardId: 'linked-board' };
    const other = { projectRoot: root, meta, session };
    expect(sessionToolGroupState(owner, 'kanban').enabled).toBe(true);
    expect(sessionToolGroupState(other, 'kanban').enabled).toBe(false);
    expect(sessionToolGroupState(owner, 'codebase').enabled).toBe(false);
    await mkdir(index);
    await writeFile(join(index, 'index.db'), '');
    expect(sessionToolGroupState(owner, 'codebase').enabled).toBe(true);
    expect(setSessionToolGroup(owner, 'codebase', 'off').enabled).toBe(false);
    expect(sessionToolGroupState(other, 'codebase').enabled).toBe(true);
  });

  it.each(['quick', 'pro', 'scout'])(
    'keeps a required Kanban board callable on the %s surface when tool_use is unavailable',
    (variant) => {
      const registry = new ToolRegistry();
      const names = ['tool_search', 'tool_use', 'kanban', 'kanban_queue', 'codebase-search'];
      for (const name of names) registry.register(tool(name));
      const session = { providerToolSchemaVersion: 6 };
      const meta = { systemPromptVariant: variant };
      const direct = () =>
        providerToolSurfaceForVariant(registry, variant, meta, undefined, session).tools;
      const ctx = { projectRoot: root, meta, session, tools: direct() };
      bindSessionToolRegistry(ctx, registry);
      registry.setKanbanGovernanceRequired(true);
      expect(direct().map(({ name }) => name)).toEqual(['tool_search', 'tool_use']);
      expect(() => setSessionToolGroup(ctx, 'kanban', 'off')).toThrow('requires board access');

      registry.disable('tool_use');
      ctx.tools = direct();
      expect(ctx.tools.map(({ name }) => name)).toEqual(['tool_search', 'kanban']);
      expect(isToolReachable(ctx, 'kanban')).toBe(true);
      expect(isToolReachable(ctx, 'kanban_queue')).toBe(false);
      const capped = { selectToolsForRequest: (tools: Tool[]) => tools.slice(0, 1) };
      expect(
        providerToolSurfaceForVariant(registry, variant, meta, capped, session).tools.map(
          ({ name }) => name,
        ),
      ).toEqual(['kanban']);
      registry.disable('kanban');
      expect(direct().map(({ name }) => name)).toEqual(['tool_search']);
    },
  );

  it('keeps Browser and E2E out of a new Pro request and catalog until enabled', () => {
    const registry = new ToolRegistry();
    for (const name of ['tool_search', 'tool_use', 'browser_open', 'e2e_plan']) {
      registry.register(tool(name));
    }
    const browser = registry.get('browser_open')!;
    const ctx = {
      projectRoot: root,
      meta: { systemPromptVariant: 'pro' },
      session: { providerToolSchemaVersion: 5 },
      tools: [registry.get('tool_search')!, registry.get('tool_use')!],
    };
    const direct = () =>
      providerToolSurfaceForVariant(registry, 'pro', ctx.meta, undefined, ctx.session).tools;
    bindSessionToolRegistry(ctx, registry);
    expect(direct()).toEqual(ctx.tools);
    expect(sessionToolCatalog(ctx, registry.list())).toEqual(ctx.tools);
    expect(isToolReachable(ctx, browser.name, browser)).toBe(false);

    setSessionToolGroup(ctx, 'browser', 'on');
    expect(sessionToolCatalog(ctx, registry.list())).toEqual(registry.list());
    expect(isToolReachable(ctx, browser.name, browser)).toBe(true);
    expect(direct()).toEqual(ctx.tools);

    const legacy = { ...ctx, session: { providerToolSchemaVersion: 4 } };
    expect(
      providerToolSurfaceForVariant(registry, 'pro', ctx.meta, undefined, legacy.session).tools,
    ).toEqual(registry.list());
    expect(sessionToolCatalog(legacy, registry.list())).toEqual(registry.list());
    expect(
      providerToolSurfaceForVariant(registry, 'scout', {}, undefined, {
        ...ctx.session,
        scoutLearnedTools: [browser.name],
      }).tools,
    ).toEqual(ctx.tools);

    registry.setSessionRestriction({ only: [browser.name] });
    expect(direct()).toEqual([...ctx.tools, browser]);
    expect(sessionToolCatalog(ctx, registry.list())).toEqual(direct());
  });

  it('uses the host browser default only in new non-Quick sessions', async () => {
    const registry = new ToolRegistry();
    registry.setBrowserToolsEnabled(true);
    const ctx = {
      projectRoot: root,
      meta: { systemPromptVariant: 'pro' },
      session: { providerToolSchemaVersion: 5 },
    };
    bindSessionToolRegistry(ctx, registry.clone());
    expect(sessionToolGroupState(ctx, 'browser').enabled).toBe(true);
    expect(setSessionToolGroup(ctx, 'browser', 'off').enabled).toBe(false);
    expect(setSessionToolGroup(ctx, 'browser', 'inherit').enabled).toBe(true);
    expect((await setProjectToolGroup(ctx, 'browser', 'off')).enabled).toBe(false);
    const quickCtx = quick(join(root, 'other'));
    bindSessionToolRegistry(quickCtx, registry);
    expect(sessionToolGroupState(quickCtx, 'browser').enabled).toBe(false);
  });

  it('excludes operator diagnostics from new model surfaces while retaining earlier sessions', () => {
    const registry = new ToolRegistry();
    registry.register(tool('tool_search'));
    registry.register(tool('tool_use'));
    registry.register({
      ...tool('scanner_status'),
      aliases: ['old_scan_status'],
      operatorStatus: { sinceSchemaVersion: 3, read: () => ({ scans: 3 }) },
    });
    const future = {
      ...tool('future_status'),
      operatorStatus: { sinceSchemaVersion: 4, read: () => ({ scans: 0 }) },
    };
    registry.register(future);
    const diagnostic = registry.get('old_scan_status')!;
    const latest = { providerToolSchemaVersion: 3 };
    const previous = { providerToolSchemaVersion: 2 };
    const getDirect = (variant: string, session: typeof latest, meta = {}) =>
      providerToolSurfaceForVariant(registry, variant, meta, undefined, session).tools;

    expect(getDirect('pro', previous)).toContain(diagnostic);
    expect(getDirect('pro', latest)).not.toContain(diagnostic);
    expect(getDirect('pro', latest)).toContainEqual(registry.get(future.name));
    expect(getDirect('pro', { providerToolSchemaVersion: 4 })).not.toContainEqual(
      registry.get(future.name),
    );
    expect(
      providerToolSurfaceForVariant(registry, 'scout', {}, undefined, {
        ...latest,
        scoutLearnedTools: [diagnostic.name],
      }).tools,
    ).not.toContain(diagnostic);
    expect(getDirect('pro', latest)).toBe(getDirect('pro', latest));
    const tools = getDirect('pro', latest);
    const ctx = { session: previous, activeRunSessionWriter: latest, tools };
    expect(sessionToolCatalog(ctx, registry.list())).not.toContain(diagnostic);
    expect(isToolReachable(ctx, 'old_scan_status', diagnostic)).toBe(false);
    expect(isToolReachable({ session: previous, tools }, 'old_scan_status', diagnostic)).toBe(true);
    expect(registry.get(diagnostic.name)?.operatorStatus?.read()).toEqual({ scans: 3 });
  });

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
