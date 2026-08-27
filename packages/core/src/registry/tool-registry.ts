import type { EventBus } from '../kernel/events.js';
import type {
  DisabledToolMeta,
  ToolDescriptionMode,
  ToolDescriptionModeConfig,
} from '../types/config.js';
import { ERROR_CODES, WrongStackError } from '../types/errors.js';
import type { Tool } from '../types/tool.js';
import { estimateToolDefTokens } from '../utils/token-estimate.js';
import {
  applyToolDescriptionModeToTool,
  normalizeToolDescriptionMode,
} from '../utils/tool-description-mode.js';

/**
 * A function that wraps (decorates) an existing tool. Receives the
 * original tool and returns a modified version — typically the same
 * tool with a wrapped `execute` / `executeStream`, or with modified
 * metadata (description, permission).
 *
 * Use `ToolRegistry.wrap()` to apply; the wrapper is called immediately
 * and the result replaces the registered tool. Multiple wraps stack —
 * each wrapper receives the output of the previous.
 *
 * @example
 * ```ts
 * registry.wrap('read', (original) => ({
 *   ...original,
 *   async execute(input, ctx, opts) {
 *     console.log('read called');
 *     return original.execute(input, ctx, opts);
 *   }
 * }));
 * ```
 */
export type ToolWrapper = (tool: Tool) => Tool;

export class ToolRegistry {
  private readonly tools = new Map<string, { tool: Tool; owner: string }>();
  private readonly descriptionModes = new Map<string, ToolDescriptionMode>();
  /**
   * Disabled tool names plus the audit-trail metadata explaining WHY each
   * one was disabled. `user` is the historical default (manual
   * `/tool disable`); `auto-thinned` is the new path the auto-thinning
   * pipeline writes so `/tool autothin undo` can restore the right subset.
   * The underlying tool data stays in `_tools` so re-enable is constant-time.
   */
  private readonly _disabled = new Map<string, DisabledToolMeta>();
  /**
   * Optional EventBus used by `thinUnderused()` to emit `tool.thinned`.
   * Set via `setEventBus()` at boot — optional so the registry stays
   * usable in pure unit tests and in code paths that never run the
   * auto-thinning pipeline.
   */
  private _events: EventBus | undefined;
  /** Monotonic version bumped on every registry mutation. */
  private _version = 0;
  /** Cached `list()` result, frozen after build. Invalidated on _version change. */
  private _listSnapshot: readonly Tool[] | undefined;
  private _listSnapshotVersion = -1;
  /**
   * Optional direct provider surface. `undefined` preserves the legacy
   * behaviour (every enabled catalog tool is direct); when set, `list()` still
   * exposes the complete executable catalog while `listForProvider()` returns
   * only these names. This keeps lazy tools discoverable by tool_search/tool_use.
   */
  private _providerToolNames: Set<string> | undefined;
  private _providerListSnapshot: readonly Tool[] | undefined;
  private _providerListSnapshotVersion = -1;

  /** Pre-compute tool definition token estimate once at registration time. */
  private _stampDefTokens(tool: Tool): void {
    if (tool._estDefTokens === undefined) {
      tool._estDefTokens = estimateToolDefTokens(tool);
    }
  }

  /** Apply the description mode transform and stamp token estimates. */
  private _prepareForStorage(tool: Tool): Tool {
    const mode = this.descriptionModes.get(tool.name) ?? 'extend';
    return applyToolDescriptionModeToTool(tool, mode);
  }

  register(tool: Tool, owner = 'core'): void {
    if (this.tools.has(tool.name)) {
      throw new WrongStackError({
        message: `Tool "${tool.name}" already registered`,
        code: ERROR_CODES.REGISTRY_DUPLICATE,
        subsystem: 'container',
        context: { tool: tool.name },
      });
    }

    // Registration-time guarantee: Every tool must have a usable inputSchema.
    // This prevents tools with broken or missing schemas from ever being registered.
    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      throw new WrongStackError({
        message: `Tool "${tool.name}" has an invalid or missing inputSchema`,
        code: ERROR_CODES.REGISTRY_INVALID,
        subsystem: 'container',
        context: { tool: tool.name },
      });
    }

