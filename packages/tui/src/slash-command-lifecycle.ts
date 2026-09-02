import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { SlashCommand } from '@wrongstack/core/types';

interface SlashCommandRegistrationOptions {
  owner?: string | undefined;
  official?: boolean | undefined;
}

/**
 * Register a slash command and return an ownership-safe teardown callback.
 *
 * The shared registry uses last-write-wins for official commands and removes
 * every alias/namespace for the selected command on unregister. React effects
 * therefore cannot safely pair `register()` with a bare `unregister(name)`:
 * registration may have been a no-op, or it may have replaced a canonical
 * host command that must become visible again after the TUI unmounts.
 */
export function registerSlashCommandLifecycle(
  registry: SlashCommandRegistry,
  command: SlashCommand,
  options: SlashCommandRegistrationOptions = {},
): () => void {
  const owner = options.owner ?? 'core';
  const displaced = new Map<SlashCommand, { command: SlashCommand; owner: string }>();
  for (const key of [command.name, ...(command.aliases ?? [])]) {
    const previous = registry.get(key);
    const previousOwner = registry.ownerOf(key);
    if (previous && previousOwner && previous !== command && !displaced.has(previous)) {
      displaced.set(previous, { command: previous, owner: previousOwner });
    }
  }

  registry.register(command, owner, { official: options.official });

  // Core duplicate registration is intentionally a no-op in the registry.
  // Cleanup therefore checks live ownership instead of assuming register()
  // installed this command.
  const namespacedName = owner === 'core' ? null : `${owner}:${command.name}`;
  let cleaned = false;

  return () => {
    if (cleaned) return;
    cleaned = true;

    const ownsBareName = registry.get(command.name) === command;
    const ownsNamespace = namespacedName !== null && registry.get(namespacedName) === command;

    // A newer registration may have replaced the bare name while leaving this
    // command's namespace behind. Remove only the key that still identifies
    // this exact command; never unregister a newer command by its bare name.
    if (ownsBareName) registry.unregister(command.name);
    else if (ownsNamespace && namespacedName) registry.unregister(namespacedName);
    else return;

    // Restore a displaced registration only after the bare key is free. A
    // newer owner wins; namespace-only teardown must never overwrite it.
    for (const registration of displaced.values()) {
      const keys = [registration.command.name, ...(registration.command.aliases ?? [])];
      // An official plugin's namespace and unaffected aliases can survive the
      // TUI override. Those keys are safe: they still point at the exact
      // displaced command. Skip restoration only when a genuinely different
      // command claimed one of its keys while this lifecycle was active.
      if (
        keys.some((key) => {
          const current = registry.get(key);
          return current !== undefined && current !== registration.command;
        })
      ) {
        continue;
      }
      registry.register(
        registration.command,
        registration.owner,
        registration.owner === 'core' ? undefined : { official: true },
      );
    }
  };
}
