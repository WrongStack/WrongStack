import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '@wrongstack/core/registry';
import { AutoApprovePermissionPolicy } from '@wrongstack/core/security';
import type { PermissionPolicy } from '@wrongstack/core/types';
import { builtinToolsPack } from '@wrongstack/tools';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSelectedMcpServeContent,
  makeServeContext,
  selectExposedTools,
} from '../src/mcp-serve.js';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  return r;
}

const ctx = makeServeContext('/tmp', '/tmp', new AbortController().signal);

const allowAll: PermissionPolicy = {
  evaluate: async () => ({ permission: 'auto', source: 'default' }),
  trust: async () => {},
  deny: async () => {},
  denyOnce: () => {},
  allowOnce: () => {},
  reload: async () => {},
} as never as PermissionPolicy;

describe('selectExposedTools', () => {
  it('safe default (AutoApprove) exposes read-only tools but withholds bash/write/edit', async () => {
    const reg = registry();
    const names = new Set(
      (await selectExposedTools(reg, ctx, new AutoApprovePermissionPolicy(), null)).map(
        (t) => t.name,
      ),
    );
    // read-only tools are exposed
    expect(names.has('glob')).toBe(true);
    expect(names.has('grep')).toBe(true);
    expect(names.has('read')).toBe(true);
    // dangerous / mutating tools are withheld
    expect(names.has('bash')).toBe(false);
    expect(names.has('write')).toBe(false);
    expect(names.has('edit')).toBe(false);
  });

  it('--yolo policy exposes everything, including bash/write', async () => {
    const reg = registry();
    const all = await selectExposedTools(reg, ctx, allowAll, null);
    const safe = await selectExposedTools(reg, ctx, new AutoApprovePermissionPolicy(), null);
    expect(all.length).toBeGreaterThan(safe.length);
    const names = new Set(all.map((t) => t.name));
    expect(names.has('bash')).toBe(true);
    expect(names.has('write')).toBe(true);
  });

  it('whitelist intersects with the policy', async () => {
    const reg = registry();
    // glob passes the safe policy; bash does not — so only glob survives.
    const names = new Set(
      (
        await selectExposedTools(
          reg,
          ctx,
          new AutoApprovePermissionPolicy(),
          new Set(['glob', 'bash']),
        )
      ).map((t) => t.name),
    );
    expect(names.has('glob')).toBe(true);
    expect(names.has('bash')).toBe(false);
    expect(names.size).toBe(1);
  });

  it('whitelist + yolo exposes exactly the requested set that exists', async () => {
    const reg = registry();
    const names = new Set(
      (await selectExposedTools(reg, ctx, allowAll, new Set(['bash', 'read']))).map((t) => t.name),
    );
    expect(names).toEqual(new Set(['bash', 'read']));
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('loadSelectedMcpServeContent', () => {
  it('exposes only explicitly selected resource and prompt files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-serve-content-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, 'guide.md'), '# Guide', 'utf8');
    await fs.writeFile(path.join(dir, 'review.md'), 'Review {{target}} for {{audience}}.', 'utf8');
    await fs.writeFile(path.join(dir, 'not-selected.txt'), 'private', 'utf8');

    const selected = await loadSelectedMcpServeContent(
      { resources: 'guide.md', prompts: 'review.md' },
      dir,
    );

    expect(selected.resources).toHaveLength(1);
    expect(selected.resources[0]).toMatchObject({
      name: 'guide.md',
      mimeType: 'text/markdown',
      contents: [{ text: '# Guide' }],
    });
    expect(selected.prompts).toEqual([
      {
        name: 'review',
        description: 'Explicitly selected local prompt: review.md',
        arguments: [
          { name: 'target', required: true },
          { name: 'audience', required: true },
        ],
        template: 'Review {{target}} for {{audience}}.',
      },
    ]);
    expect(JSON.stringify(selected)).not.toContain('not-selected');
    expect(JSON.stringify(selected)).not.toContain('private');
  });

  it('supports comma-separated selections and encodes binary resources', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-serve-content-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, 'one.txt'), 'one', 'utf8');
    await fs.writeFile(path.join(dir, 'image.png'), Buffer.from([0, 1, 2]));

    const selected = await loadSelectedMcpServeContent({ resources: 'one.txt,image.png' }, dir);

    expect(selected.resources).toHaveLength(2);
    expect(selected.resources[1]?.contents[0]?.blob).toBe('AAEC');
  });

  it('rejects missing, non-file, duplicate, and oversized selections', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-serve-content-'));
    tempDirs.push(dir);
    await fs.writeFile(path.join(dir, 'one.txt'), 'one', 'utf8');
    await fs.writeFile(path.join(dir, 'large.txt'), Buffer.alloc(256 * 1024 + 1));

    await expect(loadSelectedMcpServeContent({ resources: true }, dir)).rejects.toThrow(
      /requires a comma-separated file list/,
    );
    await expect(loadSelectedMcpServeContent({ resources: 'missing.txt' }, dir)).rejects.toThrow();
    await expect(loadSelectedMcpServeContent({ resources: '.' }, dir)).rejects.toThrow(
      /not a regular file/,
    );
    await expect(
      loadSelectedMcpServeContent({ resources: 'one.txt,one.txt' }, dir),
    ).rejects.toThrow(/Duplicate MCP resource/);
    await expect(loadSelectedMcpServeContent({ resources: 'large.txt' }, dir)).rejects.toThrow(
      /exceeds 262144 bytes/,
    );
  });
});
