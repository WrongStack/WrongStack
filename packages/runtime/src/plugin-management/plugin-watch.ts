import { type FSWatcher, watch as fsWatch, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  defaultPluginTrustPath,
  discoverExternalPlugins,
  hashPluginDirectoryClosure,
  normalizeTrustKey,
  pinPluginTrust,
} from '@wrongstack/core/plugin';

/**
 * Normalizes `/plugin reload [name|--all|*]` arguments so `--all` and `*`
 * map cleanly to `undefined` ("reload all external plugins").
 */
export function normalizePluginReloadTarget(raw?: string): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === '--all' || trimmed === '*') return undefined;
  return trimmed;
}

/**
 * Parse `/plugin reload [name|--all|*] [--force|-f]` tokens so `--force` never
 * collides with the positional plugin target name.
 */
export function parsePluginReloadArgs(tokens: readonly string[]): {
  targetName: string | undefined;
  force: boolean;
} {
  let force = false;
  let positional: string | undefined;
  for (const tok of tokens) {
    if (tok === '--force' || tok === '-f') {
      force = true;
      continue;
    }
    if (tok === '--all' || tok === '*') {
      positional = undefined;
      continue;
    }
    if (!tok.startsWith('-') && positional === undefined) {
      positional = tok;
    }
  }
  return { targetName: normalizePluginReloadTarget(positional), force };
}

export interface PluginDevWatchOptions {
  globalRoot?: string | undefined;
  projectRoot?: string | undefined;
  debounceMs?: number | undefined;
  onReload: (pluginName: string) => Promise<unknown>;
  onError?: ((pluginName: string, error: unknown) => void) | undefined;
}

interface ActivePluginWatch {
  name: string;
  targetPath: string;
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: boolean;
  queued: boolean;
}

