import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MCPTool } from '../src/client.js';
import {
  manifestConfigHash,
  readCapabilityManifest,
  readManifest,
  writeCapabilityManifest,
  writeManifest,
} from '../src/manifest-cache.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manifest-'));
});

afterEach(async () => {
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
});

describe('readManifest / writeManifest', () => {
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
