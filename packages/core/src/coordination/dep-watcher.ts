/**
 * dep-watcher — File-change → Mailbox bridge for dependency monitoring.
 *
 * Watches dependency manifest files (package.json, go.mod, Cargo.toml, etc.)
 * and when they change (create/update), posts a message to the inter-agent
 * mailbox. A tech-stack analysis agent can then pick up the message and
 * run a full tech-stack validation, feeding results back to the coding LLM.
 *
 * This module is a *config factory*, not a watcher itself. It produces
 * configuration that the file-watcher plugin (`watch_start`) can consume,
 * plus a callback that posts to a Mailbox instance.
 *
 * Usage:
 *   const cfg = makeDependencyWatcherConfig({
 *     projectRoot: '/path/to/project',
 *     mailbox,
 *     targetAgent: 'tech-stack-agent',
 *   });
 *   // cfg.watchPaths   → pass to watch_start
 *   // cfg.onChange     → call on file-watcher:changed events
 *
 * @module dep-watcher
 */

import type { Mailbox } from './mailbox-types.js';

// ── Dependency file patterns ─────────────────────────────────────────────

/**
 * Files that declare project dependencies. When any of these change
 * (create/update), a mailbox message triggers a tech-stack audit.
 */
export const DEPENDENCY_FILE_PATTERNS: ReadonlyArray<string> = [
  'package.json',
  'tsconfig.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'requirements.txt',
  'Pipfile',
  'Pipfile.lock',
  'Gemfile',
  'Gemfile.lock',
  'composer.json',
  'composer.lock',
  'mix.exs',
  'mix.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  '*.csproj',
  'packages.config',
  'pubspec.yaml',
  'pubspec.lock',
  'CMakeLists.txt',
  'conanfile.txt',
  'conanfile.py',
  'vcpkg.json',
];

// ── Types ────────────────────────────────────────────────────────────────

export interface DepWatchEntry {
  /** Relative path from project root that changed. */
  path: string;
  /** Event type from the file watcher: 'change', 'add', 'delete' (rare). */
  event: string;
  /** ISO8601 timestamp of when the change was detected. */
  timestamp: string;
}

export interface DependencyWatcherConfig {
  /** Paths to pass to `watch_start` — the project-root-relative dependency files. */
  watchPaths: string[];
  /** Callback to invoke when a dependency file changes. Posts to mailbox. */
  onChange: (entry: DepWatchEntry) => Promise<void>;
  /** Debounce window in ms — multiple changes to the same file within this window are collapsed. */
  debounceMs: number;
  /** Cancel all in-flight debounce timers. Call when the file watcher is
   *  stopped (session end / project switch) so pending setTimeouts — each
   *  holding a closure over the mailbox + entry — don't leak. */
  dispose: () => void;
}

interface DependencyWatcherOptions {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** The mailbox instance where messages will be posted. */
  mailbox: Mailbox;
  /** Agent id that should receive the tech-stack audit task. */
  targetAgent?: string | undefined;
  /** Agent id of the watcher (sender). */
  watcherAgentId?: string | undefined;
  /** Debounce window in ms. Default: 3000 (3 seconds). */
  debounceMs?: number | undefined;
  /** Only watch these specific patterns. Defaults to DEPENDENCY_FILE_PATTERNS. */
  patterns?: string[] | undefined;
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Build a dependency watcher configuration. The returned `watchPaths` can be
 * passed directly to the `watch_start` tool, and `onChange` should be wired
 * to the `file-watcher:changed` custom event.
 *
 * When a dependency file changes, `onChange` posts a high-priority `assign`
 * message to the mailbox targeting the tech-stack agent, with the changed
 * file path and event type in the body.
 */
export function makeDependencyWatcherConfig(
  opts: DependencyWatcherOptions,
): DependencyWatcherConfig {
  const {
    projectRoot,
    mailbox,
    targetAgent = '*',
    watcherAgentId = 'dep-watcher',
    debounceMs = 3000,
    patterns = DEPENDENCY_FILE_PATTERNS as string[],
  } = opts;

  // Build absolute watch paths. The file-watcher plugin expects directory
  // or file paths — for individual files we pass them directly.
  //
  // Strategy: watch each file individually. The file-watcher plugin handles
  // per-file watching; if a file doesn't exist yet (common for lockfiles on
  // first install), the watcher will fail silently. We also watch the project
  // root recursively for the glob patterns (e.g. *.csproj).
  const watchPaths: string[] = [];

  // Individual named files — watch them directly
  for (const p of patterns) {
    // Glob patterns like *.csproj need a different approach — watch
    // the project root recursively and filter in onChange.
    if (p.includes('*')) {
      // Don't add glob patterns as direct paths — we handle these
      // by watching root + filtering in onChange.
      continue;
    }
    // Watch at project root level
    watchPaths.push(`${projectRoot}/${p}`);
    // Also watch subdirectories for nested manifests (monorepos)
    // Pattern: watch the project root recursively — file-watcher
    // will fire for any matching file in the tree.
  }

  // Also watch project root for glob patterns and nested files
  watchPaths.push(projectRoot);

  // Deduplicate
  const unique = [...new Set(watchPaths)];

  const isMultiRecipient = targetAgent === '*' || targetAgent.startsWith('@session:');

  // Globe matcher for wildcard patterns
  const globPatterns = patterns.filter((p) => p.includes('*'));
  const plainPatterns = patterns.filter((p) => !p.includes('*'));

  function matchesPattern(filePath: string): boolean {
    const basename = filePath.split('/').pop()?.split('\\').pop() ?? '';
    if (plainPatterns.includes(basename)) return true;
    for (const gp of globPatterns) {
      // Simple glob: *.csproj → match any .csproj file
      const regex = new RegExp('^' + gp.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      if (regex.test(basename)) return true;
    }
    return false;
  }

  // Debounce state — keyed by file path
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  return {
    watchPaths: unique,
    debounceMs,
    dispose(): void {
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
    async onChange(entry: DepWatchEntry): Promise<void> {
      // Only react to create/change events (not delete)
      if (entry.event === 'delete') return;

      // Filter: only dependency files
      if (!matchesPattern(entry.path)) return;

      // Debounce — multiple rapid saves (e.g. auto-format on save) collapse
      const key = entry.path;
      const existing = pending.get(key);
      if (existing) clearTimeout(existing);

      pending.set(
        key,
        setTimeout(async () => {
          pending.delete(key);
          try {
            const fileName = entry.path.split('/').pop()?.split('\\').pop() ?? entry.path;
            await mailbox.send({
              from: watcherAgentId,
              to: targetAgent,
              // `assign` requires a single recipient — the mailbox rejects it
              // for `*` / `@session:` because a task with several owners is
              // ambiguous. The default target IS `*`, so hard-coding `assign`
              // made every notification throw straight into the catch below
              // and vanish. Fan-out goes out as a broadcast instead.
              type: isMultiRecipient ? 'broadcast' : 'assign',
              subject: `Dependency file changed: ${fileName}`,
              body: [
                `File: ${entry.path}`,
                `Event: ${entry.event}`,
                `Timestamp: ${entry.timestamp}`,
                '',
                `Action: Run a tech-stack audit on the changed dependency file.`,
                `Validate any new packages, check versions, flag deprecated or prehistoric packages.`,
                `Report findings back via mailbox (type: result).`,
              ].join('\n'),
              priority: 'high',
              taskContext: {
                agentRole: 'tech-stack',
                status: 'pending',
              },
            });
          } catch {
            // Best-effort — a lost notification is better than crashing the watcher
          }
        }, debounceMs),
      );
    },
  };
}
