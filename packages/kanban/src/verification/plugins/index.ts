/**
 * Register all built-in deterministic verifier plugins.
 * Escalation plugins (agent, council) are registered separately
 * to keep the default path LLM-free.
 */
import { VerifierRegistry } from '../verifier-registry.js';
import { AgentVerifierPlugin } from './agent.js';
import { CommandPlugin } from './command.js';
import { type CouncilVerifierOptions, CouncilVerifierPlugin } from './council.js';
import { FileExistsPlugin } from './file-exists.js';
import { FileMatchesPlugin } from './file-matches.js';
import { GitDiffPlugin } from './git-diff.js';
import { MetricPlugin } from './metric.js';
import { TestPlugin } from './test.js';

/**
 * Create a VerifierRegistry pre-loaded with all deterministic plugins.
 * This is the default registry used when no escalation is configured.
 */
export function createDefaultRegistry(): VerifierRegistry {
  return new VerifierRegistry()
    .register(new FileExistsPlugin())
    .register(new FileMatchesPlugin())
    .register(new CommandPlugin())
    .register(new TestPlugin())
    .register(new GitDiffPlugin())
    .register(new MetricPlugin());
}

/**
 * The deterministic registry plus the escalation verifiers.
 *
 * Separate from {@link createDefaultRegistry} on purpose: registering these
 * is what admits an LLM into the verification path, so a host has to ask for
 * it. Without `council.runner` the council check still reports as
 * un-dispatched rather than inventing a verdict, so wiring the registry and
 * wiring the dispatch are two independent decisions.
 */
export function createRegistryWithEscalation(
  opts: { council?: CouncilVerifierOptions | undefined } = {},
): VerifierRegistry {
  return createDefaultRegistry()
    .register(new AgentVerifierPlugin())
    .register(new CouncilVerifierPlugin(opts.council ?? {}));
}
