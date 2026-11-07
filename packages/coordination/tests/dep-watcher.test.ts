/**
 * Tests for dep-watcher — File-change → Mailbox bridge.
 *
 * Tests cover:
 *   - makeDependencyWatcherConfig factory outputs and configuration
 *   - watchPaths generation (plain files, glob patterns, deduplication)
 *   - matchesPattern filtering (plain names, globs like *.csproj)
 *   - onChange debounce and mailbox publish
 *   - dispose cleanup
 *   - Edge cases: delete events, non-dependency files, debounce collapse
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEPENDENCY_FILE_PATTERNS,
  type DepWatchEntry,
  makeDependencyWatcherConfig,
} from '../src/dep-watcher.js';
import type { Mailbox } from '../src/mailbox-types.js';
import { SqliteMailbox } from '../src/sqlite-mailbox.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function tmpDir(): string {
  return path.join(os.tmpdir(), `ws-depwatch-test-${randomUUID().slice(0, 8)}`);
}

function makeEntry(over: Partial<DepWatchEntry> & { path: string }): DepWatchEntry {
  return {
    event: over.event ?? 'change',
    timestamp: over.timestamp ?? new Date().toISOString(),
    path: over.path,
  };
}

/**
 * Wait until the watcher has actually published.
 *
 * The send path became async when added-package detection landed: the debounce
 * timer callback now reads the manifest to compute the dependency delta before
 * calling `mailbox.send`. That makes the gap between `onChange` and the send
 * depend on filesystem latency, so a fixed `setTimeout` turned into a race —
 * these tests passed alone and failed when the suite ran in parallel. Polling
 * for the observable effect is deterministic at any load.
 */
