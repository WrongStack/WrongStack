import * as os from 'node:os';
import * as path from 'node:path';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

  it('resolves known value-taking wrapper flags and their arguments', async () => {
    // `sudo -u www node` — '-u' consumes 'www'; the command is 'node'.
    const anchor: MemoryAnchor = { type: 'command', command: 'sudo -u www node --version' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });

  it('marks a missing executable after KNOWN flags stale (demotion preserved)', async () => {
    const anchor: MemoryAnchor = {
      type: 'command',
      command: 'sudo -u www definitely-not-a-command-xyz-123',
    };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('stale');
  });

  it('marks a missing executable after an UNKNOWN flag unknown (no wrongful demotion)', async () => {
    const anchor: MemoryAnchor = {
      type: 'command',
      command: 'npx --definitely-unknown-flag definitely-not-a-command-xyz-123',
    };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('unknown');
    expect(result.anchors[0]?.reason).toContain('Ambiguous');
  });

  it('resolves a KNOWN value-taking flag and demotes a genuinely missing command', async () => {
    // `npx --registry https://x CMD` — '--registry' is a known value-taking
    // flag, so 'https://x' is consumed as its argument and 'CMD' is what the
    // probe looks for. CMD is genuinely missing, all flags were known, so the
    // stale verdict (and its demotion) is correct.
    const anchor: MemoryAnchor = {
      type: 'command',
      command: 'npx --registry https://x definitely-not-a-real-command-xyz',
    };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('stale');
  });

  it('treats shell builtins as verified (no PATH entry needed)', async () => {
    const anchor: MemoryAnchor = { type: 'command', command: 'echo probe' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });

  it('verifies a shell builtin even after an unknown wrapper flag', async () => {
    const anchor: MemoryAnchor = { type: 'command', command: 'npx -y echo probe' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });

  it('marks a non-executable explicit path stale on POSIX', async () => {
    const target = path.join(tempDir, 'not-exec.sh');
    await writeFile(target, '#!/bin/sh\necho x\n'); // 0644: no exec bits
    const anchor: MemoryAnchor = { type: 'command', command: target };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    if (process.platform === 'win32') {
      expect(result.anchors[0]?.status).toBe('verified'); // win32: no exec-bit gate
    } else {
      expect(result.anchors[0]?.status).toBe('stale');
    }
  });

  it('resolves a relative command path against the project root', async () => {
    await mkdir(path.join(tempDir, 'scripts'), { recursive: true });
    await writeFile(path.join(tempDir, 'scripts', 'probe.sh'), '#!/bin/sh\necho probe\n');
    // POSIX: the exec-bit probe requires an executable file.
    await chmod(path.join(tempDir, 'scripts', 'probe.sh'), 0o755);
    const anchor: MemoryAnchor = { type: 'command', command: './scripts/probe.sh' };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });

  it('resolves a quoted executable path containing a space', async () => {
    const withSpace = path.join(tempDir, 'tool dir');
    await mkdir(withSpace, { recursive: true });
    await writeFile(path.join(withSpace, 'tool'), 'tool');
    // POSIX: the exec-bit probe requires an executable file.
    await chmod(path.join(withSpace, 'tool'), 0o755);
    const anchor: MemoryAnchor = {
      type: 'command',
      command: `"${path.join(withSpace, 'tool')}" --version`,
    };
    const result = await verifyMemoryAnchors(tempDir, makeMemory([anchor]));
    expect(result.anchors[0]?.status).toBe('verified');
  });
});
