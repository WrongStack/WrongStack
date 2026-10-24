import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MCPTool } from '../src/client.js';
import { MCPClient } from '../src/client.js';
import {
  manifestConfigHash,
  readCapabilityManifest,
  readManifest,
  writeCapabilityManifest,
  writeManifest,
} from '../src/manifest-cache.js';
import { MCPRegistry } from '../src/registry.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manifest-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

const tools: MCPTool[] = [
  { name: 'a', description: 'A', inputSchema: { type: 'object', properties: {} } },
  { name: 'b', inputSchema: { type: 'object', properties: {} } },
];

describe('manifestConfigHash', () => {
  it('is stable for the same connection fields', () => {
    const a = manifestConfigHash({ transport: 'stdio', command: 'npx', args: ['-y', 'x'] });
    const b = manifestConfigHash({ transport: 'stdio', command: 'npx', args: ['-y', 'x'] });
    expect(a).toBe(b);
  });

  it('changes when command/args/url/transport change', () => {
    const base = manifestConfigHash({ transport: 'stdio', command: 'npx', args: ['x'] });
    expect(manifestConfigHash({ transport: 'stdio', command: 'npx', args: ['y'] })).not.toBe(base);
    expect(manifestConfigHash({ transport: 'sse', url: 'https://x' })).not.toBe(base);
  });

  it.each([false, true])('invalidates referenced bearer values (padded name=%s)', (padded) => {
    const key = 'WRONGSTACK_MANIFEST_TEST_TOKEN';
    const previous = process.env[key];
    const cfg = { transport: 'sse', bearerTokenEnv: padded ? ` ${key} ` : key };
    try {
      process.env[key] = 'dummy-alpha';
      const first = manifestConfigHash(cfg);
      expect(manifestConfigHash(cfg)).toBe(first);
      process.env[key] = 'dummy-beta';
      expect(manifestConfigHash(cfg)).not.toBe(first);
      delete process.env[key];
      expect(manifestConfigHash(cfg)).not.toBe(first);
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
});

describe('readManifest / writeManifest', () => {
  it('discovers tools on a cold connection when a cached tool entry is corrupt', async () => {
    const cfg = { name: 'svc', transport: 'stdio' as const, command: 'unused', lazy: true };
    await fs.mkdir(path.join(tmp, 'mcp-tools'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'mcp-tools', 'svc.json'),
      JSON.stringify({ configHash: manifestConfigHash(cfg), tools: [null] }),
      'utf8',
    );
    const toolRegistry = new ToolRegistry();
    const registry = new MCPRegistry({
      toolRegistry,
      events: new EventBus(),
      cacheDir: tmp,
      idleTimeoutMs: 0,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    });
    const connect = vi.spyOn(MCPClient.prototype, 'connect').mockResolvedValue();
    vi.spyOn(MCPClient.prototype, 'close').mockResolvedValue();
    vi.spyOn(MCPClient.prototype, 'listTools').mockReturnValue(tools);
    vi.spyOn(MCPClient.prototype, 'getServerMetadata').mockReturnValue(undefined);
    try {
      await registry.start(cfg);
      expect(connect).toHaveBeenCalledOnce();
      expect(toolRegistry.list()).toHaveLength(2);
      expect(registry.list()[0]?.state).toBe('connected');
    } finally {
      await registry.stopAll();
    }
  });

  it.each([
    ['null entry', [null]],
    ['boolean entry', [false]],
    ['string entry', ['broken']],
    ['missing name', [{ inputSchema: {} }]],
    ['numeric name', [{ name: 42, inputSchema: {} }]],
    ['empty name', [{ name: '', inputSchema: {} }]],
    ['array input schema', [{ name: 'broken', inputSchema: [] }]],
    ['array output schema', [{ name: 'broken', inputSchema: {}, outputSchema: [] }]],
    ['mixed valid and corrupt entries', [tools[0], null]],
    ['non-array tool catalog', { name: 'broken', inputSchema: {} }],
  ])(
    'treats %s as a cache miss instead of accepting a broken startup catalog',
    async (_label, cachedTools) => {
      await fs.mkdir(path.join(tmp, 'mcp-tools'), { recursive: true });
      await fs.writeFile(
        path.join(tmp, 'mcp-tools', 'svc.json'),
        JSON.stringify({ configHash: 'hash', tools: cachedTools }),
        'utf8',
      );
      await expect(readCapabilityManifest(tmp, 'svc', 'hash')).resolves.toBeNull();
    },
  );

  it('round-trips tools when the hash matches', async () => {
    const hash = manifestConfigHash({ transport: 'stdio', command: 'npx' });
    await writeManifest(tmp, 'svc', hash, tools);
    const read = await readManifest(tmp, 'svc', hash);
    expect(read).toEqual(tools);
  });

  it('round-trips server metadata, resources, templates, and prompts', async () => {
    const hash = manifestConfigHash({ transport: 'stdio', command: 'npx' });
    await writeCapabilityManifest(tmp, 'catalog', hash, {
      tools,
      serverMetadata: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'catalog', version: '1.0.0' },
      },
      resources: [{ uri: 'mem://guide', name: 'guide', mimeType: 'text/plain' }],
      resourceTemplates: [{ uriTemplate: 'mem://{id}', name: 'memory' }],
      prompts: [{ name: 'review', arguments: [{ name: 'target', required: true }] }],
    });

    await expect(readCapabilityManifest(tmp, 'catalog', hash)).resolves.toMatchObject({
      tools: [{ name: 'a' }, { name: 'b' }],
      serverMetadata: { serverInfo: { name: 'catalog' } },
      resources: [{ uri: 'mem://guide' }],
      resourceTemplates: [{ uriTemplate: 'mem://{id}' }],
      prompts: [{ name: 'review' }],
    });
  });

  it('preserves capability catalogs when the legacy tools writer refreshes tools', async () => {
    const hash = 'hash';
    await writeCapabilityManifest(tmp, 'svc', hash, {
      tools: [],
      resources: [{ uri: 'mem://one', name: 'one' }],
    });
    await writeManifest(tmp, 'svc', hash, tools);

    const manifest = await readCapabilityManifest(tmp, 'svc', hash);
    expect(manifest?.tools).toEqual(tools);
    expect(manifest?.resources).toEqual([
      {
        uri: 'mem://one',
        name: 'one',
        title: undefined,
        description: undefined,
        mimeType: undefined,
        size: undefined,
        annotations: undefined,
      },
    ]);
  });

  it('reads legacy tools-only manifest files', async () => {
    const dir = path.join(tmp, 'mcp-tools');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'legacy.json'),
      JSON.stringify({ configHash: 'legacy-hash', tools }),
      'utf8',
    );

    await expect(readCapabilityManifest(tmp, 'legacy', 'legacy-hash')).resolves.toMatchObject({
      tools,
    });
  });

  it('rejects malformed cached capability payloads', async () => {
    const dir = path.join(tmp, 'mcp-tools');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'bad.json'),
      JSON.stringify({ configHash: 'h', tools: [], resources: [{ uri: 'mem://missing-name' }] }),
      'utf8',
    );

    await expect(readCapabilityManifest(tmp, 'bad', 'h')).resolves.toBeNull();
  });

  it('returns null when the config hash no longer matches (stale)', async () => {
    await writeManifest(tmp, 'svc', 'OLD', tools);
    expect(await readManifest(tmp, 'svc', 'NEW')).toBeNull();
  });

  it('returns null when there is no cache', async () => {
    expect(await readManifest(tmp, 'missing', 'h')).toBeNull();
  });

  it('sanitizes unsafe server names into the file path', async () => {
    const hash = 'h';
    await writeManifest(tmp, 'we/ird:name', hash, tools);
    // Stored under a sanitized file name; read finds it by the same name.
    expect(await readManifest(tmp, 'we/ird:name', hash)).toEqual(tools);
  });

  it.each(['team/api', 'Team'])(
    'isolates %s from a literal hashed-filename server name',
    async (name) => {
      const literalName =
        `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}-${createHash('sha256').update(name).digest('hex')}`.toLowerCase();
      const otherTools: MCPTool[] = [{ name: 'other', inputSchema: { type: 'object' } }];
      await writeManifest(tmp, name, 'hash', tools);
      expect(await readManifest(tmp, name, 'hash')).toEqual(tools);
      await writeManifest(tmp, literalName, 'hash', otherTools);
      expect(await readManifest(tmp, literalName, 'hash')).toEqual(otherTools);
      expect(await readManifest(tmp, name, 'hash')).toEqual(tools);
      // Refresh in the opposite direction must preserve the other identity too.
      await writeManifest(tmp, name, 'new-hash', tools);
      expect(await readManifest(tmp, literalName, 'hash')).toEqual(otherTools);
      expect(await readManifest(tmp, name, 'hash')).toBeNull();
      expect(await readManifest(tmp, name, 'new-hash')).toEqual(tools);
    },
  );

  it('keeps lossy sanitized names independent and preserves lowercase legacy paths', async () => {
    const otherTools: MCPTool[] = [{ name: 'other', inputSchema: { type: 'object' } }];
    await writeManifest(tmp, 'team/api', 'hash', tools);
    await writeManifest(tmp, 'team_api', 'hash', otherTools);
    expect(await readManifest(tmp, 'team/api', 'hash')).toEqual(tools);
    expect(await readManifest(tmp, 'team_api', 'hash')).toEqual(otherTools);
    expect(
      JSON.parse(await fs.readFile(path.join(tmp, 'mcp-tools', 'team_api.json'), 'utf8')).tools,
    ).toEqual(otherTools);
  });

  it('cleans up its temporary file when the atomic rename fails', async () => {
    const destination = path.join(tmp, 'mcp-tools', 'blocked.json');
    await fs.mkdir(destination, { recursive: true });

    await expect(
      writeCapabilityManifest(tmp, 'blocked', 'hash', { tools }),
    ).resolves.toBeUndefined();

    const files = await fs.readdir(path.dirname(destination));
    expect(files).toEqual(['blocked.json']);
  });
});
