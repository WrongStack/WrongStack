import type {
  ConfiguredHook,
  HookEntry,
  HookEvent,
  HookMatcher,
  HookRegistrationOptions,
  HttpHook,
  InProcessHook,
  ShellHook,
} from '../types/hooks.js';

interface LoadConfiguredHooksOptions {
  /** Load only trusted hooks that remain active under `--no-hooks`. */
  policyOnly?: boolean | undefined;
}

function entryControls(
  event: HookEvent,
  fallbackName: string,
  options: HookRegistrationOptions,
  legacyStage: 'mutate' | 'validate',
): Pick<HookEntry, 'name' | 'timeoutMs' | 'failurePolicy' | 'stage' | 'policy' | 'background'> {
  return {
    name: options.name?.trim() || fallbackName,
    timeoutMs: options.timeoutMs,
    failurePolicy: options.failurePolicy ?? 'open',
    // Legacy PreToolUse hooks may rewrite input, so preserve their old
    // behavior unless the registration explicitly opts into final validation.
    stage: event === 'PreToolUse' ? (options.stage ?? legacyStage) : 'validate',
    policy: options.policy === true,
    // `background` only applies to PostToolUse — PreToolUse hooks always block.
    background: event === 'PostToolUse' && options.background === true,
  };
}

/**
 * Registry of lifecycle hooks (both in-process and shell). One instance is
 * shared per session: the boot path loads `config.hooks` as shell entries and
 * plugins add in-process entries via `PluginAPI.registerHook`. The
 * `HookRunner` reads from it at each lifecycle phase.
 */
export class HookRegistry {
  private readonly entries: HookEntry[] = [];

  /** Register an in-process hook. Returns an unsubscribe function. */
  registerInProcess(
    event: HookEvent,
    matcher: HookMatcher | undefined,
    hook: InProcessHook,
    owner?: string | undefined,
    options: HookRegistrationOptions = {},
  ): () => void {
    const entry: HookEntry = {
      kind: 'inprocess',
      event,
      matcher: matcher ?? '*',
      hook,
      owner,
      ...entryControls(
        event,
        owner ? `${owner}:${event}` : `inprocess:${event}`,
        options,
        'mutate',
      ),
    };
    this.entries.push(entry);
    return () => this.remove(entry);
  }

  /**
   * Register a single shell hook. The hook is owned by the runtime (no plugin
   * name) — it survives plugin uninstalls. Returns an unsubscribe function.
   */
  registerShell(event: HookEvent, hook: ShellHook): () => void {
    const entry: HookEntry = {
      kind: 'shell',
      event,
      matcher: hook.matcher ?? '*',
      command: hook.command,
      ...entryControls(event, hook.command, hook, 'validate'),
    };
    this.entries.push(entry);
    return () => this.remove(entry);
  }

  /** Register a native HTTP hook. */
  registerHttp(event: HookEvent, hook: HttpHook): () => void {
    const entry: HookEntry = {
      kind: 'http',
      event,
      matcher: hook.matcher ?? '*',
      url: hook.url,
      headers: hook.headers,
      ...entryControls(event, hook.url, hook, 'validate'),
    };
    this.entries.push(entry);
    return () => this.remove(entry);
  }

  /** Bulk-load command/HTTP hooks from a `config.hooks` map. */
  loadShellHooks(
    hooks: Partial<Record<HookEvent, ConfiguredHook[]>> | undefined,
    options: LoadConfiguredHooksOptions = {},
  ): void {
    if (!hooks) return;
    for (const [event, list] of Object.entries(hooks) as [
      HookEvent,
      ConfiguredHook[] | undefined,
    ][]) {
      for (const h of list ?? []) {
        if (options.policyOnly && h.policy !== true) continue;
        if (h.type === 'http') {
          if (h.url) this.registerHttp(event, h);
        } else if (h.command) {
          this.registerShell(event, h);
        }
      }
    }
  }

  /**
   * Atomically replace the shell-hook set: drop every currently-registered
   * shell entry, then load the supplied `config.hooks` map. In-process
   * hooks (and their plugin owners) are untouched — only shell entries
   * are touched, because they are the only entries sourced from
   * `config.hooks`.
   *
   * Designed for hot-reload via `ConfigStore.watch`: when the operator
   * edits `config.json` and the store fires its watcher, the CLI calls
   * this with the new `config.hooks` value. Idempotent — calling twice
   * with the same map yields the same registry state (callers should still
   * guard at the change-detection layer to avoid wasted work).
   */
  replaceShellHooks(
    hooks: Partial<Record<HookEvent, ConfiguredHook[]>> | undefined,
    options: LoadConfiguredHooksOptions = {},
  ): void {
    // Build the replacement first. If config access or registration throws,
    // the live registry remains untouched.
    const replacement = new HookRegistry();
    replacement.loadShellHooks(hooks, options);
    const configuredEntries = replacement.entries.slice();

    // Drop every configured transport entry. Iterate in reverse so splicing doesn't
    // invalidate the index — same pattern as `drainByOwner`.
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e && e.kind !== 'inprocess') this.entries.splice(i, 1);
    }
    this.entries.push(...configuredEntries);
  }

  /** All entries registered for an event, in registration order. */
  list(event: HookEvent): readonly HookEntry[] {
    return this.entries.filter((e) => e.event === event);
  }

  /** True when any entry is registered for the event. */
  has(event: HookEvent): boolean {
    return this.entries.some((e) => e.event === event);
  }

  /** Every entry currently registered (across all events). */
  all(): readonly HookEntry[] {
    return this.entries.slice();
  }

  /**
   * Drop every in-process hook whose `owner` matches. Used by the plugin
   * loader during teardown as a belt-and-braces backstop for the per-call
   * unsubscribe functions pushed onto `pluginCleanupFns` — if a plugin
   * `setup()` throws partway through after registering some hooks, the
   * remaining unsubscribes may never run, and the registry would otherwise
   * hold dangling references to a torn-down plugin's closures.
   *
   * Returns the number of hooks actually removed (useful for tests).
   * Shell hooks are owned by the runtime, not a plugin, so they're never
   * drained by owner.
   */
  drainByOwner(owner: string): number {
    let removed = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e && e.kind === 'inprocess' && e.owner === owner) {
        this.entries.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** Count of in-process hooks currently registered by `owner`. */
  countByOwner(owner: string): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.kind === 'inprocess' && e.owner === owner) n++;
    }
    return n;
  }

  /** Drop every registered hook (used in teardown / tests). */
  clear(): void {
    this.entries.length = 0;
  }

  private remove(entry: HookEntry): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
  }
}

/**
 * Does a hook matcher apply to a tool name? `*` (or empty) matches everything;
 * otherwise the matcher is a case-insensitive pipe-delimited list of exact
 * tool names (`"edit|write"`). Non-tool events pass `undefined` and always match.
 */
export function hookMatcherMatches(matcher: HookMatcher, toolName: string | undefined): boolean {
  if (!matcher || matcher === '*') return true;
  if (toolName === undefined) return true;
  const target = toolName.toLowerCase();
  return matcher
    .split('|')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}
