import { ExtensionRegistry } from '@wrongstack/core/extension';

type AgentExtension = Parameters<ExtensionRegistry['register']>[0];
type SystemPromptContributor = Parameters<ExtensionRegistry['registerSystemPromptContributor']>[0];

interface Mirrored {
  /** Removes this registration from one conversation's registry. */
  offs: WeakMap<ExtensionRegistry, () => void>;
  apply(target: ExtensionRegistry): () => void;
  name?: string | undefined;
}

/**
 * The extension registry the standalone host hands its plugins.
 *
 * The CLI host has one agent, so plugins register their agent extensions
 * (prompt-firewall, llm-cache, model-router, token-throttle, …) on that agent.
 * This host runs one agent per open conversation, each with its own registry:
 * registering on the boot conversation's alone would leave every other tab
 * without them. Every plugin registration is mirrored onto each attached
 * conversation — including ones opened later — and removing it (plugin
 * dispose, `unregister`, `clear`) removes it everywhere. A conversation's own
 * extensions (fallback, Chimera owner, lifecycle hooks) are never touched.
 */
export class PluginExtensionFanout extends ExtensionRegistry {
  private readonly mirrored: Mirrored[] = [];
  private readonly targets = new Set<WeakRef<ExtensionRegistry>>();
  private nextMode: 'register' | 'scoped' = 'register';

  constructor(private readonly onError: (message: string, error: unknown) => void) {
    super();
  }

  /** Mirrors every current and future plugin registration onto `target`. */
  attach(target: ExtensionRegistry): void {
    for (const ref of this.targets) {
      const live = ref.deref();
      if (!live) this.targets.delete(ref);
      else if (live === target) return;
    }
    this.targets.add(new WeakRef(target));
    for (const entry of this.mirrored) this.applyTo(target, entry);
  }

  override register(extension: AgentExtension): () => void {
    const scoped = this.nextMode === 'scoped';
    this.nextMode = 'register';
    const offBase = super.register(extension);
    return this.mirror(offBase, extension.name, (target) =>
      scoped ? target.registerOrReplaceScoped(extension) : target.register(extension),
    );
  }

  // The base implementations call `register`; the flag carries their mode.
  override registerOrReplace(extension: AgentExtension): () => void {
    this.nextMode = 'scoped';
    return super.registerOrReplace(extension);
  }

  override registerOrReplaceScoped(extension: AgentExtension): () => void {
    this.nextMode = 'scoped';
    return super.registerOrReplaceScoped(extension);
  }

  override registerSystemPromptContributor(contributor: SystemPromptContributor): () => void {
    const offBase = super.registerSystemPromptContributor(contributor);
    return this.mirror(offBase, undefined, (target) =>
      target.registerSystemPromptContributor(contributor),
    );
  }

  override unregister(name: string): boolean {
    const found = super.unregister(name);
    for (const entry of this.mirrored.filter((candidate) => candidate.name === name)) {
      this.drop(entry);
    }
    return found;
  }

  override clear(): void {
    super.clear();
    for (const entry of [...this.mirrored]) this.drop(entry);
  }

  private mirror(
    offBase: () => void,
    name: string | undefined,
    apply: (target: ExtensionRegistry) => () => void,
  ): () => void {
    const entry: Mirrored = { offs: new WeakMap(), apply, name };
    this.mirrored.push(entry);
    for (const ref of this.targets) {
      const target = ref.deref();
      if (target) this.applyTo(target, entry);
    }
    return () => {
      offBase();
      this.drop(entry);
    };
  }

  private applyTo(target: ExtensionRegistry, entry: Mirrored): void {
    try {
      entry.offs.set(target, entry.apply(target));
    } catch (error) {
      // One conversation refusing a name it already owns must not cost the others.
      this.onError(`plugin extension "${entry.name ?? 'prompt contributor'}" not attached`, error);
    }
  }

  private drop(entry: Mirrored): void {
    const index = this.mirrored.indexOf(entry);
    if (index < 0) return;
    this.mirrored.splice(index, 1);
    for (const ref of this.targets) {
      const target = ref.deref();
      if (!target) continue;
      entry.offs.get(target)?.();
      entry.offs.delete(target);
    }
  }
}
