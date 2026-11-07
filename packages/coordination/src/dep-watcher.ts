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

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { Mailbox } from './mailbox-types.js';
import {
  type DeclaredDependencyMap,
  type DependencyDelta,
  diffDeclaredDependencies,
  hasDependencyChanges,
  parseDeclaredDependencies,
} from './manifest-deps.js';

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
  /** Session ID of the watcher/session (used when targetAgent is '@session'). */
  sessionId?: string | undefined;
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
    sessionId,
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

  const cleanRoot = projectRoot.replace(/[\\/]+$/, '');

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
    watchPaths.push(`${cleanRoot}/${p}`);
    // Also watch subdirectories for nested manifests (monorepos)
    // Pattern: watch the project root recursively — file-watcher
    // will fire for any matching file in the tree.
  }

  // Also watch project root for glob patterns and nested files
  watchPaths.push(cleanRoot || projectRoot);

  // Deduplicate
  const unique = [...new Set(watchPaths)];

  // Absolute paths arrive from the file-watcher plugin; tests and the
  // watch_start tool hand over project-relative ones. Accept both.
  function isAbsolutePath(p: string): boolean {
    const normalized = p.replaceAll('\\', '/');
    return normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized);
  }

  const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/+$/, '');
  const normalizedRootLower = normalizedRoot.toLowerCase();

  function normalizeManifestKey(manifestPath: string): string {
    const slash = manifestPath.replaceAll('\\', '/').replace(/\/+/g, '/').replace(/^\.\//, '');
    if (normalizedRoot.length > 0 && slash.toLowerCase().startsWith(`${normalizedRootLower}/`)) {
      return slash.slice(normalizedRoot.length + 1).replace(/^\/+/, '');
    }
    return slash;
  }

  /**
   * Subject line. When the delta names new packages they lead the subject, so
   * the notification is legible in a mailbox list — and so a consumer that can
   * only read the subject still learns *what* was added, not just which file
   * changed.
   */
  function describeSubject(
    fileName: string,
    added: readonly { readonly name: string; readonly range: string }[],
  ): string {
    if (added.length === 1) {
      const only = added[0]!;
      return `Dependency added: ${only.name}@${only.range || 'unspecified'} (${fileName})`;
    }
    if (added.length > 1) {
      const names = added
        .slice(0, 3)
        .map((d) => d.name)
        .join(', ');
      const rest = added.length - 3;
      return `Dependencies added: ${names}${rest > 0 ? ` +${rest} more` : ''} (${fileName})`;
    }
    return `Dependency file changed: ${fileName}`;
  }

  const isMultiRecipient =
    targetAgent === '*' || targetAgent === '@session' || targetAgent.startsWith('@session:');

  // Globe matcher for wildcard patterns
  const globPatterns = patterns.filter((p) => p.includes('*'));
  const plainPatterns = patterns.filter((p) => !p.includes('*'));

  /**
   * Read the manifest and diff it against the stored baseline.
   *
   * The first time a manifest is seen there is no baseline, so the delta is
   * empty and the notification degrades to the file-level event it always was.
   * That is deliberate: treating "unknown" as "everything is new" would make
   * every session start by auditing the entire repository. From the SECOND
   * change onward the delta is real and names the actual packages.
   *
   * Never throws — an unreadable or half-written manifest yields an empty
   * delta rather than breaking the watcher.
   */
  async function readDelta(manifestPath: string): Promise<DependencyDelta | 'unchanged'> {
    const key = normalizeManifestKey(manifestPath);
    try {
      const absolute = isAbsolutePath(manifestPath)
        ? manifestPath
        : `${cleanRoot}/${manifestPath.replaceAll('\\', '/')}`;
      const rawContent = await fs.readFile(absolute, 'utf8');
      const content = rawContent.replace(/^\uFEFF/, '');
      const lowerName = key.split('/').pop()?.toLowerCase() ?? '';
      if (
        lowerName === 'package.json' ||
        lowerName === 'composer.json' ||
        lowerName === 'vcpkg.json'
      ) {
        try {
          JSON.parse(content);
        } catch {
          // Half-written JSON during an editor save: do not clobber baseline or fingerprint.
          return 'unchanged';
        }
      }
      const current = parseDeclaredDependencies(content, key);
      const delta = diffDeclaredDependencies(baselines.get(key), current);
      baselines.set(key, current);

      // Content gate. On Windows `fs.watch` subscribes to last-access and
      // attribute changes too, and NTFS refreshes a file's last-access time at
      // most once an hour — so the first READ of package.json / tsconfig.json
      // each hour (an index build, tsc, an editor) arrives as `change`. Observed
      // live: tsconfig.json untouched since 09-25 drove an audit spawn every
      // hour, including right at session start. A metadata-only event is not a
      // dependency change, so the bytes decide.
      const fingerprint = createHash('sha256').update(content).digest('hex');
      const previous = fingerprints.get(key);
      fingerprints.set(key, fingerprint);
      if (previous !== undefined) return previous === fingerprint ? 'unchanged' : delta;
      // First sighting: no fingerprint to compare. A file not written since the
      // watcher started cannot have changed under it.
      const { mtimeMs } = await fs.stat(absolute);
      return mtimeMs < startedAt ? 'unchanged' : delta;
    } catch {
      return { added: [], changed: [], removed: [] };
    }
  }

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

  // Debounce state — keyed by canonical manifest path
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  // Last-known declared dependency set per manifest, used to compute the delta.
  const baselines = new Map<string, DeclaredDependencyMap>();
  // Last-seen content hash per manifest, and when watching began — see the
  // content gate in `readDelta`.
  const fingerprints = new Map<string, string>();
  const startedAt = Date.now();

  return {
    watchPaths: unique,
    debounceMs,
    dispose(): void {
      disposed = true;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    },
    async onChange(entry: DepWatchEntry): Promise<void> {
      if (disposed) return;

      // Only react to create/change events (not delete)
      if (entry.event === 'delete') return;

      // The recursive root watch also observes installed package manifests.
      // They are dependency artifacts, not project dependency declarations.
      const pathSegments = entry.path.replaceAll('\\', '/').split('/');
      if (pathSegments.some((segment) => segment.toLowerCase() === 'node_modules')) return;

      // Filter: only dependency files
      if (!matchesPattern(entry.path)) return;

      // Debounce — multiple rapid saves (e.g. auto-format on save) collapse
      const key = normalizeManifestKey(entry.path);
      const existing = pending.get(key);
      if (existing) clearTimeout(existing);

      pending.set(
        key,
        setTimeout(async () => {
          pending.delete(key);
          if (disposed) return;
          try {
            const fileName = entry.path.split('/').pop()?.split('\\').pop() ?? entry.path;
            const delta = await readDelta(entry.path);
            if (disposed || delta === 'unchanged') return;
            const body: string[] = [
              `Manifest: ${entry.path}`,
              `File: ${entry.path}`,
              `Event: ${entry.event}`,
              `Timestamp: ${entry.timestamp}`,
            ];

            // Name the packages when the manifest tells us what changed. Without
            // this the receiving agent only learns "a file changed" and has to
            // re-derive the delta itself — which is how a version bump and a
            // brand-new dependency became indistinguishable downstream.
            if (hasDependencyChanges(delta)) {
              if (delta.added.length > 0) {
                body.push(
                  '',
                  `Added packages (${delta.added.length}):`,
                  ...delta.added.map(
                    (d) => `- ${d.name}@${d.range || 'unspecified'} (${d.section})`,
                  ),
                );
              }
              if (delta.changed.length > 0) {
                body.push(
                  '',
                  `Version changes (${delta.changed.length}):`,
                  ...delta.changed.map(
                    (c) => `- ${c.name}: ${c.from || 'unspecified'} -> ${c.to || 'unspecified'}`,
                  ),
                );
              }
            }

            body.push(
              '',
              `Action: Run a tech-stack audit on the changed dependency file.`,
              `Validate any new packages, check versions, flag deprecated or prehistoric packages.`,
              // Addressee matters: `package-outdated-watcher` polls
              // `{ to: 'pkg-outdated-watcher', type: 'result' }` and is the ONLY
              // component that turns an audit into a notification to the agent
              // who added the package. The line used to say "report findings
              // back via mailbox (type: result)" with no addressee, so results
              // were addressed to whoever the audit chose and never reached it.
              `Report: send type='result' to 'pkg-outdated-watcher', AND type='note' to 'leader'.`,
            );

            await mailbox.send({
              from: watcherAgentId,
              to: targetAgent,
              ...(sessionId !== undefined ? { senderSessionId: sessionId } : {}),
              // `assign` requires a single recipient — the mailbox rejects it
              // for `*` / `@session:` because a task with several owners is
              // ambiguous. The default target IS `*`, so hard-coding `assign`
              // made every notification throw straight into the catch below
              // and vanish. Fan-out goes out as a broadcast instead.
              type: isMultiRecipient ? 'broadcast' : 'assign',
              subject: describeSubject(fileName, delta.added),
              body: body.join('\n'),
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
