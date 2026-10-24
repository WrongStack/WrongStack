import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, Tool } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { builtinToolsPack } from '@wrongstack/tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  sharedWrongForgeGateway,
  WORKER_WITHHELD_TOOLS,
} from '../../src/fleet/wrongforge-gateway.js';

const config = { tools: {} } as unknown as Config;

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  const tools = [...(builtinToolsPack.tools ?? [])];
  r.registerAllOrThrow(tools, builtinToolsPack.name);
  // A leader-only tool the worker gateway must never serve.
  const template = tools[0] as Tool;
  r.register({ ...template, name: 'delegate', description: 'leader only' }, 'test');
  return r;
}

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wf-gateway-')));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('sharedWrongForgeGateway', () => {
  it('serves the worker tool surface on loopback without leader-only tools', async () => {
    const spec = await sharedWrongForgeGateway({ projectRoot: root, registry: registry(), config });

    expect(spec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(spec.token).toMatch(/^[0-9a-f]{48}$/);
    expect(spec).toMatchObject({
      list_path: '/v1/tools',
      call_path: '/v1/tools/{name}/call',
      name_prefix: 'wstack_',
      optional: true,
    });
    expect(spec.deny).toEqual(expect.arrayContaining(['read', 'glob', 'grep']));

    const res = await fetch(`${spec.url}${spec.list_path}`, {
      headers: { authorization: `Bearer ${spec.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tools: { name: string }[] };
    const names = body.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('delegate');
    for (const name of names) expect(WORKER_WITHHELD_TOOLS.has(name)).toBe(false);
  });

  it('starts one gateway per project and hands every caller the same one', async () => {
    const opts = { projectRoot: root, registry: registry(), config, log: () => {} };
    const first = sharedWrongForgeGateway(opts);
    expect(sharedWrongForgeGateway(opts)).toBe(first);
    const spec = await first;
    expect(await sharedWrongForgeGateway(opts)).toBe(spec);
  });

  it('retries a failed start instead of caching the failure', async () => {
    const broken = {
      list: () => {
        throw new Error('registry unavailable');
      },
    } as unknown as ToolRegistry;
    const failed = sharedWrongForgeGateway({ projectRoot: root, registry: broken, config });
    await expect(failed).rejects.toThrow('registry unavailable');
    // The rejection handler drops the entry; let it run before retrying.
    await new Promise((resolve) => setImmediate(resolve));

    const retried = sharedWrongForgeGateway({ projectRoot: root, registry: registry(), config });
    expect(retried).not.toBe(failed);
    await expect(retried).resolves.toMatchObject({ list_path: '/v1/tools' });
  });
});