    const stored = this._prepareForStorage(tool);
    this._stampDefTokens(stored);
    this.tools.set(tool.name, { tool: stored, owner });
    this._version++;
  }

  /**
   * Attempt to register a tool. Returns true if successful, false if a tool
   * with the same name is already registered. Useful in multi-agent or plugin
   * scenarios where duplicate registration may be intentional.
   */
  tryRegister(tool: Tool, owner = 'core'): boolean {
    if (this.tools.has(tool.name)) return false;

    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      return false; // silently reject invalid schema in tryRegister
    }

    const stored = this._prepareForStorage(tool);
    this._stampDefTokens(stored);
    this.tools.set(tool.name, { tool: stored, owner });
    this._version++;
    return true;
  }

  /**
   * Bulk-register multiple tools at once. Each tool that conflicts with an
   * existing registration is silently skipped — use `registerAllOrThrow`
   * if you want it to throw on conflicts.
   */
  registerAll(tools: Tool[], owner = 'core'): void {
    for (const tool of tools) this.tryRegister(tool, owner);
  }

  /**
   * Bulk-register and throw on the first conflict. Use when you need
   * strict registration (e.g. at boot time).
   */
  registerAllOrThrow(tools: Tool[], owner = 'core'): void {
    for (const tool of tools) this.register(tool, owner);
  }

  /**
   * Register a tool as a default. If the tool name is already registered,
   * this is a no-op — the existing registration (from core or another
   * plugin) takes precedence. Use `override` to intentionally replace.
   */
  registerDefault(tool: Tool, owner = 'core'): void {
    if (this.tools.has(tool.name)) return;
    const stored = this._prepareForStorage(tool);
    this._stampDefTokens(stored);
    this.tools.set(tool.name, { tool: stored, owner });
    this._version++;
  }

  unregister(name: string): boolean {
    const deleted = this.tools.delete(name);
    if (deleted) this._version++;
    return deleted;
  }

  /**
   * Override an existing tool. Throws if the tool is not already registered.
   * Plugins use this to replace built-in tools with custom implementations.
   */
  override(name: string, tool: Tool, owner = 'core'): void {
    if (!this.tools.has(name)) {
      throw new WrongStackError({
        message: `Tool "${name}" not registered; cannot override`,
        code: ERROR_CODES.REGISTRY_NOT_FOUND,
        subsystem: 'container',
        context: { tool: name },
      });
    }
    const stored = this._prepareForStorage(tool);
    this._stampDefTokens(stored);
    this.tools.set(name, { tool: stored, owner });
    this._version++;
  }

  /**
   * Wrap (decorate) an existing tool. The wrapper receives the current
   * tool and must return a new tool — typically the same tool with a
   * wrapped `execute` or `executeStream`. Throws if the tool is not
   * registered.
   *
   * Multiple wraps stack: each wrapper gets the output of the previous.
   *
   * @example
   * registry.wrap('bash', (t) => ({ ...t, permission: 'confirm' }));
   */
  wrap(name: string, wrapper: ToolWrapper, owner = 'core'): void {
    const entry = this.tools.get(name);
    if (!entry) {
      throw new WrongStackError({
        message: `Tool "${name}" not registered; cannot wrap`,
        code: ERROR_CODES.REGISTRY_NOT_FOUND,
        subsystem: 'container',
        context: { tool: name },
      });
    }
    const current = applyToolDescriptionModeToTool(entry.tool, 'extend');
    const wrapped = this._prepareForStorage(wrapper(current));
    // The wrapper may have changed name/description/inputSchema — recompute.
    wrapped._estDefTokens = undefined;
    this._stampDefTokens(wrapped);
    this.tools.set(name, { tool: wrapped, owner: `${entry.owner}+${owner}` });
    this._version++;
  }

  setDescriptionMode(name: string, mode: ToolDescriptionMode): boolean {
    const normalized = normalizeToolDescriptionMode(mode);
    if (!normalized) return false;
    const entry = this.tools.get(name);
    if (!entry) return false;

    if (normalized === 'extend') {
      this.descriptionModes.delete(name);
    } else {
      this.descriptionModes.set(name, normalized);
    }

    const stored = applyToolDescriptionModeToTool(entry.tool, normalized);
    stored._estDefTokens = undefined;
    this._stampDefTokens(stored);
    this.tools.set(name, { ...entry, tool: stored });
    this._version++;
    return true;
  }

  getDescriptionMode(name: string): ToolDescriptionMode {
    return this.descriptionModes.get(name) ?? 'extend';
  }

  applyDescriptionModes(modes: ToolDescriptionModeConfig = {}): {
    applied: number;
    missing: string[];
  } {
    const missing: string[] = [];
    let applied = 0;
    for (const [name, rawMode] of Object.entries(modes)) {
      const mode = normalizeToolDescriptionMode(rawMode);
      if (!mode) continue;
      if (this.tools.has(name)) {
        if (this.setDescriptionMode(name, mode)) applied++;
      } else {
        if (mode === 'simple') this.descriptionModes.set(name, mode);
        else this.descriptionModes.delete(name);
        missing.push(name);
      }
    }
    return { applied, missing };
  }

  get(name: string): Tool | undefined {
    if (this._disabled.has(name)) return undefined;
    return this.tools.get(name)?.tool;
  }

  ownerOf(name: string): string | undefined {
    return this.tools.get(name)?.owner;
  }

  // ── Disable / enable ────────────────────────────────────────────

  /** Attach the EventBus so `thinUnderused()` can emit `tool.thinned`.
   *  Idempotent; safe to call multiple times at boot. */
  setEventBus(events: EventBus | undefined): void {
    this._events = events;
  }

  /**
   * Disable a tool by name. The tool is removed from all public accessors
   * (list(), get(), listByCategory(), listWithOwner()) so it does NOT
   * appear in the system prompt or provider request. The underlying
   * registration is preserved in memory — use `enable()` to restore it.
   *
   * `reason` defaults to `'user'` for backward compatibility — every
   * historical caller (CLI `/tool disable`, WebUI, subagent filter)
   * writes a user-authored disable. The auto-thinning pipeline always
   * passes `'auto-thinned'`.
   *
   * @returns `true` if the tool was found and disabled; `false` if the
   *          tool is not registered or is already disabled.
   */
  disable(
    name: string,
    reason: 'user' | 'auto-thinned' = 'user',
    meta?: { caller?: string },
  ): boolean {
    if (!this.tools.has(name) || this._disabled.has(name)) return false;
    this._disabled.set(name, {
      reason,
      at: Date.now(),
      ...(meta?.caller ? { caller: meta.caller } : {}),
    });
    this._version++;
    return true;
  }

  /**
   * Re-enable a previously disabled tool. The tool reappears in all
   * public accessors and will be included in the next system prompt /
   * provider request.
   *
   * @returns `true` if the tool was disabled and is now re-enabled;
   *          `false` if the tool was not disabled.
   */
  enable(name: string): boolean {
    if (!this._disabled.has(name)) return false;
    this._disabled.delete(name);
    this._version++;
    return true;
  }

  /**
   * Re-enable ALL currently disabled tools at once. Returns the number
   * of tools that were re-enabled.
   */
  enableAll(): number {
    const count = this._disabled.size;
    if (count === 0) return 0;
    this._disabled.clear();
    this._version++;
    return count;
  }

  /**
   * Re-enable only the tools that were disabled by the auto-thinning
   * pipeline (`reason === 'auto-thinned'` in `disabledToolMeta`). Manual
   * user disables are preserved. Returns the names that were re-enabled.
   */
  enableAutoThinned(): string[] {
    const restored: string[] = [];
    for (const [name, meta] of this._disabled) {
      if (meta.reason === 'auto-thinned') {
        this._disabled.delete(name);
        restored.push(name);
      }
    }
    if (restored.length > 0) this._version++;
    return restored;
  }

  /**
   * Check whether a tool is currently disabled.
   */
  isDisabled(name: string): boolean {
    return this._disabled.has(name);
  }

  /** Return the audit-trail metadata for a disabled tool, if any. */
  disabledMeta(name: string): DisabledToolMeta | undefined {
    return this._disabled.get(name);
  }

  /**
   * Apply a list of tool names to disable. Tools not in the registry
   * are silently ignored so config can reference future tools without
   * error. Returns the number of tools actually disabled. Always
   * tagged `reason: 'user'` — the auto-thinning pipeline uses
   * `thinUnderused()` instead.
   */
  applyDisabled(names: readonly string[]): number {
    let count = 0;
    for (const name of names) {
      if (this.disable(name, 'user')) count++;
    }
    return count;
  }

  /**
   * Apply the audit-trail metadata for a previously-disabled tool.
   * Used at boot to restore `disabledToolMeta` (so the auto-thinned
   * decision survives a restart). Does NOT mutate the disabled set
   * itself — pair with `applyDisabled()` on the same names.
   */
  applyDisabledMeta(meta: Readonly<Record<string, DisabledToolMeta>>): number {
    let count = 0;
    const at = Date.now();
    for (const [name, entry] of Object.entries(meta)) {
      if (!this._disabled.has(name)) continue;
      this._disabled.set(name, { ...entry, at: entry.at ?? at });
      count++;
    }
    if (count > 0) this._version++;
    return count;
  }

  /**
   * Disable every name in `candidates` that is currently registered and
   * not already disabled, tagged with `reason: 'auto-thinned'`. Emits
   * a `tool.thinned` event with the names that actually flipped.
   *
   * @returns `{ thinned, skipped }` so the caller can persist the
   *  decision to `disabledToolMeta` and report what was changed.
   */
  thinUnderused(
    candidates: readonly string[],
    caller: string,
  ): { thinned: string[]; skipped: string[] } {
    const thinned: string[] = [];
    const skipped: string[] = [];
    const at = Date.now();
    for (const name of candidates) {
      if (!this.tools.has(name)) {
        skipped.push(name);
        continue;
      }
      if (this._disabled.has(name)) {
        skipped.push(name);
        continue;
      }
      this._disabled.set(name, { reason: 'auto-thinned', at, caller });
      thinned.push(name);
    }
    if (thinned.length > 0) {
      this._version++;
      this._events?.emit('tool.thinned', { names: thinned, reason: caller, at });
    }
    return { thinned, skipped };
  }

  /**
   * Return the list of all disabled tool entries (tool + owner + reason).
   * Useful for the /tools slash command to show disabled tools alongside
   * enabled ones, and for `/tool autothin status` to count the auto-thinned subset.
   */
  listDisabled(): { tool: Tool; owner: string; meta: DisabledToolMeta }[] {
    const out: { tool: Tool; owner: string; meta: DisabledToolMeta }[] = [];
    for (const [name, meta] of this._disabled) {
      const entry = this.tools.get(name);
      if (!entry) continue;
      out.push({ tool: entry.tool, owner: entry.owner, meta });
    }
    return out;
  }

  list(): Tool[] {
    if (this._listSnapshot && this._version === this._listSnapshotVersion) {
      return this._listSnapshot as Tool[];
    }
    const arr = Array.from(this.tools.entries())
      .filter(([name]) => !this._disabled.has(name))
      .map(([, entry]) => entry.tool);
    this._listSnapshot = arr;
    this._listSnapshotVersion = this._version;
    return arr;
  }

  /** Replace the direct provider surface. Pass `undefined` to expose the catalog. */
  setProviderToolNames(names: readonly string[] | undefined): void {
    this._providerToolNames = names ? new Set(names) : undefined;
    this._version++;
  }

  /** Add registered or future tool names to the direct provider surface. */
  exposeToProvider(names: string | readonly string[]): void {
    if (!this._providerToolNames) return;
    for (const name of typeof names === 'string' ? [names] : names) {
      this._providerToolNames.add(name);
    }
    this._version++;
  }

  /** Tools serialized into provider requests and described by the system prompt. */
  listForProvider(): Tool[] {
    if (!this._providerToolNames) return this.list();
    if (this._providerListSnapshot && this._version === this._providerListSnapshotVersion) {
      return this._providerListSnapshot as Tool[];
    }
    const arr = Array.from(this.tools.entries())
      .filter(([name]) => !this._disabled.has(name) && this._providerToolNames?.has(name) === true)
      .map(([, entry]) => entry.tool);
    this._providerListSnapshot = arr;
    this._providerListSnapshotVersion = this._version;
    return arr;
  }

  /**
   * Whether an enabled catalog tool is part of the direct provider surface.
   *
   * This is intentionally different from `get()`/`list()`: a tool can remain
   * executable through a lazy gateway while its schema is omitted from the
   * next provider request. Disabled and unknown tools always return false.
   */
  isExposedToProvider(name: string): boolean {
    if (this._disabled.has(name) || !this.tools.has(name)) return false;
    return this._providerToolNames?.has(name) ?? true;
  }

  /**
   * Group tools by their `category` field. Tools without a category
   * are placed under the key `""` (empty string). Returns a Map of
   * category → tools, sorted by registration order within each category.
   */
  listByCategory(): Map<string, Tool[]> {
    const map = new Map<string, Tool[]>();
    for (const [name, { tool }] of this.tools) {
      if (this._disabled.has(name)) continue;
      const cat = tool.category ?? '';
      let group = map.get(cat);
      if (!group) {
        group = [];
        map.set(cat, group);
      }
      group.push(tool);
    }
    return map;
  }

  listWithOwner(): { tool: Tool; owner: string }[] {
    return Array.from(this.tools.entries())
      .filter(([name]) => !this._disabled.has(name))
      .map(([, entry]) => entry);
  }

  clear(): void {
    this.tools.clear();
    this.descriptionModes.clear();
    this._disabled.clear();
    this._providerToolNames = undefined;
    this._version++;
  }

  /**
   * Return a new ToolRegistry with the same registered tools and owners.
   * Useful for creating filtered copies in multi-agent scenarios.
   */
  clone(): ToolRegistry {
    const copy = new ToolRegistry();
    copy.descriptionModes.clear();
    for (const [name, mode] of this.descriptionModes) {
      copy.descriptionModes.set(name, mode);
    }
    // Re-register all tools (including disabled ones — they need to be in
    // the copy's _tools map to be re-enableable later).
    for (const [name, { tool, owner }] of this.tools) {
      copy.tools.set(name, { tool, owner });
    }
    // Copy the disabled map so the clone has the same visibility state
    // and audit-trail metadata.
    for (const [name, meta] of this._disabled) {
      copy._disabled.set(name, { ...meta });
    }
    copy._providerToolNames = this._providerToolNames
      ? new Set(this._providerToolNames)
      : undefined;
    copy._version = this._version;
    return copy;
  }
}
