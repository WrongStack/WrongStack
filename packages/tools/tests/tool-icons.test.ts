import { describe, expect, it } from 'vitest';
import {
  getToolIcon,
  TOOL_ICON_CONFIG,
  TOOL_ICON_MAP,
  type ToolIconId,
} from '../src/tool-icons.js';

const expectedIconIds: readonly ToolIconId[] = [
  'file',
  'edit',
  'search',
  'folder',
  'terminal',
  'web',
  'git',
  'tree',
  'code',
  'test',
  'package',
  'document',
  'scaffold',
  'todo',
  'plan',
  'task',
  'meta',
  'index',
  'json',
  'diff',
  'logs',
  'settings',
  'brain',
  'fallback',
];

describe('tool-icons', () => {
  it('resolves known builtin tools to their canonical icon ids', () => {
    expect(getToolIcon('read')).toBe('file');
    expect(getToolIcon('write')).toBe('file');
    expect(getToolIcon('edit')).toBe('edit');
    // patch aligns with patchTool's own `icon: 'edit'`
    expect(getToolIcon('patch')).toBe('edit');
    expect(getToolIcon('grep')).toBe('search');
    // glob aligns with globTool's own `icon: 'folder'`
    expect(getToolIcon('glob')).toBe('folder');
    expect(getToolIcon('bash')).toBe('terminal');
    expect(getToolIcon('fetch')).toBe('web');
    expect(getToolIcon('git')).toBe('git');
    expect(getToolIcon('typecheck')).toBe('code');
    expect(getToolIcon('test')).toBe('test');
  });

  it('resolves common aliases emitted by models and surfaces', () => {
    expect(getToolIcon('cat')).toBe('file');
    expect(getToolIcon('str_replace')).toBe('edit');
    expect(getToolIcon('ripgrep')).toBe('search');
    expect(getToolIcon('find')).toBe('search');
    expect(getToolIcon('set_working_dir')).toBe('folder');
    expect(getToolIcon('web_search')).toBe('web');
    expect(getToolIcon('tool_use')).toBe('meta');
    expect(getToolIcon('batch_tool_use')).toBe('meta');
    expect(getToolIcon('search_memory')).toBe('brain');
    expect(getToolIcon('lsp_diagnostics')).toBe('code');
    expect(getToolIcon('lsp_definition')).toBe('search');
    expect(getToolIcon('lsp_rename')).toBe('edit');
  });

  it('performs case-insensitive lookups', () => {
    expect(getToolIcon('READ')).toBe('file');
    expect(getToolIcon('BaSh')).toBe('terminal');
    expect(getToolIcon('WEB_FETCH')).toBe('web');
    expect(getToolIcon('Tool_Help')).toBe('meta');
  });

  it('falls back for unknown, plugin, mcp, and empty tool names', () => {
    expect(getToolIcon('')).toBe('fallback');
    expect(getToolIcon('not-a-real-tool')).toBe('fallback');
    expect(getToolIcon('mcp__github__create_issue')).toBe('fallback');
    expect(getToolIcon('custom_plugin_tool')).toBe('fallback');
  });

  it('keeps every mapped icon id backed by a color config entry', () => {
    for (const iconId of Object.values(TOOL_ICON_MAP)) {
      expect(TOOL_ICON_CONFIG[iconId], iconId).toBeDefined();
      expect(TOOL_ICON_CONFIG[iconId]?.color, iconId).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('keeps the config exhaustive for the ToolIconId set', () => {
    expect(Object.keys(TOOL_ICON_CONFIG).sort()).toEqual([...expectedIconIds].sort());
  });
});
