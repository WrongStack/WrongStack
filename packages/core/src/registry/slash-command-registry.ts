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
import { toErrorMessage } from '../utils/error.js';

export class SlashCommandRegistry {
  private readonly cmds = new Map<
    string,
    { cmd: SlashCommand; owner: string; official: boolean }
  >();

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
      this.cmds.set(cmd.name, { cmd, owner, official });
      for (const a of cmd.aliases ?? []) {
        this.cmds.set(a, { cmd, owner, official });
      }
    }

    if (isPlugin) {
      // Every plugin — official or external — is reachable under its namespace.
      this.cmds.set(`${owner}:${cmd.name}`, { cmd, owner, official });
      for (const a of cmd.aliases ?? []) {
        this.cmds.set(`${owner}:${a}`, { cmd, owner, official });
      }
    }
  }

  unregister(name: string): boolean {
    const entry = this.cmds.get(name);
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
