import type { Context } from '../core/context.js';
import type { SlashCommand } from '../types/slash-command.js';

/**
 * A slash command registered with the CLI or available to plugins.
 * Plugins receive a view of the registry via PluginAPI.slashCommands.
 *
 * Commands registered by plugins use a namespaced name: `pluginName:commandName`.
 * This prevents collisions with built-in commands and other plugins.
 */
export type { SlashCommand };

/** Module scope on purpose: one notice per collision per process. */
const REFUSED_WRITE_CODE = 'WRONGSTACK_SLASH_COMMAND_REFUSED_WRITE';
const REFUSED_WRITE_NOTICES = new Set<string>();

import { toErrorMessage } from '../utils/error.js';

/**
 * Sink for a slash-command refusal notice, given the complete message text.
 * The CLI host wires this to its logger so the notice lands in the log
 * instead of only on stderr.
 */
export type SlashCommandNotice = (message: string) => void;

export interface SlashCommandRegistryOptions {
  /**
   * Optional host sink for refusal notices. When omitted, the notice falls back
   * to `process.emitWarning` — stderr stays the default surface, so tests and
   * minimal hosts keep working unchanged.
   */
  readonly onNotice?: SlashCommandNotice;
}

export class SlashCommandRegistry {
  /**
   * Every key maps to the command it routes to. A key is a *built-in alias*
   * when its owner is `core` and it is not that command's own `name` — that
   * relation is what `isCoreOwnedAlias` re-derives, so no extra flag is
   * stored for it.
   */
  private readonly cmds = new Map<
    string,
    { cmd: SlashCommand; owner: string; official: boolean }
  >();

  /** Host sink for refusal notices; undefined keeps stderr as the surface. */
  private readonly onNotice: SlashCommandNotice | undefined;

  constructor(opts?: SlashCommandRegistryOptions) {
    this.onNotice = opts?.onNotice;
  }

  /**
   * True when `key` is an alias a built-in answers to — e.g. `stop` for
   * `/interrupt`. Such a key is reserved for the built-in family: an official
   * plugin may override a built-in's *bare name*, but taking one of its
   * aliases would silently re-point a key the user already types.
   *
   * A plugin can never *create* one of these: alias keys are only written with
   * the registering command's own `owner`, so a plugin-owned `key === name`
   * entry stays claimable and a built-in re-registering its own command keeps
   * its aliases (both are required by hot reload and React strict mode).
   */
  private isCoreOwnedAlias(key: string): boolean {
    const existing = this.cmds.get(key);
    return existing !== undefined && existing.owner === 'core' && existing.cmd.name !== key;
  }

  /**
   * True when an incoming alias write must NOT re-point `key`.
   *
   * The reservation is symmetric and has exactly one escape hatch: a command
   * may always rebind its OWN aliases. The comparison is made against the
   * incoming command's *name*, never against `existing.owner === owner &&
   * existing.cmd.name === key` — on an alias key that second test is
   * self-contradictory (`existing.cmd.name` is the canonical name, which by
   * definition differs from the alias), so it can never hold and the guard ends
   * up blocking the rebinds it exists to allow: an official `/exit` override
   * from owner `tui` would claim the bare name yet be refused its own `quit`
   * and `q`, leaving them dispatching to the core command it replaced.
   */
  private isAliasReservedKey(key: string, cmdName: string, official: boolean): boolean {
    const existing = this.cmds.get(key);
    if (existing === undefined) return false;
    // Rebinding the same command's alias: allowed for a built-in
    // re-registration and for an official override that holds the canonical
    // name.
    if (official && existing.cmd.name === cmdName) return false;
    if (existing.owner === 'core') {
      return this.isCoreOwnedAlias(key);
    }
    // A plugin's bare-name key is reserved against a built-in's alias loop.
    // External plugins never receive a bare write, so `official` is implied.
    return existing.cmd.name === key && !this.isCoreOwnedAlias(key);
  }

