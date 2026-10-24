import type {
  ProviderAuthBeginDeps,
  ProviderAuthSession,
  ProviderAuthStrategy,
  ProviderAuthStrategyMetadata,
} from '@wrongstack/contracts/types/provider-auth';

const AUTH_ID = /^[a-z0-9][a-z0-9._-]*$/;

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function requireId(value: string, field: string): string {
  const normalized = normalize(value);
  if (!AUTH_ID.test(normalized)) {
    throw new Error(`${field} "${value}" is invalid`);
  }
  return normalized;
}

function metadata(strategy: ProviderAuthStrategy): ProviderAuthStrategyMetadata {
  return {
    id: strategy.id,
    providerId: strategy.providerId,
    label: strategy.label,
    ...(strategy.description ? { description: strategy.description } : {}),
    // Whitelisted projection: every UI-visible metadata field must be copied
    // explicitly, so a new ProviderAuthStrategyMetadata field is invisible to
    // hosts until it is added here.
    ...(strategy.notes?.length ? { notes: [...strategy.notes] } : {}),
    aliases: [...(strategy.aliases ?? [])],
    interactionTypes: [...strategy.interactionTypes],
  };
}

/** Registry for UI-neutral interactive provider authentication strategies. */
export class ProviderAuthRegistry {
  private readonly strategies = new Map<string, ProviderAuthStrategy>();
  private readonly aliases = new Map<string, string>();
  private readonly scopedPrevious = new WeakMap<ProviderAuthStrategy, ProviderAuthStrategy>();
  private readonly removedRegistrations = new WeakSet<ProviderAuthStrategy>();

  /** Own one exact strategy and its aliases, including temporary first-party overrides. */
  registerScoped(strategy: ProviderAuthStrategy): () => void {
    const id = normalize(strategy.id);
    const prior = this.strategies.get(id);
    this.register(strategy);
    const entry = this.strategies.get(id)!;
    if (prior) this.scopedPrevious.set(entry, prior);
    return () => {
      if (this.removedRegistrations.has(entry)) return;
      this.removedRegistrations.add(entry);
      if (this.strategies.get(id) !== entry) return;
      let previous = prior;
      while (previous && this.removedRegistrations.has(previous)) {
        previous = this.scopedPrevious.get(previous);
      }
      this.unregister(id);
      if (!previous) return;
      const aliases = [previous.id, ...(previous.aliases ?? [])];
      for (const alias of aliases) {
        if (this.aliases.has(alias)) {
          throw new Error(
            `Cannot restore provider auth strategy "${id}": alias "${alias}" was replaced`,
          );
        }
      }
      this.strategies.set(id, previous);
      for (const alias of aliases) this.aliases.set(alias, id);
    };
  }

  register(strategy: ProviderAuthStrategy): void {
    const id = requireId(strategy.id, 'Provider auth strategy id');
    requireId(strategy.providerId, 'Provider auth provider id');
    if (!strategy.label.trim()) throw new Error(`Provider auth strategy "${id}" needs a label`);
    if (strategy.interactionTypes.length === 0) {
      throw new Error(`Provider auth strategy "${id}" needs an interaction type`);
    }
    for (const interactionType of strategy.interactionTypes) {
      if (interactionType !== 'browser' && interactionType !== 'device_code') {
        throw new Error(
          `Provider auth strategy "${id}" has invalid interaction type "${String(interactionType)}"`,
        );
      }
    }

    const nextAliases = new Set<string>([id]);
    for (const alias of strategy.aliases ?? []) {
      nextAliases.add(requireId(alias, 'Provider auth alias'));
    }
    for (const alias of nextAliases) {
      const owner = this.aliases.get(alias);
      if (owner && owner !== id) {
        throw new Error(`Provider auth alias "${alias}" is already registered by "${owner}"`);
      }
    }

    // Re-registration replaces one strategy atomically and releases aliases it no longer owns.
    for (const [alias, owner] of this.aliases) {
      if (owner === id) this.aliases.delete(alias);
    }
    const normalized: ProviderAuthStrategy = {
      ...strategy,
      id,
      providerId: normalize(strategy.providerId),
      label: strategy.label.trim(),
      aliases: [...nextAliases].filter((alias) => alias !== id),
      interactionTypes: [...new Set(strategy.interactionTypes)],
    };
    this.strategies.set(id, normalized);
    for (const alias of nextAliases) this.aliases.set(alias, id);
  }

  override(id: string, strategy: ProviderAuthStrategy): void {
    const normalizedId = normalize(id);
    if (!this.strategies.has(normalizedId)) {
      throw new Error(`Provider auth strategy "${id}" not registered; cannot override`);
    }
    if (normalize(strategy.id) !== normalizedId) {
      throw new Error(`Provider auth override id "${strategy.id}" must match "${normalizedId}"`);
    }
    this.register(strategy);
  }

  unregister(id: string): boolean {
    const resolved = this.resolveId(id);
    if (!resolved || !this.strategies.delete(resolved)) return false;
    for (const [alias, owner] of this.aliases) {
      if (owner === resolved) this.aliases.delete(alias);
    }
    return true;
  }

  has(idOrAlias: string): boolean {
    return this.resolveId(idOrAlias) !== undefined;
  }

  get(idOrAlias: string): ProviderAuthStrategy | undefined {
    const id = this.resolveId(idOrAlias);
    return id ? this.strategies.get(id) : undefined;
  }

  resolveId(idOrAlias: string): string | undefined {
    return this.aliases.get(normalize(idOrAlias));
  }

  list(): ProviderAuthStrategyMetadata[] {
    return [...this.strategies.values()].map(metadata);
  }

  begin(
    idOrAlias: string,
    deps?: ProviderAuthBeginDeps,
    signal?: AbortSignal,
  ): Promise<ProviderAuthSession> {
    const strategy = this.get(idOrAlias);
    if (!strategy) {
      throw new Error(
        `Provider auth strategy "${idOrAlias}" not registered. Available: ${[
          ...this.strategies.keys(),
        ].join(', ')}`,
      );
    }
    return strategy.begin(deps, signal);
  }
}
