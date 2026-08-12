import { describe, expect, it } from 'vitest';
import {
  FALLBACK_ICON,
  TOOL_ICON_CONFIG,
  TOOL_ICON_MAP,
  getToolIcon,
} from '../src/tool-icon-map.js';

describe('tool-icon-map', () => {
  describe('getToolIcon', () => {
    it('returns the correct icon for known tool names', () => {
      expect(getToolIcon('read')).toBe('file');
      expect(getToolIcon('write')).toBe('file');
      expect(getToolIcon('edit')).toBe('edit');
      expect(getToolIcon('grep')).toBe('search');
      expect(getToolIcon('search')).toBe('search');
      expect(getToolIcon('glob')).toBe('folder');
      expect(getToolIcon('bash')).toBe('terminal');
      expect(getToolIcon('exec')).toBe('terminal');
      expect(getToolIcon('fetch')).toBe('web');
      expect(getToolIcon('git')).toBe('git');
      expect(getToolIcon('tree')).toBe('tree');
      expect(getToolIcon('lint')).toBe('code');
      expect(getToolIcon('format')).toBe('code');
      expect(getToolIcon('typecheck')).toBe('code');
      expect(getToolIcon('test')).toBe('test');
      expect(getToolIcon('install')).toBe('package');
      expect(getToolIcon('audit')).toBe('package');
      expect(getToolIcon('outdated')).toBe('package');
      expect(getToolIcon('document')).toBe('document');
      expect(getToolIcon('scaffold')).toBe('scaffold');
      expect(getToolIcon('todo')).toBe('todo');
      expect(getToolIcon('nextsteps')).toBe('todo');
      expect(getToolIcon('plan')).toBe('plan');
      expect(getToolIcon('task')).toBe('task');
      expect(getToolIcon('kanban')).toBe('task');
      expect(getToolIcon('codebase-index')).toBe('index');
      expect(getToolIcon('codebase-incoming-calls')).toBe('index');
      expect(getToolIcon('codebase-outgoing-calls')).toBe('index');
      expect(getToolIcon('dead-code-scan')).toBe('index');
      expect(getToolIcon('json')).toBe('json');
      expect(getToolIcon('diff')).toBe('diff');
      expect(getToolIcon('logs')).toBe('logs');
      expect(getToolIcon('set-working-dir')).toBe('settings');
      expect(getToolIcon('think')).toBe('brain');
      expect(getToolIcon('reason')).toBe('brain');
    });

    it('returns fallback for unknown tool names', () => {
      expect(getToolIcon('unknown-tool')).toBe('fallback');
      expect(getToolIcon('')).toBe('fallback');
      expect(getToolIcon('random')).toBe('fallback');
    });

    it('is case-insensitive', () => {
      expect(getToolIcon('READ')).toBe('file');
      expect(getToolIcon('Bash')).toBe('terminal');
      expect(getToolIcon('Git')).toBe('git');
    });

    it('handles aliases correctly', () => {
      expect(getToolIcon('create')).toBe('file');
      expect(getToolIcon('patch')).toBe('edit');
      expect(getToolIcon('replace')).toBe('edit');
      expect(getToolIcon('run')).toBe('terminal');
      expect(getToolIcon('shell')).toBe('terminal');
      expect(getToolIcon('curl')).toBe('web');
      expect(getToolIcon('ls')).toBe('tree');
      expect(getToolIcon('npm')).toBe('package');
      expect(getToolIcon('pnpm')).toBe('package');
      expect(getToolIcon('board')).toBe('task');
      expect(getToolIcon('log')).toBe('logs');
      expect(getToolIcon('cwd')).toBe('settings');
      expect(getToolIcon('cd')).toBe('settings');
      expect(getToolIcon('analyze')).toBe('brain');
      expect(getToolIcon('language')).toBe('code');
    });

    it('handles underscore variants of compound names', () => {
      expect(getToolIcon('tool_use')).toBe('meta');
      expect(getToolIcon('batch_tool_use')).toBe('meta');
      expect(getToolIcon('tool_search')).toBe('meta');
      expect(getToolIcon('tool_help')).toBe('meta');
      expect(getToolIcon('codebase_index')).toBe('index');
      expect(getToolIcon('set_working_dir')).toBe('settings');
    });
  });

  describe('TOOL_ICON_MAP', () => {
    it('contains all expected tool entries', () => {
      // Core file operations
      expect(TOOL_ICON_MAP.read).toBe('file');
      expect(TOOL_ICON_MAP.write).toBe('file');

      // Shell
      expect(TOOL_ICON_MAP.bash).toBe('terminal');
      expect(TOOL_ICON_MAP.exec).toBe('terminal');

      // Meta
      expect(TOOL_ICON_MAP['tool-use']).toBe('meta');
      expect(TOOL_ICON_MAP['batch-tool-use']).toBe('meta');
      expect(TOOL_ICON_MAP['tool-search']).toBe('meta');
      expect(TOOL_ICON_MAP['tool-help']).toBe('meta');
    });

    it('contains all compound name aliases', () => {
      expect(TOOL_ICON_MAP.codebase_index).toBe('index');
      expect(TOOL_ICON_MAP.codebase_search).toBe('index');
      expect(TOOL_ICON_MAP.codebase_stats).toBe('index');
      expect(TOOL_ICON_MAP.tool_use).toBe('meta');
      expect(TOOL_ICON_MAP.batch_tool_use).toBe('meta');
      expect(TOOL_ICON_MAP.tool_search).toBe('meta');
      expect(TOOL_ICON_MAP.tool_help).toBe('meta');
      expect(TOOL_ICON_MAP.set_working_dir).toBe('settings');
    });
  });

  describe('TOOL_ICON_CONFIG', () => {
    it('has config entries for every icon id', () => {
      const iconIds = Object.keys(TOOL_ICON_CONFIG);
      expect(iconIds).toContain('file');
      expect(iconIds).toContain('edit');
      expect(iconIds).toContain('search');
      expect(iconIds).toContain('folder');
      expect(iconIds).toContain('terminal');
      expect(iconIds).toContain('web');
      expect(iconIds).toContain('git');
      expect(iconIds).toContain('tree');
      expect(iconIds).toContain('code');
      expect(iconIds).toContain('test');
      expect(iconIds).toContain('package');
      expect(iconIds).toContain('document');
      expect(iconIds).toContain('scaffold');
      expect(iconIds).toContain('todo');
      expect(iconIds).toContain('plan');
      expect(iconIds).toContain('task');
      expect(iconIds).toContain('meta');
      expect(iconIds).toContain('index');
      expect(iconIds).toContain('json');
      expect(iconIds).toContain('diff');
      expect(iconIds).toContain('logs');
      expect(iconIds).toContain('settings');
      expect(iconIds).toContain('brain');
      expect(iconIds).toContain('fallback');
    });

    it('every config has icon and color properties', () => {
      for (const [id, config] of Object.entries(TOOL_ICON_CONFIG)) {
        expect(config.icon).toBe(id);
        expect(config.color).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    });
  });

  describe('FALLBACK_ICON', () => {
    it('returns fallback', () => {
      expect(FALLBACK_ICON).toBe('fallback');
    });
  });
});