  /**
   * Register a command.
   *
   * Trust tiers, by `owner` and `opts.official`:
   *
   *  - **Built-ins** (`owner === 'core'`) and **official plugins**
   *    (`opts.official === true`, set by the host only for first-party plugins
   *    loaded from the built-in factory list) claim the **bare** command name
   *    (`/prompts`). They may override one another — last write wins — so an
   *    official plugin can replace a built-in. Official plugins are *also*
   *    reachable under their `owner:name` namespace.
   *  - **External plugins** (any other `owner`) are isolated under the
   *    `owner:name` namespace: invocable only as `/owner:cmd`, never by bare
   *    name, and unable to shadow or override a built-in or official command.
   *
   * Officiality is supplied by the host based on the plugin's load source, not
   * self-declared by the plugin — an external plugin cannot name itself into
   * the official tier.
   */
  register(cmd: SlashCommand, owner = 'core', opts?: { official?: boolean | undefined }): void {
    const isPlugin = owner !== 'core';
    const official = !isPlugin || opts?.official === true;

    if (official) {
      // A core built-in must not clobber a bare name an official plugin has
      // already claimed (the plugin's override wins regardless of load order).
      // Two core registrations of the same name are a silent no-op (guards
      // React strict-mode double mounts). Official plugins always (re)claim
      // the bare name — overriding a built-in, another official plugin, or
      // their own prior registration (hot reload).
      const existing = this.cmds.get(cmd.name);
      if (existing) {
        const existingIsOfficialPlugin = existing.official && existing.owner !== 'core';
        if (!isPlugin && existingIsOfficialPlugin) {
          // core yielding to an official plugin: still expose the namespaced
          // form below for nothing (core has no namespace), so just bail.
          return;
        }
        if (!isPlugin && existing.owner === 'core') return;
      }
      const heldName = this.cmds.get(cmd.name);
      // A built-in's alias key outranks a plugin's bare-name claim: refusing it
      // keeps `/stop` (alias of `/interrupt`) aborting the run even when
      // plug-lsp registers a command literally named `stop`. Only the bare
      // write is withheld — the namespaced keys are still indexed, which is how
      // the plugin stays reachable as `/owner:stop`.
      if (isPlugin && official && this.isCoreOwnedAlias(cmd.name)) {
        this.warnRefusedWrite(cmd.name, cmd.name, owner, heldName);
        this.registerNamespaced(cmd, owner, official);
        return;
      }
      this.cmds.set(cmd.name, { cmd, owner, official });
      for (const a of cmd.aliases ?? []) {
        const heldAlias = this.cmds.get(a);
        if (this.isAliasReservedKey(a, cmd.name, official)) {
          this.warnRefusedWrite(a, cmd.name, owner, heldAlias);
          continue;
        }
        this.cmds.set(a, { cmd, owner, official });
      }
    }

    if (isPlugin) {
      // Every plugin — official or external — is reachable under its namespace.
      this.registerNamespaced(cmd, owner, official);
    }
  }

  /**
   * Deliver a refusal notice. The host sink is the *same* message text — the
   * only thing it changes is where it lands — and stderr stays the fallback so
   * a host that never opts in loses nothing.
   */
  private emitRefusal(warning: string): void {
    if (this.onNotice) {
      this.onNotice(warning);
      return;
    }
    process.emitWarning(warning, { code: REFUSED_WRITE_CODE });
  }

  /**
   * Surface a write the alias-reservation rules refused. Best-effort host
   * notice, never an error: losing the collision is the correct outcome (the
   * holder keeps answering the key), but until now it was completely silent, so
   * a plugin author whose bare command stopped working had nothing to read.
   *
   * `holder` is the entry that won the key, and the notice names its COMMAND —
   * `"/stop" is held for "/interrupt"`, the fact that actually tells someone
   * what to do. Naming the holder's `owner` instead reads `"held for /core"`,
   * which identifies no command.
   *
   * Deduped at module scope: `register` runs again on every hot reload and
   * React strict-mode double mount, and registries are re-created per surface,
   * so a per-instance set would re-announce the same production collision once
   * per instance. Keyed by holder owner + holder command + key + caller, so a
   * genuinely new collision still gets its own notice.
   */
  private warnRefusedWrite(
    key: string,
    cmdName: string,
    owner: string,
    holder?: { cmd: SlashCommand; owner: string },
  ): void {
    if (!holder) return;
    const dedupeKey = `${holder.owner}:${holder.cmd.name}:${key}:${owner}:${cmdName}`;
    if (REFUSED_WRITE_NOTICES.has(dedupeKey)) return;
    REFUSED_WRITE_NOTICES.add(dedupeKey);
    const who = holder.owner === 'core' ? 'a built-in' : `owner "${holder.owner}"`;
    const relation =
      holder.cmd.name === key ? 'its canonical command name' : `an alias of "/${holder.cmd.name}"`;
    // The fallback form must actually exist. `registerNamespaced` runs only for
    // plugins, so core has no `core:name` key to advertise — and a core caller
    // refused on an alias has already had its canonical bare name written, so
    // "reachable only as" would be false twice over.
    const reachable =
      owner === 'core'
        ? `Its own name "/${cmdName}" is unaffected.`
        : `It is reachable only as "/${owner}:${cmdName}".`;
    this.emitRefusal(
      `Slash command "/${key}" already belongs to ${who} (${relation}); ` +
        `${owner}'s registration of "/${cmdName}" was refused. ${reachable}`,
    );
  }

  /** Index a plugin's own command under `owner:name` and `owner:<alias>`. */
  private registerNamespaced(cmd: SlashCommand, owner: string, official: boolean): void {
    this.cmds.set(`${owner}:${cmd.name}`, { cmd, owner, official });
    for (const a of cmd.aliases ?? []) {
      this.cmds.set(`${owner}:${a}`, { cmd, owner, official });
    }
  }

