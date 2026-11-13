import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SubagentRunContext } from '@wrongstack/contracts/types';
import { ArchitectureDecisionStore } from '@wrongstack/core/storage';
import { expect, it, vi } from 'vitest';
import { buildAcpSubagentRunner } from '../src/host-acp.js';

it('sends accepted ADRs through the real ACP child protocol and refreshes a live task after user approval', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'adr-acp-wire-'));
  // The peer only reads a task and writes the capture files. Keep its cwd on
  // the existing checkout: Windows retains a spawned process's cwd lease after
  // transport teardown, so a disposable cwd cannot be synchronously removed.
  // All registry state and captures still live under this test's isolated home.
  const root = process.cwd();
  const initialFile = path.join(dir, 'initial.json');
  const refreshFile = path.join(dir, 'refresh.json');
  vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
  const controller = new AbortController();
  let run: Promise<unknown> | undefined;
  try {
    const store = new ArchitectureDecisionStore(root);
    const content = {
      title: 'Initial boundary',
      context: 'Keep modules independent.',
      decision: 'Initial accepted architecture constraint.',
      alternatives: [],
      consequences: [],
      constraints: [],
      scope: [],
      revisitWhen: '',
    };
    const initial = store.propose(content, 'leader');
    store.review(
      {
        projectId: initial.projectId,
        id: initial.id,
        revision: initial.revision,
        contentHash: initial.contentHash,
        action: 'accept',
        reason: 'Reviewed initial decision.',
      },
      'user',
    );
    const pending = store.propose(
      { ...content, title: 'New boundary', decision: 'Newly approved architecture constraint.' },
      'leader',
    );
    const runner = await buildAcpSubagentRunner('adr-fixture', {
      projectRoot: root,
      overrides: {
        'adr-fixture': {
          command: process.execPath,
          args: [
            fileURLToPath(new URL('./fixtures/architecture-decision-agent.ts', import.meta.url)),
          ],
          env: { ADR_WIRE_INITIAL: initialFile, ADR_WIRE_REFRESH: refreshFile },
        },
      },
    });
    run = runner({ id: 'wire-task', description: 'Implement the scoped task.' }, {
      subagentId: 'adr-fixture',
      sessionId: 'wire-owner',
      config: { name: 'adr-fixture' },
      signal: controller.signal,
      budget: { markActivity() {}, recordUsage() {} },
    } as unknown as SubagentRunContext);
    await vi.waitFor(() => expect(existsSync(initialFile)).toBe(true), { timeout: 10_000 });
    const first = readFileSync(initialFile, 'utf8');
    expect(first).toContain(content.decision);
    expect(first).toContain('Implement the scoped task.');
    expect(first).not.toContain(pending.decision);
    store.review(
      {
        projectId: pending.projectId,
        id: pending.id,
        revision: pending.revision,
        contentHash: pending.contentHash,
        action: 'accept',
        reason: 'Reviewed the new boundary.',
      },
      'user',
    );
    await vi.waitFor(() => expect(existsSync(refreshFile)).toBe(true), { timeout: 10_000 });
    const refresh = JSON.parse(readFileSync(refreshFile, 'utf8'));
    expect(JSON.stringify(refresh.prompt)).toContain(pending.decision);
    expect(refresh._meta.steering.idleBehavior).toBe('promptRequired');
    await expect(run).resolves.toMatchObject({ result: 'Reviewed architecture context received.' });
  } finally {
    controller.abort();
    await run?.catch(() => {});
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}, 25_000);