function isStrictlyInside(parentDir: string, candidatePath: string): boolean {
  const rel = relative(parentDir, candidatePath);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function shouldIgnoreWatchFilename(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const parts = filename.split(/[/\\]/);
  return parts.some(
    (seg) =>
      seg === '.git' ||
      seg === 'node_modules' ||
      seg.endsWith('.tmp') ||
      seg.endsWith('~') ||
      seg.startsWith('.#'),
  );
}

/**
 * Session-scoped developer file watcher for `/plugin watch <name|off>`.
 *
 * Security boundary: `/plugin watch` is strictly restricted to user-global
 * plugins under `~/.wrongstack/plugins/` and is never persisted to config or
 * permitted on `<projectRoot>/.wrongstack/plugins/`.
 */
export class PluginDevWatchController {
  private readonly watches = new Map<string, ActivePluginWatch>();

  list(): string[] {
    return [...this.watches.keys()].sort();
  }

  async handleCommand(args: readonly string[], opts: PluginDevWatchOptions): Promise<string> {
    const first = args[0]?.trim();
    if (!first || first === 'list' || first === 'status') {
      const active = this.list();
      return active.length === 0
        ? 'No user-global plugins are currently watched. Usage: /plugin watch <name> | /plugin watch off [name]'
        : `Watching user-global plugin(s): ${active.join(', ')}`;
    }
    if (first === 'off' || first === '--stop' || first === 'stop') {
      const target = args[1]?.trim();
      const stopped = this.unwatch(target);
      if (stopped.length === 0) {
        return target
          ? `Plugin "${target}" is not currently being watched.`
          : 'No active plugin watchers to stop.';
      }
      return `Stopped watching: ${stopped.join(', ')}`;
    }
    return this.watch(first, opts);
  }

  async watch(rawName: string, opts: PluginDevWatchOptions): Promise<string> {
    const name = rawName.trim();
    if (!name || /[/\\]|\.\.|\s/.test(name)) {
      return [
        `Security boundary: invalid plugin name "${rawName}".`,
        '/plugin watch <name> accepts only a bare plugin name inside ~/.wrongstack/plugins/ (never paths or project-local plugins).',
      ].join('\n');
    }

    const globalRoot = resolve(opts.globalRoot ?? join(homedir(), '.wrongstack'));
    const userPluginsDir = join(globalRoot, 'plugins');

    const { candidates: userCandidates } = await discoverExternalPlugins([userPluginsDir]);
    const candidate = userCandidates.find((c) => c.name === name);
    if (!candidate) {
      if (opts.projectRoot) {
        const projectPluginsDir = join(resolve(opts.projectRoot), '.wrongstack', 'plugins');
        const { candidates: projectCandidates } = await discoverExternalPlugins([
          projectPluginsDir,
        ]);
        if (projectCandidates.some((c) => c.name === name)) {
          return [
            `Refused to watch project-local plugin "${name}".`,
            'Security boundary: /plugin watch is restricted strictly to user-global plugins under ~/.wrongstack/plugins/ and is never allowed for <projectRoot>/.wrongstack/plugins/.',
          ].join('\n');
        }
      }
      return `Could not find a user-global plugin named "${name}" under ${userPluginsDir}.`;
    }

    let realRoot: string;
    let realEntry: string;
    try {
      realRoot = realpathSync(userPluginsDir);
      realEntry = realpathSync(candidate.entryPath);
    } catch (err) {
      return `Could not resolve "${candidate.entryPath}": ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!isStrictlyInside(realRoot, realEntry)) {
      return `Refused to watch "${name}": resolved target escapes ${realRoot}.`;
    }

    const candidateParent = dirname(realEntry);
    const isDirectoryPlugin = realpathSync(candidateParent) !== realRoot;
    const watchTarget = isDirectoryPlugin ? candidateParent : realEntry;
    let recursive = false;
    if (isDirectoryPlugin) {
      try {
        recursive = statSync(watchTarget).isDirectory();
      } catch {
        recursive = false;
      }
    }

    this.unwatch(name);

    const debounceMs = Math.max(40, opts.debounceMs ?? 200);
    const trustPath = defaultPluginTrustPath(globalRoot);

    const triggerReload = async (state: ActivePluginWatch): Promise<void> => {
      if (this.watches.get(name) !== state) return;
      if (state.running) {
        state.queued = true;
        return;
      }
      state.running = true;
      try {
        do {
          state.queued = false;
          const integrity = await hashPluginDirectoryClosure(realEntry, [realRoot]);
          const canonical = normalizeTrustKey(realEntry);
          await pinPluginTrust(trustPath, canonical, canonical, integrity, name);
          await opts.onReload(name);
        } while (state.queued && this.watches.get(name) === state);
      } catch (err) {
        opts.onError?.(name, err);
      } finally {
        state.running = false;
      }
    };

    const watcher = fsWatch(watchTarget, { recursive }, (_eventType, filename) => {
      if (shouldIgnoreWatchFilename(filename)) return;
      const state = this.watches.get(name);
      if (!state) return;
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void triggerReload(state);
      }, debounceMs);
      state.timer.unref?.();
    });
    watcher.unref?.();

    this.watches.set(name, {
      name,
      targetPath: watchTarget,
      watcher,
      timer: undefined,
      running: false,
      queued: false,
    });

    return `Watching user-global plugin "${name}" (${watchTarget}) for live reload. Stop with \`/plugin watch off ${name}\`.`;
  }

  unwatch(name?: string): string[] {
    const targets = name ? (this.watches.has(name) ? [name] : []) : [...this.watches.keys()];
    for (const key of targets) {
      const entry = this.watches.get(key);
      if (!entry) continue;
      this.watches.delete(key);
      if (entry.timer) clearTimeout(entry.timer);
      try {
        entry.watcher.close();
      } catch {
        // Ignore already-closed watcher errors.
      }
    }
    return targets;
  }

  dispose(): void {
    this.unwatch();
  }
}
