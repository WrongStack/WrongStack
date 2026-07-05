import { describe, it, expect, vi, beforeEach } from 'vitest';
import semverBumpPlugin, { determineBump, parseConventional } from '../src/semver-bump';

const mockApi = {
  tools: {
    register: vi.fn()
  },
  slashCommands: {
    register: vi.fn()
  },
  config: { extensions: {} },
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
  events: {
    on: vi.fn()
  }
};

describe('semver-bump plugin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export a Plugin object', () => {
    expect(semverBumpPlugin).toBeDefined();
    expect(semverBumpPlugin.name).toBe('semver-bump');
    expect(semverBumpPlugin.apiVersion).toBe('^0.1.10');
  });

  it('should register three tools in setup', () => {
    semverBumpPlugin.setup(mockApi as any);
    expect(mockApi.tools.register).toHaveBeenCalledTimes(3);
  });

  it('should have semver_bump tool registered', () => {
    semverBumpPlugin.setup(mockApi as any);
    const registeredTools = mockApi.tools.register.mock.calls.map(([tool]: any[]) => tool.name);
    expect(registeredTools).toContain('semver_bump');
  });

  it('should have semver_current tool registered', () => {
    semverBumpPlugin.setup(mockApi as any);
    const registeredTools = mockApi.tools.register.mock.calls.map(([tool]: any[]) => tool.name);
    expect(registeredTools).toContain('semver_current');
  });

  it('should have semver_changelog tool registered', () => {
    semverBumpPlugin.setup(mockApi as any);
    const registeredTools = mockApi.tools.register.mock.calls.map(([tool]: any[]) => tool.name);
    expect(registeredTools).toContain('semver_changelog');
  });

  it('semver_bump should have correct properties', () => {
    semverBumpPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([tool]: any[]) => tool.name === 'semver_bump'
    )?.[0];

    expect(tool.description).toBe('Determine the next version bump from conventional commits since the last tag, or force a specific bump. Creates a git tag.');
    expect(tool.permission).toBe('confirm');
    expect(tool.mutating).toBe(true);
  });

  it('semver_current should have correct properties', () => {
    semverBumpPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([tool]: any[]) => tool.name === 'semver_current'
    )?.[0];

    expect(tool.description).toBe('Return the current version from package.json and the latest git tag.');
    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(false);
  });

  it('semver_changelog should have correct properties', () => {
    semverBumpPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([tool]: any[]) => tool.name === 'semver_changelog'
    )?.[0];

    expect(tool.description).toBe('Generate a changelog (in markdown) between two version tags or from a tag to HEAD.');
    expect(tool.permission).toBe('auto');
    expect(tool.mutating).toBe(false);
  });

  it('should register the /semver slash command', () => {
    semverBumpPlugin.setup(mockApi as any);
    expect(mockApi.slashCommands.register).toHaveBeenCalledTimes(1);
    const cmd = mockApi.slashCommands.register.mock.calls[0]?.[0];
    expect(cmd.name).toBe('semver');
    expect(cmd.argsHint).toContain('patch|minor|major|auto');
  });

  it('semver_bump should default to a patch bump when part is omitted (matches schema default)', async () => {
    semverBumpPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([tool]: any[]) => tool.name === 'semver_bump'
    )?.[0];
    expect(tool.inputSchema.properties.part.default).toBe('patch');

    // dry_run returns before any git/fs mutation; cwd = repo root has package.json
    const result = await tool.execute({ dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.suggestedBump).toBe('patch');
  });

  it('rejects cwd outside the project directory', async () => {
    semverBumpPlugin.setup(mockApi as any);
    const tool = mockApi.tools.register.mock.calls.find(
      ([tool]: any[]) => tool.name === 'semver_bump'
    )?.[0];
    const result = await tool.execute({ cwd: '../escape', dry_run: true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/current project directory/);
  });

  it('rejects cwd outside the project directory in /semver slash command', async () => {
    semverBumpPlugin.setup(mockApi as any);
    const cmd = mockApi.slashCommands.register.mock.calls[0]?.[0];
    const result = await cmd.run('patch', { cwd: '../escape' });
    expect(result.message).toMatch(/current project directory/);
  });

  it('/semver rejects unknown modes without mutating anything', async () => {
    semverBumpPlugin.setup(mockApi as any);
    const cmd = mockApi.slashCommands.register.mock.calls[0]?.[0];
    const result = await cmd.run('bogus');
    expect(result.message).toContain('Unknown mode');
  });
});

describe('parseConventional', () => {
  it('parses type, scope and message with correct groups', () => {
    expect(parseConventional('feat(api): add endpoint')).toEqual({
      type: 'feat',
      scope: 'api',
      message: 'add endpoint',
      breaking: false,
    });
  });

  it('detects breaking via ! before and after the scope', () => {
    expect(parseConventional('feat!: drop legacy').breaking).toBe(true);
    expect(parseConventional('feat(api)!: drop legacy').breaking).toBe(true);
  });

  it('falls back to chore for non-conventional subjects', () => {
    expect(parseConventional('just a message')).toEqual({
      type: 'chore',
      scope: undefined,
      message: 'just a message',
      breaking: false,
    });
  });
});

describe('determineBump', () => {
  const c = (type: string, breaking = false) => ({ hash: 'x', type, message: 'm', breaking, scope: undefined });

  it('returns major only for breaking commits', () => {
    expect(determineBump([c('fix'), c('feat', true)])).toBe('major');
  });

  it('returns minor when a feat commit is present', () => {
    expect(determineBump([c('fix'), c('feat')])).toBe('minor');
  });

  it('returns patch otherwise (refactor/fix/chore do not bump minor)', () => {
    expect(determineBump([c('fix'), c('refactor'), c('chore')])).toBe('patch');
    expect(determineBump([])).toBe('patch');
  });
});