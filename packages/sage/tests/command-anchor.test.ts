import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyMemoryAnchors } from '../src/anchors/verify.js';
import type { MemoryAnchor, Sage } from '../src/types.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'sage-cmd-anchor-'));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeMemory(anchors: MemoryAnchor[]): Sage {
  return {
    id: 'cmd-anchor-test',
    revision: 1,
    text: 'command anchor probe',
    kind: 'fact',
    scope: 'project',
    status: 'active',
    importance: 0.5,
    confidence: 0.5,
    freshness: 0.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    tags: [],
    anchors,
    sources: [],
  };
}

describe('command anchor verification via existence probe (2026-08-02)', () => {
  it('verifies a bare executable found on PATH (skipping wrappers)', async () => {
    // The node binary running this test is on PATH; 'npx node --version'
    // exercises the wrapper skip ('npx' -> 'node') plus the PATH walk.
    const anchor: MemoryAnchor = { type: 'command', command: 'npx node --version' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });

  it('marks a wrapper with no following command stale', async () => {
    const anchor: MemoryAnchor = { type: 'command', command: 'sudo' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('stale');
    expect(result.anchors[0]?.reason).toContain('no executable');
  });

  it('skips wrapper options and env assignments to find the executable', async () => {
    const anchor: MemoryAnchor = { type: 'command', command: 'npx --yes node --version' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });

  it('treats a short wrapper flag + token as ambiguous (unknown, never demoting stale)', async () => {
    // `npx -y node` is indistinguishable from `sudo -u www` (flag argument vs
    // command) without per-tool knowledge; a wrong 'stale' would demote the
    // persisted memory, so the probe reports 'unknown'.
    const anchor: MemoryAnchor = { type: 'command', command: 'npx -y node --version' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('unknown');
    expect(result.anchors[0]?.reason).toContain('Ambiguous');
  });

  it('resolves a relative command path against the project root', async () => {
    await mkdir(path.join(tempDir, 'scripts'), { recursive: true });
    await writeFile(path.join(tempDir, 'scripts', 'probe.sh'), '#!/bin/sh\necho probe\n');
    const anchor: MemoryAnchor = { type: 'command', command: './scripts/probe.sh' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });

  it('resolves a quoted executable path containing a space', async () => {
    const withSpace = path.join(tempDir, 'tool dir');
    await mkdir(withSpace, { recursive: true });
    await writeFile(path.join(withSpace, 'tool'), 'tool');
    const anchor: MemoryAnchor = {
      type: 'command',
      command: `"${path.join(withSpace, 'tool')}" --version`,
    };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });
});
