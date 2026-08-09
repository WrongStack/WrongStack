import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpCmd } from '../src/subcommands/handlers/mcp.js';

let tmp: string;
let configPath: string;
let writes: string[];
let errors: string[];
let warnings: string[];
let infos: string[];

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-handler-'));
  configPath = path.join(tmp, 'config.json');
  writes = [];
  errors = [];
  warnings = [];
  infos = [];
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function mkDeps(over: Record<string, unknown> = {}) {
  return {
    renderer: {
      write: (s: string) => writes.push(s),
      writeError: (s: string) => errors.push(s),
      writeWarning: (s: string) => warnings.push(s),
      writeInfo: (s: string) => infos.push(s),
    },
    config: { mcpServers: {} },
    paths: { globalConfig: configPath, profileConfig: () => configPath },
    ...over,
  } as never;
}

describe('mcpCmd subcommand', () => {
  // ── list ──────────────────────────────────────────────────────────────────

  it('list (no args) reports "no MCP servers configured" when empty', async () => {
    const code = await mcpCmd([], mkDeps());
    expect(code).toBe(0);
    expect(writes.join('')).toContain('No MCP servers configured');
  });

  it('list with configured servers prints name/transport/status', async () => {
    const deps = mkDeps({
      config: {
        mcpServers: {
          fs: { transport: 'stdio', enabled: true, description: 'filesystem' },
          gh: { transport: 'sse', enabled: false },
        },
      },
    });
    await mcpCmd(['list'], deps);
    const out = writes.join('');
    expect(out).toContain('fs');
    expect(out).toContain('stdio');
    expect(out).toContain('enabled');
    expect(out).toContain('gh');
    expect(out).toContain('disabled');
    expect(out).toContain('# filesystem');
  });

  it('errors on unknown subcommand', async () => {
    const code = await mcpCmd(['frobulate'], mkDeps());
    expect(code).toBe(1);
    expect(errors[0]).toContain('Unknown mcp subcommand');
  });

  it('restart prints a warning pointing at REPL', async () => {
    const code = await mcpCmd(['restart'], mkDeps());
    expect(code).toBe(0);
    expect(warnings[0]).toContain('REPL mode');
  });

  // ── add ───────────────────────────────────────────────────────────────────

  it('add without a name prints available servers from BUILT_IN_MCP', async () => {
    const code = await mcpCmd(['add'], mkDeps());
    expect(code).toBe(1);
    expect(errors[0]).toContain('Usage: wstack mcp add');
    // Should list at least one built-in server
    expect(writes.join('')).toContain('Available servers');
  });

  it('add with unknown server name errors', async () => {
    const code = await mcpCmd(['add', 'definitely-not-a-real-server'], mkDeps());
    expect(code).toBe(1);
    expect(errors[0]).toContain('Unknown server');
  });

  it('add <known-server> writes it to config as disabled by default', async () => {
    // Pick a known built-in server name dynamically
    const { allServers } = await import('@wrongstack/core/infrastructure');
    const names = Object.keys(allServers());
    expect(names.length).toBeGreaterThan(0);
    const target = names[0]!;
    const code = await mcpCmd(['add', target], mkDeps());
    expect(code).toBe(0);
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(cfg.mcpServers[target]).toBeDefined();
    expect(cfg.mcpServers[target].enabled).toBe(false);
    expect(infos[0]).toContain('Added');
  });

  it('add <known-server> --enable writes it enabled', async () => {
    const { allServers } = await import('@wrongstack/core/infrastructure');
    const target = Object.keys(allServers())[0]!;
    const code = await mcpCmd(['add', target, '--enable'], mkDeps());
    expect(code).toBe(0);
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(cfg.mcpServers[target].enabled).toBe(true);
    expect(infos[0]).toContain('Enabled');
  });

  it('add <known-server> -e shortcut also enables', async () => {
    const { allServers } = await import('@wrongstack/core/infrastructure');
    const target = Object.keys(allServers())[0]!;
    const code = await mcpCmd(['add', target, '-e'], mkDeps());
    expect(code).toBe(0);
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(cfg.mcpServers[target].enabled).toBe(true);
  });

  it('add warns when the server already exists in config', async () => {
    const { allServers } = await import('@wrongstack/core/infrastructure');
    const target = Object.keys(allServers())[0]!;
    await mcpCmd(['add', target], mkDeps());
    warnings.length = 0;
    await mcpCmd(['add', target], mkDeps());
    expect(warnings[0]).toContain('already in config');
  });

  // ── remove ────────────────────────────────────────────────────────────────

  it('remove without a name errors', async () => {
    const code = await mcpCmd(['remove'], mkDeps());
    expect(code).toBe(1);
    expect(errors[0]).toContain('Usage: wstack mcp remove');
  });

  it('remove when config file does not exist errors', async () => {
    const code = await mcpCmd(['remove', 'something'], mkDeps());
    expect(code).toBe(1);
    expect(errors[0]).toContain('No config file found');
  });

  it('remove when server is not in config errors', async () => {
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }));
    const code = await mcpCmd(['remove', 'absent'], mkDeps());
    expect(code).toBe(1);
    expect(errors[0]).toContain('not in config');
  });

  it('remove deletes the server entry and rewrites the config', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify({
        otherKey: 'preserved',
        mcpServers: { x: { transport: 'stdio' }, y: { transport: 'sse' } },
      }),
    );
    const code = await mcpCmd(['remove', 'x'], mkDeps());
    expect(code).toBe(0);
    const cfg = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(cfg.mcpServers.x).toBeUndefined();
    expect(cfg.mcpServers.y).toBeDefined();
    expect(cfg.otherKey).toBe('preserved');
    expect(infos[0]).toContain('Removed');
  });
});
