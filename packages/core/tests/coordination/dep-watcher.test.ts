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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  makeDependencyWatcherConfig,
  DEPENDENCY_FILE_PATTERNS,
  type DepWatchEntry,
} from '../../src/coordination/dep-watcher.js';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import type { Mailbox } from '../../src/coordination/mailbox-types.js';

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

    it('sends a mailbox message when a dependency file changes', async () => {
      const cfg = makeDependencyWatcherConfig({
        projectRoot,
        mailbox,
        debounceMs: 10,
      });
      const spy = vi.spyOn(mailbox, 'send');

      await cfg.onChange(makeEntry({ path: 'package.json', event: 'change' }));

      // Wait for debounce timer
      await new Promise((r) => setTimeout(r, 50));

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
      await new Promise((r) => setTimeout(r, 50));

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
      await new Promise((r) => setTimeout(r, 50));

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
  });
});
