import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSessionManager } from '../src/manager.js';

/**
 * Upload containment must use the canonical escape test, not a bare
 * startsWith('..'). A legal in-root first segment like `..uploads` yields a
 * relative path (`..uploads/doc.txt`) that the bare prefix check misread as a
 * parent traversal, so browser_upload falsely rejected project-local files —
 * both at the lexical check and at the symlink-realpath (CWE-59) check.
 * Real parent traversals (`../outside`, the bare `..`) and in-root symlinks
 * pointing outside the project must stay rejected.
 *
 * The browser (Playwright) boundary is faked via the documented constructor
 * injection seam (same pattern as browser-manager-open-cleanup.test.ts), so
 * these tests drive the real production `open()`/`upload()` paths with a
 * deterministic fake browser — no Playwright binary required. File
 * containment runs against real fixture files; each test builds its own
 * isolated fixture tree.
 */

interface Fixture {
  base: string;
  proj: string;
  doc: string;
}

async function makeFixture(): Promise<Fixture> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-upload-dotdot-'));
  const proj = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(proj, '..uploads'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const doc = path.join(proj, '..uploads', 'doc.txt');
  await fs.writeFile(doc, 'legal in-root upload payload');
  await fs.writeFile(path.join(outside, 'outside-secret.txt'), 'must not be uploaded');
  // in-root symlink -> in-root ..-prefixed target (exercises the realpath check)
  await fs.symlink(doc, path.join(proj, 'link-into-dotdot.txt'), 'file');
  // in-root symlink -> outside target (must stay rejected)
  await fs.symlink(
    path.join(outside, 'outside-secret.txt'),
    path.join(proj, 'upload-link.txt'),
    'file',
  );
  return { base, proj, doc };
}

function makeManager(proj: string) {
  const uploaded: string[][] = [];
  const page = {
    on: vi.fn(),
    url: () => 'about:blank',
    title: async () => '',
    locator: vi.fn(() => ({
      setInputFiles: vi.fn(async (files: readonly string[]) => {
        uploaded.push([...files]);
      }),
    })),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
    tracing: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    browser: () => browser,
  };
  const browser = {
    isConnected: () => true,
    on: vi.fn(),
    close: vi.fn(async () => undefined),
    newContext: vi.fn(async () => context),
  };
  const manager = new BrowserSessionManager(
    { artifactRoot: path.join(proj, 'artifacts') },
    async () => browser as never,
  );
  return { manager, uploaded };
}

let lastBase: string | undefined;

afterEach(async () => {
  if (lastBase) {
    await fs.rm(lastBase, { recursive: true, force: true });
    lastBase = undefined;
  }
});

async function withSession(
  proj: string,
): Promise<{ manager: BrowserSessionManager; uploaded: string[][]; sessionId: string }> {
  const { manager, uploaded } = makeManager(proj);
  const opened = await manager.open('leader', { trace: false }, new AbortController().signal);
  return { manager, uploaded, sessionId: opened.id };
}

describe('BrowserSessionManager.upload containment vs in-root ..-prefixed names', () => {
  it('accepts a legal in-root file under a ..-prefixed directory (lexical check)', async () => {
    const fx = await makeFixture();
    lastBase = fx.base;
    const { manager, uploaded, sessionId } = await withSession(fx.proj);
    try {
      await manager.upload(
        sessionId,
        'leader',
        '#file',
        ['..uploads/doc.txt'],
        fx.proj,
        new AbortController().signal,
      );
      expect(uploaded).toEqual([[await fs.realpath(fx.doc)]]);
    } finally {
      await manager.dispose();
    }
  });

  it('accepts an in-root symlink whose real target is a ..-prefixed in-root file (realpath check)', async () => {
    const fx = await makeFixture();
    lastBase = fx.base;
    const { manager, uploaded, sessionId } = await withSession(fx.proj);
    try {
      await manager.upload(
        sessionId,
        'leader',
        '#file',
        ['link-into-dotdot.txt'],
        fx.proj,
        new AbortController().signal,
      );
      expect(uploaded).toEqual([[await fs.realpath(fx.doc)]]);
    } finally {
      await manager.dispose();
    }
  });

  it('rejects a real ../ escape (lexical control)', async () => {
    const fx = await makeFixture();
    lastBase = fx.base;
    const { manager, sessionId } = await withSession(fx.proj);
    try {
      await expect(
        manager.upload(
          sessionId,
          'leader',
          '#file',
          ['../outside/outside-secret.txt'],
          fx.proj,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/must stay inside the project root/);
    } finally {
      await manager.dispose();
    }
  });

  it('rejects the bare parent path ".." (boundary: rel === "..")', async () => {
    const fx = await makeFixture();
    lastBase = fx.base;
    const { manager, sessionId } = await withSession(fx.proj);
    try {
      await expect(
        manager.upload(sessionId, 'leader', '#file', ['..'], fx.proj, new AbortController().signal),
      ).rejects.toThrow(/must stay inside the project root/);
    } finally {
      await manager.dispose();
    }
  });

  it('rejects an in-root symlink to an outside file (realpath control)', async () => {
    const fx = await makeFixture();
    lastBase = fx.base;
    const { manager, sessionId } = await withSession(fx.proj);
    try {
      await expect(
        manager.upload(
          sessionId,
          'leader',
          '#file',
          ['upload-link.txt'],
          fx.proj,
          new AbortController().signal,
        ),
      ).rejects.toThrow(/must not escape the project root through a symlink/);
    } finally {
      await manager.dispose();
    }
  });
});