  /**
   * Remove a command and every key that routes to it.
   *
   * `callerOwner` is the tier making the removal, and it is the only thing
   * that can make this decision: after `register` refuses to hand a plugin a
   * core-owned alias (plug-lsp's bare `stop`, which core answers as an alias of
   * `/interrupt`), the bare `stop` and the caller's own `owner:stop` resolve to
   * *different* entries, while an unattributed call resolves to core's. Key
   * spelling cannot express any of that, so it is never consulted.
   *
   * A caller that does not own the resolved entry keeps that entry's keys, but
   * its own command is still swept BY IDENTITY rather than by a reconstructed
   * key list: if another plugin reclaimed a bare name this command was also
   * indexed under, deleting only `owner:name` would strand that bare key
   * pointing at an unloaded command.
   */
  unregister(name: string, callerOwner?: string): boolean {
    const entry = this.cmds.get(name);
    // An attributed caller may not pull keys out from under their rightful
    // owner. The predicate is owner equality, not `entry.owner === 'core'`: the
    // hazard `callerOwner` was introduced for is a bare key resolving to
    // someone else's entry, and that "someone else" can be another plugin just
    // as easily as a built-in.
    if (entry && callerOwner !== undefined && callerOwner !== entry.owner) {
      // The caller's own command, if it still has one indexed here.
      const own = this.cmds.get(`${callerOwner}:${name}`);
      if (!own) return false;
      for (const [key, e] of this.cmds.entries()) {
        if (e.cmd === own.cmd) this.cmds.delete(key);
      }
      return true;
    }
    if (!entry) return false;
    // Remove every key pointing at this command — bare name, `owner:name`
    // namespace, and all aliases in either form — so an official plugin's
    // teardown fully removes it regardless of which key the caller passed.
    for (const [key, e] of this.cmds.entries()) {
      if (e.cmd === entry.cmd) this.cmds.delete(key);
    }
    return true;
  }

  /**
   * Bulk-register multiple slash commands at once.
   */
  registerAll(cmds: SlashCommand[], owner = 'core'): void {
    for (const cmd of cmds) this.register(cmd, owner);
  }

  get(name: string): SlashCommand | undefined {
    return this.cmds.get(name)?.cmd;
  }

  ownerOf(name: string): string | undefined {
    return this.cmds.get(name)?.owner;
  }

  list(): SlashCommand[] {
    const seen = new Set<SlashCommand>();
    const out: SlashCommand[] = [];
    for (const { cmd } of this.cmds.values()) {
      if (!seen.has(cmd)) {
        seen.add(cmd);
        out.push(cmd);
      }
    }
    return out;
  }

  listWithOwner(): Array<{ cmd: SlashCommand; owner: string; fullName: string }> {
    const seen = new Set<SlashCommand>();
    const out: Array<{ cmd: SlashCommand; owner: string; fullName: string }> = [];
    for (const [fullName, { cmd, owner }] of this.cmds.entries()) {
      if (!seen.has(cmd)) {
        seen.add(cmd);
        out.push({ cmd, owner, fullName });
      }
    }
    return out;
  }

  /**
   * Parse a slash command line. Accepts both:
   *   `/cmd args`          → builtin command (owner=core)
   *   `/pluginName:cmd args` → plugin command
   * The command name is split at the first `:` if the prefix matches a known owner.
   */
  async dispatch(
    line: string,
    ctx: Context,
  ): Promise<{
    exit?: boolean | undefined;
    message?: string | undefined;
    runText?: string | undefined;
    metadata?: Record<string, unknown>;
  } | null> {
    if (!line.startsWith('/')) return null;
    const trimmed = line.slice(1);
    const spaceIdx = trimmed.indexOf(' ');
    const firstColonIdx = trimmed.indexOf(':');

    let name: string;
    let args: string;

    if (firstColonIdx !== -1 && (spaceIdx === -1 || firstColonIdx < spaceIdx)) {
      // `/owner:cmd` or `/owner:cmd args` — plugin namespaced
      const prefix = trimmed.slice(0, firstColonIdx);
      name = trimmed.slice(0, spaceIdx === -1 ? undefined : spaceIdx);
      args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
      // Verify the prefix is a known owner
      const entry = this.cmds.get(name);
      if (!entry || entry.owner !== prefix) {
        // Not a namespaced plugin command — treat the whole thing as a builtin command name
        name = trimmed.slice(0, spaceIdx === -1 ? undefined : spaceIdx);
        args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
      }
    } else {
      name = trimmed.slice(0, spaceIdx === -1 ? undefined : spaceIdx);
      args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);
    }

    const entry = this.cmds.get(name);
    if (!entry) {
      return { message: `Unknown command "/${name}". Type /help for a list.` };
    }
    try {
      const res = await entry.cmd.run(args, ctx);
      return res ?? {};
    } catch (err) {
      const msg = toErrorMessage(err);
      return { message: `Command "/${name}" failed: ${msg}` };
    }
  }
}
