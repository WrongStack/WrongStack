import { createRunTuiClientRegistration } from './run-tui-client-registration.js';
import type { RunTuiOptions } from './run-tui-options.js';

/**
 * Session/client bootstrap — moved verbatim from runTui() (decomposition
 * Phase 1 R2, docs/decomposition-plan.md): registers this TUI client with
 * the shared registry, heartbeats, and telemetry bridges, returning the
 * handle whose unregister() every exit path calls.
 *
 * `isCleaned` backs the registry's heartbeat/sync guards; it must be wired
 * to runTui's `cleaned` flag so registration activity stops on cleanup.
 */
export function setupTuiSession(
  opts: RunTuiOptions,
  isCleaned: () => boolean,
): ReturnType<typeof createRunTuiClientRegistration> {
  return createRunTuiClientRegistration({
    projectRoot: opts.projectRoot,
    events: opts.events,
    appConfig: opts.appConfig,
    hqTelemetryOwnedExternally: opts.hqTelemetryOwnedExternally,
    getSessionId: opts.getSessionId,
    getAgentId: () =>
      (opts.agent.ctx.meta['globalAgentId'] as string | undefined) ?? opts.agent.ctx.agentId,
    isCleaned,
  });
}
