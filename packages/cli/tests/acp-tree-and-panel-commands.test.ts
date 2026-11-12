import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Container, EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpServerCommands } from '../src/acp-server-commands.js';

describe('ACP server commands for /tree, /panel, and /image', () => {
  let tmpDir = '';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-acp-cmds-'));
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('advertises tree, panel, and image commands and runs read-only /tree list without permission prompt while gating /tree branch', async () => {
    const store = new DefaultSessionStore({ dir: path.join(tmpDir, 'sessions') });
    const writer = await store.create({
      id: 'acp-tree-fixture',
      model: 'gpt-5',
      provider: 'openai',
    });

    const container = new Container();
    container.bind(TOKENS.SessionStore, () => store);

    const fakeAgent = {
      container,
      events: new EventBus(),
      ctx: {
        projectRoot: tmpDir,
        session: writer,
        messages: [],
      },
      tools: undefined,
      permission: undefined,
      extensions: undefined,
    };

    const acpCmds = createAcpServerCommands({ projectRoot: tmpDir });
    const advertised = await acpCmds.list();
    const names = advertised.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['tree', 'panel', 'image']));

    const requestPermission = vi.fn(async () => ({
      outcome: { outcome: 'cancelled' as const },
    }));

    // Read-only `/tree list` runs immediately WITHOUT calling requestPermission
    const listRes = await acpCmds.run(
      fakeAgent as never,
      'acp-sess-1',
      { name: 'tree', args: 'list' },
      {
        signal: new AbortController().signal,
        api: { requestPermission } as never,
        emit: vi.fn(),
      },
    );
    expect(requestPermission).not.toHaveBeenCalled();
    expect(listRes?.message).toContain('Session Tree (1 branch · active: main)');

    // Mutating `/tree branch exp` MUST consult ACP permission gate first
    const branchRes = await acpCmds.run(
      fakeAgent as never,
      'acp-sess-1',
      { name: 'tree', args: 'branch exp' },
      {
        signal: new AbortController().signal,
        api: { requestPermission } as never,
        emit: vi.fn(),
      },
    );
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(branchRes?.message).toContain('was not run: the request was rejected');

    // Emitting `plugin.reloaded` invalidates cached per-session commands cleanly
    fakeAgent.events.emit('plugin.reloaded', {
      name: 'demo-ext',
      durationMs: 2,
    });
    const postReloadList = await acpCmds.run(
      fakeAgent as never,
      'acp-sess-1',
      { name: 'tree', args: 'list' },
      {
        signal: new AbortController().signal,
        api: { requestPermission } as never,
        emit: vi.fn(),
      },
    );
    expect(postReloadList?.message).toContain('Session Tree (1 branch · active: main)');

    await writer.close();
  });
});
