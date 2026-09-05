import type { Agent, Context } from '@wrongstack/core/agent';
import type { ExtensionRegistry } from '@wrongstack/core/extension';
import type { EventBus } from '@wrongstack/core/kernel';
import type {
  ProviderRegistry,
  SlashCommandRegistry,
  ToolRegistry,
} from '@wrongstack/core/registry';
import type { PluginAPI, SessionWriter } from '@wrongstack/core/types';
import type { WrongStackPack } from './pack.js';

export interface RuntimeHost {
  agent: Agent;
  context: Context;
  events: EventBus;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  slashCommands: SlashCommandRegistry;
  session: SessionWriter;
  extensions?: ExtensionRegistry | undefined;
  shutdown(): Promise<void>;
}

export interface RuntimeHostParts {
  agent: Agent;
  context: Context;
  events: EventBus;
  tools: ToolRegistry;
  providers: ProviderRegistry;
  slashCommands: SlashCommandRegistry;
  session: SessionWriter;
  extensions?: ExtensionRegistry | undefined;
  shutdown?: (() => void | Promise<void>) | undefined;
}

export function createRuntimeHostFromParts(parts: RuntimeHostParts): RuntimeHost {
  return {
    agent: parts.agent,
    context: parts.context,
    events: parts.events,
    tools: parts.tools,
    providers: parts.providers,
    slashCommands: parts.slashCommands,
    session: parts.session,
    extensions: parts.extensions,
    async shutdown() {
      await parts.shutdown?.();
    },
  };
}

export interface ApplyPackOptions {
  owner?: string | undefined;
  api?: PluginAPI | undefined;
}

export interface AppliedPack {
  pack: WrongStackPack;
  owner: string;
  teardown(): Promise<void>;
}

export async function applyWrongStackPack(
  host: Pick<RuntimeHost, 'tools' | 'providers' | 'slashCommands'> & {
    extensions?: ExtensionRegistry | undefined;
  },
  pack: WrongStackPack,
  opts: ApplyPackOptions = {},
): Promise<AppliedPack> {
  const owner = opts.owner ?? pack.name;
  const unregisterExtensions: Array<() => void> = [];

  // Track registered tool names, command names, and provider types so teardown
  // can reverse everything in registration order.
  const registeredToolNames: string[] = [];
  const registeredCommandNames: string[] = [];
  const registeredProviderTypes: string[] = [];

  // Roll back in reverse order: extensions first, then commands, then tools,
  // then providers. Extensions are unregistered before tools/commands because
  // extensions may depend on those capabilities; tearing them down first
  // avoids dangling refs.
  const rollback = (): void => {
    for (let i = unregisterExtensions.length - 1; i >= 0; i--) {
      unregisterExtensions[i]!();
    }
    for (let i = registeredCommandNames.length - 1; i >= 0; i--) {
      host.slashCommands.unregister(registeredCommandNames[i]!);
    }
    for (let i = registeredToolNames.length - 1; i >= 0; i--) {
      host.tools.unregister(registeredToolNames[i]!);
    }
    for (let i = registeredProviderTypes.length - 1; i >= 0; i--) {
      host.providers.unregister(registeredProviderTypes[i]!);
    }
  };

  // Registration and setup() are one transaction: any failure — a tool-name
  // conflict, a duplicate extension, or a throwing setup() — unwinds
  // everything this call registered. Each item is registered individually and
  // recorded immediately after it succeeds, because the bulk registry helpers
  // are not atomic: `registerAllOrThrow` throws on the first conflict and
  // leaves the tools before it registered. Recording names only after a bulk
  // call returned would lose exactly those, leaving them mounted forever and
  // making a retry of the same pack fail on its very first tool.
  try {
    if (pack.tools) {
      for (const t of pack.tools) {
        host.tools.register(t, owner);
        registeredToolNames.push(t.name);
      }
    }
    if (pack.providers) {
      for (const p of pack.providers) {
        host.providers.register(p);
        registeredProviderTypes.push(p.type);
      }
    }
    if (pack.slashCommands) {
      for (const c of pack.slashCommands) {
        host.slashCommands.register(c, owner);
        // SlashCommandRegistry stores plugin-owned commands under
        // `${owner}:${name}`; track the real lookup key so teardown can
        // unregister them.
        registeredCommandNames.push(owner === 'core' ? c.name : `${owner}:${c.name}`);
      }
    }
    if (pack.extensions && host.extensions) {
      for (const ext of pack.extensions) {
        unregisterExtensions.push(host.extensions.register(ext));
      }
    }

    if (pack.setup) {
      if (!opts.api) {
        throw new Error(`Pack "${pack.name}" defines setup() but no PluginAPI was provided`);
      }
      await pack.setup(opts.api);
    }
  } catch (mountErr) {
    rollback();
    throw mountErr;
  }

  return {
    pack,
    owner,
    async teardown() {
      // Unregister extensions, commands, tools, and providers so the same pack
      // can be re-loaded cleanly without name/type conflicts.
      rollback();
      if (pack.teardown) {
        if (!opts.api) {
          throw new Error(`Pack "${pack.name}" defines teardown() but no PluginAPI was provided`);
        }
        await pack.teardown(opts.api);
      }
    },
  };
}

export async function applyWrongStackPacks(
  host: Pick<RuntimeHost, 'tools' | 'providers' | 'slashCommands'> & {
    extensions?: ExtensionRegistry | undefined;
  },
  packs: readonly WrongStackPack[],
  opts: ApplyPackOptions = {},
): Promise<AppliedPack[]> {
  const applied: AppliedPack[] = [];
  try {
    for (const pack of packs) {
      applied.push(await applyWrongStackPack(host, pack, opts));
    }
    return applied;
  } catch (err) {
    // Roll back already-mounted packs. Surface teardown failures via
    // process.emitWarning so they don't mask the original error but
    // remain visible — a silent teardown failure can leave state
    // half-initialized in ways that make the next run fail mysteriously.
    for (let i = applied.length - 1; i >= 0; i--) {
      const mounted = applied[i]!;
      await mounted.teardown().catch((teardownErr) => {
        const detail = teardownErr instanceof Error ? teardownErr.message : String(teardownErr);
        process.emitWarning(
          `Pack teardown during error rollback failed: ${detail}`,
          'PackRollbackWarning',
        );
      });
    }
    throw err;
  }
}
