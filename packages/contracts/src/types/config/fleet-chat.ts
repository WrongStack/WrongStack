/**
 * Verbosity of fleet/subagent activity streamed into the main TUI chat.
 * See {@link AutonomyConfig.fleetChatVerbosity}.
 *
 * This is a dependency-free leaf module: it intentionally does NOT import
 * `AutonomyConfig` so that both `autonomy.ts` and `runtime.ts` can depend on
 * it without creating a type-level import cycle.
 */
export type FleetChatVerbosity = 'off' | 'full';

export const FLEET_CHAT_VERBOSITY_VALUES: readonly FleetChatVerbosity[] = ['off', 'full'];

/**
 * Resolve the effective fleet-chat verbosity from autonomy config.
 * An explicit `fleetChatVerbosity` wins; absence means 'off'.
 *
 * Accepts a minimal structural shape rather than `Pick<AutonomyConfig, ...>`
 * to keep this module free of any `AutonomyConfig` import (cycle-safe).
 */
export function resolveFleetChatVerbosity(autonomy?: {
  fleetChatVerbosity?: FleetChatVerbosity | undefined;
}): FleetChatVerbosity {
  const explicit = autonomy?.fleetChatVerbosity;
  if (explicit && (FLEET_CHAT_VERBOSITY_VALUES as readonly string[]).includes(explicit)) {
    return explicit;
  }
  return 'off';
}