async function waitForSend(spy: { mock: { calls: unknown[][] } }, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (spy.mock.calls.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('DEPENDENCY_FILE_PATTERNS', () => {
  it('contains common manifest file names', () => {
    expect(DEPENDENCY_FILE_PATTERNS).toContain('package.json');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('go.mod');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('Cargo.toml');
    expect(DEPENDENCY_FILE_PATTERNS).toContain('*.csproj');
  });
});

describe('makeDependencyWatcherConfig', () => {
  let mailbox: Mailbox;
  let dir: string;
  let projectRoot: string;

  beforeEach(async () => {
    dir = tmpDir();
    await fs.mkdir(dir, { recursive: true });
    projectRoot = dir;
    mailbox = new SqliteMailbox(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns config with watchPaths, onChange, debounceMs, and dispose', () => {
    const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
    expect(cfg.watchPaths).toBeDefined();
    expect(Array.isArray(cfg.watchPaths)).toBe(true);
    expect(typeof cfg.onChange).toBe('function');
    expect(typeof cfg.debounceMs).toBe('number');
    expect(typeof cfg.dispose).toBe('function');
  });

  it('includes project root and plain file patterns in watchPaths', () => {
    const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
    expect(cfg.watchPaths).toContain(projectRoot);
    // Plain patterns like package.json should be resolved relative to projectRoot
    expect(cfg.watchPaths).toContain(`${projectRoot}/package.json`);
    expect(cfg.watchPaths).toContain(`${projectRoot}/go.mod`);
  });

  it('deduplicates watch paths', () => {
    const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
    const unique = new Set(cfg.watchPaths);
    expect(cfg.watchPaths.length).toBe(unique.size);
  });

  it('does not add glob patterns (e.g., *.csproj) as literal file paths in watchPaths', () => {
    const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
    // No entry with *.csproj in watchPaths
    expect(cfg.watchPaths.some((p) => p.includes('*'))).toBe(false);
  });

  it('accepts custom patterns, watcherAgentId, and targetAgent', () => {
    const cfg = makeDependencyWatcherConfig({
      projectRoot,
      mailbox,
      patterns: ['package.json', '*.custom'],
      watcherAgentId: 'custom-watcher',
      targetAgent: 'tech-stack-agent',
      debounceMs: 1000,
    });
    expect(cfg.watchPaths).toContain(`${projectRoot}/package.json`);
    expect(cfg.debounceMs).toBe(1000);
  });

  describe('onChange', () => {
    it('ignores delete events', async () => {
      const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json', event: 'delete' }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('ignores non-dependency file changes', async () => {
      const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'src/main.ts' }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('ignores nested non-dependency files', async () => {
      const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'src/components/readme.md' }));
      expect(spy).not.toHaveBeenCalled();
    });

    it('ignores installed package manifests from the recursive root watch', async () => {
      const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox, debounceMs: 10 });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'node_modules/transitive/package.json' }));
      await cfg.onChange(makeEntry({ path: 'NODE_MODULES\\transitive\\package.json' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(spy).not.toHaveBeenCalled();
    });

    it('sends a mailbox message when a dependency file changes', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json', event: 'change' }));

      await waitForSend(spy);

      expect(spy).toHaveBeenCalledTimes(1);
      const callArgs = spy.mock.calls[0]![0] as Record<string, unknown>;
      // No `targetAgent` → the default `*` fan-out. `assign` is rejected for a
      // multi-recipient target, so the notification goes out as a broadcast.
      expect(callArgs.to).toBe('*');
      expect(callArgs.type).toBe('broadcast');
      expect(callArgs.subject).toContain('package.json');
      expect(callArgs.priority).toBe('high');
      expect(callArgs.from).toBe('dep-watcher');
    });

    it('assigns to a single named target', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        targetAgent: 'tech-stack',
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json', event: 'change' }));
      await waitForSend(spy);

      const callArgs = spy.mock.calls[0]![0];
      expect(callArgs.to).toBe('tech-stack');
      expect(callArgs.type).toBe('assign');
    });

    it('publishes with the correct targetAgent', async () => {
      const spy = vi.spyOn(mailbox, 'send');
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        targetAgent: 'tech-stack-agent',
        debounceMs: 10,
      });

      await cfg.onChange(makeEntry({ path: 'go.mod' }));
      await waitForSend(spy);

      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.to).toBe('tech-stack-agent');
      spy.mockRestore();
    });

    it('debounces multiple rapid changes to the same file', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 50,
      });
      const spy = vi.spyOn(mailbox, 'send');

      // Fire 3 rapid changes to the same file
      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await cfg.onChange(makeEntry({ path: 'package.json' }));

      // Wait for debounce to fire
      await new Promise((r) => setTimeout(r, 100));

      expect(spy).toHaveBeenCalledTimes(1); // collapsed to 1
    });

    it('does not debounce changes to different files', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await cfg.onChange(makeEntry({ path: 'go.mod' }));
      await new Promise((r) => setTimeout(r, 100));

      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('handles glob-matching patterns like *.csproj', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'src/MyApp.csproj' }));
      await new Promise((r) => setTimeout(r, 50));

      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.subject).toContain('MyApp.csproj');
    });

    it('handles glob patterns like *.fsproj', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        patterns: ['*.fsproj'],
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'src/Library.fsproj' }));
      await new Promise((r) => setTimeout(r, 50));

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not match globs against non-globbed file names', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        patterns: ['*.csproj'],
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'random.txt' }));
      await new Promise((r) => setTimeout(r, 50));
      expect(spy).not.toHaveBeenCalled();
    });

    it('extracts file name from nested path for the subject', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'packages/frontend/package.json' }));
      await new Promise((r) => setTimeout(r, 50));

      expect(spy).toHaveBeenCalledTimes(1);
      const args = spy.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.subject).toContain('package.json');
    });

    it('ignores metadata-only events on a manifest whose bytes did not change', async () => {
      // Windows fs.watch reports NTFS last-access refreshes (hourly, on first
      // read) as `change`; an untouched tsconfig.json spawned an audit hourly.
      const manifestPath = path.join(projectRoot, 'package.json');
      const manifest = (deps: Record<string, string>) =>
        JSON.stringify({ name: 'sandbox', dependencies: deps });
      await fs.writeFile(manifestPath, manifest({ react: '18.2.0' }), 'utf8');
      const past = new Date(Date.now() - 60 * 60 * 1000);
      await fs.utimes(manifestPath, past, past);

      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        targetAgent: 'tech-stack',
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');
      const settle = () => new Promise((r) => setTimeout(r, 150));

      // Not written since the watcher started: last-access/attribute noise.
      await fs.utimes(manifestPath, new Date(), past);
      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await settle();
      expect(spy).not.toHaveBeenCalled();

      // Rewritten with identical bytes: still no dependency change.
      await fs.writeFile(manifestPath, manifest({ react: '18.2.0' }), 'utf8');
      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await settle();
      expect(spy).not.toHaveBeenCalled();

      // A real edit goes through and names the delta.
      await fs.writeFile(manifestPath, manifest({ react: '18.2.0', zod: '3.23.8' }), 'utf8');
      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await waitForSend(spy);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((spy.mock.calls[0]![0] as { subject: string }).subject).toContain('zod');
    });

    it('handles mailbox.send rejection gracefully (no crash)', async () => {
      const brokenMailbox = {
        send: vi.fn().mockRejectedValue(new Error('network error')),
      } as never as Mailbox;

      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox: brokenMailbox,
        debounceMs: 10,
      });

      // Should not throw
      await expect(
        (async () => {
          await cfg.onChange(makeEntry({ path: 'package.json' }));
          await new Promise((r) => setTimeout(r, 50));
        })(),
      ).resolves.toBeUndefined();
    });
  });

  describe('dispose', () => {
    it('clears pending debounce timers', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 10000, // long debounce
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json' }));

      // Dispose before the timer fires
      cfg.dispose();
      await new Promise((r) => setTimeout(r, 50));

      expect(spy).not.toHaveBeenCalled();
    });

    it('debounces mixed relative and root-prefixed manifest paths together and ignores onChange after dispose (F764)', async () => {
      const pkgPath = path.join(projectRoot, 'package.json');
      await fs.writeFile(
        pkgPath,
        JSON.stringify({ name: 'f764-pkg', dependencies: { zod: '^3.22.0' } }, null, 2),
        'utf8',
      );
      const future = new Date(Date.now() + 2000);
      await fs.utimes(pkgPath, future, future);

      const normalizedRoot = projectRoot.replaceAll('\\', '/');
      const cfg = makeDependencyWatcherConfig({
        projectRoot: normalizedRoot,
        mailbox,
        debounceMs: 25,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await cfg.onChange(makeEntry({ path: `${normalizedRoot}/package.json` }));
      await waitForSend(spy);
      await new Promise((r) => setTimeout(r, 40));

      expect(spy).toHaveBeenCalledTimes(1);

      cfg.dispose();
      await fs.writeFile(
        pkgPath,
        JSON.stringify(
          { name: 'f764-pkg', dependencies: { zod: '^3.22.0', vitest: '^2.0.0' } },
          null,
          2,
        ),
        'utf8',
      );
      await fs.utimes(pkgPath, future, future);
      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await new Promise((r) => setTimeout(r, 50));

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('defaults', () => {
    it('uses default patterns when none provided', () => {
      const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
      // The default includes many patterns
      expect(cfg.watchPaths.length).toBeGreaterThan(5);
    });

    it('default targetAgent is "*"', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await new Promise((r) => setTimeout(r, 50));

      const args = spy.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.to).toBe('*');
    });

    it('default watcherAgentId is "dep-watcher"', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await new Promise((r) => setTimeout(r, 50));

      const args = spy.mock.calls[0]![0] as Record<string, unknown>;
      expect(args.from).toBe('dep-watcher');
    });

    it('default debounceMs is 3000', () => {
      const cfg = makeDependencyWatcherConfig({ projectRoot, mailbox });
      expect(cfg.debounceMs).toBe(3000);
    });

    it('preserves baseline across half-written JSON saves and normalizes trailing-slash projectRoot paths (F79)', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot: `${projectRoot}/`,
        mailbox,
        debounceMs: 10,
      });
      expect(cfg.watchPaths.some((p) => p.includes('//'))).toBe(false);

      const pkgPath = path.join(projectRoot, 'package.json');
      await fs.writeFile(
        pkgPath,
        `\uFEFF${JSON.stringify({ name: 'f79-app', dependencies: { react: '^19.0.0', zod: '^3.24.0' } })}`,
        'utf8',
      );
      const future = new Date(Date.now() + 2000);
      await fs.utimes(pkgPath, future, future);

      const spy = vi.spyOn(mailbox, 'send');
      await cfg.onChange(makeEntry({ path: 'package.json' }));
      await waitForSend(spy);
      expect(spy).toHaveBeenCalledTimes(1);

      // Half-written truncated JSON save must not clobber the dependency baseline
      await fs.writeFile(pkgPath, '{"name": "f79-app", "dependencies": { "react": ', 'utf8');
      await fs.utimes(pkgPath, new Date(Date.now() + 3000), new Date(Date.now() + 3000));
      await cfg.onChange(makeEntry({ path: './package.json' }));
      await new Promise((r) => setTimeout(r, 35));
      expect(spy).toHaveBeenCalledTimes(1);

      // Subsequent valid save only reports the newly added dependency (immer), not react/zod
      await fs.writeFile(
        pkgPath,
        JSON.stringify({
          name: 'f79-app',
          dependencies: { react: '^19.0.0', zod: '^3.24.0', immer: '^10.0.0' },
        }),
        'utf8',
      );
      await fs.utimes(pkgPath, new Date(Date.now() + 4000), new Date(Date.now() + 4000));
      await cfg.onChange(makeEntry({ path: `${projectRoot.replaceAll('\\', '/')}//package.json` }));
      await new Promise((r) => setTimeout(r, 40));

      expect(spy).toHaveBeenCalledTimes(2);
      const secondCall = spy.mock.calls[1]![0] as { subject: string };
      expect(secondCall.subject).toBe('Dependency added: immer@^10.0.0 (package.json)');
      cfg.dispose();
    });
  });
});
