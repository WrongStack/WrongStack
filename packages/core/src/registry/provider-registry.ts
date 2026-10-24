import type { ProviderConfig } from '@wrongstack/contracts/types/config';
import type { WireFamily } from '@wrongstack/contracts/types/models-registry';
import type { Provider } from '@wrongstack/contracts/types/provider';

/**
 * Factory for constructing a Provider instance. The `family` field
 * declares the wire protocol so callers can route without inspecting
 * the returned instance. The `type` is the registry key (e.g. a
 * provider's models.dev id or a user-chosen alias).
 */
export interface ProviderFactory {
  /**
   * Unique identifier used as the registry key. When registered via
   * a plugin, this becomes `cfg.type` in `ProviderRegistry.create(cfg)`.
   */
  type: string;
  /**
   * Declares the wire protocol family so consumers can route based on
   * capability (e.g. which tool-format converter to use) without
   * instantiating the provider.
   */
  family: WireFamily;
  create(cfg: ProviderConfig): Provider;
}

interface ProviderRegistration {
  factory: ProviderFactory;
  previous?: ProviderRegistration | undefined;
  removed?: boolean;
}

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderRegistration>();

  /**
   * Register a provider factory. If a factory with the same type already
   * exists, it is replaced. Use this for both initial registration and
   * runtime overrides (e.g. from plugins or CLI flags).
   */
  register(f: ProviderFactory): void {
    this.factories.set(f.type, { factory: f });
  }

  /**
   * Temporarily replace a factory until the returned cleanup is called.
   * Nested scopes may close in any order. Independent register/override/remove
   * operations supersede the scope and are never undone by its cleanup.
   */
  registerScoped(f: ProviderFactory): () => void {
    const type = f.type;
    const entry: ProviderRegistration = { factory: f, previous: this.factories.get(type) };
    this.factories.set(type, entry);
    return () => {
      if (entry.removed) return;
      entry.removed = true;
      if (this.factories.get(type) !== entry) return;
      let previous = entry.previous;
      while (previous?.removed) previous = previous.previous;
      if (previous) this.factories.set(type, previous);
      else this.factories.delete(type);
    };
  }

  /**
   * Bulk-register multiple provider factories at once.
   */
  registerAll(factories: ProviderFactory[]): void {
    for (const f of factories) this.register(f);
  }

  /**
   * Override an existing factory. Throws if no factory is registered
   * for the given type. Use this to safely replace a provider at runtime
   * (e.g. in tests or when a plugin provides a custom implementation).
   */
  override(type: string, f: ProviderFactory): void {
    if (!this.factories.has(type)) {
      throw new Error(`Provider type "${type}" not registered; cannot override`);
    }
    this.factories.set(type, { factory: f });
  }

  has(type: string): boolean {
    return this.factories.has(type);
  }

  /**
   * Unregister a provider factory by type. Returns true if a factory was
   * removed, false if none was registered for that type.
   */
  unregister(type: string): boolean {
    return this.factories.delete(type);
  }

  create(cfg: ProviderConfig, factoryType: string = cfg.type): Provider {
    const f = this.factories.get(factoryType);
    if (!f) {
      throw new Error(
        `Provider type "${factoryType}" not registered. Available: ${Array.from(this.factories.keys()).join(', ')}`,
      );
    }
    return f.factory.create(cfg);
  }

  list(): string[] {
    return Array.from(this.factories.keys());
  }
}
