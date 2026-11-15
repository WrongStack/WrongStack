import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMcpManagementCommand } from '../src/services/mcp-management.js';

const temps: string[] = [];

afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('mcp-management Object.prototype key safety (F377)', () => {
  it('does not treat Object.prototype keys like "toString" as configured servers', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'f377-mcp-'));
    temps.push(tmp);
    const configPath = path.join(tmp, 'settings.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');

    const stop = vi.fn(async () => {});
    const registry = {
      list: () => [],
      start: async () => {},
      stop,
      restart: async () => {},
    };

    const out = await runMcpManagementCommand(
      { action: 'remove', name: 'toString' },
      {
        config: { mcpServers: {} } as never,
        configPath,
        mcpRegistry: registry as never,
        allServerPresets: {},
      },
    );

    expect(stop).not.toHaveBeenCalled();
    expect(out).toContain('not in config');
  });
});
