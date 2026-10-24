import type { TextBlock } from './blocks.js';
import type { BuildContext } from './system-prompt.js';

/**
 * A contributor that injects additional TextBlocks into the system prompt.
 *
 * Contributors are called on every `build()` in registration order.
 * Their output is inserted after the core blocks (identity, tool usage,
 * environment) but before the mode and plan blocks. This lets plugins
 * inject ephemeral context — current state, recent events, plugin-specific
 * instructions — without replacing the entire system prompt builder.
 *
 * @example
 * ```ts
 * api.extensions.registerSystemPromptContributor(async (ctx) => {
 *   return [{ type: 'text', text: '## My Plugin Context\n...' }];
 * });
 * ```
 */
export type SystemPromptContributor = (ctx: BuildContext) => Promise<TextBlock[]>;
