import type { ConcreteTokenSavingTier, Tool } from '@wrongstack/core/types';
import type { ToolRegistry } from '@wrongstack/core/registry';

/**
 * Select built-in tools for a concrete token-saving tier while preserving the
 * order and instances supplied by the caller.
 */
export declare function selectBuiltinToolsForTier(
  tier: ConcreteTokenSavingTier,
  allTools: readonly Tool[],
): Tool[];

export interface RegisterBuiltinToolTierOptions {
  registry: Pick<ToolRegistry, 'registerAllOrThrow'>;
  tier: ConcreteTokenSavingTier;
  tools?: readonly Tool[] | undefined;
  owner?: string | undefined;
}

/** Register the canonical built-in subset for a host and return that subset. */
export declare function registerBuiltinToolTier(options: RegisterBuiltinToolTierOptions): Tool[];
