import type { Config } from '@wrongstack/contracts/types';

export type CliFlags = Record<string, string | boolean>;

/**
 * Apply the explicit SimpleUI full-auto launch profile for this process only.
 *
 * The profile deliberately changes ordinary runtime preferences (YOLO,
 * Director, autonomy, and the disabled-tool list), but it does not weaken
 * absolute trust denies, `permission: 'deny'` tools, enforcement hooks, or
 * project-root containment. Those guarantees are enforced below config/flag
 * selection and continue to win over YOLO.
 */
export function isSimpleUiFullAuto(flags: CliFlags): boolean {
  return flags['simpleui'] === true && flags['full-auto'] === true;
}

export function applySimpleUiFullAutoProfile(config: Config, flags: CliFlags): Config {
  if (!isSimpleUiFullAuto(flags)) return config;

  flags['yolo'] = true;
  flags['director'] = true;
  flags['no-director'] = false;
  flags['autonomy'] = 'auto';
  flags['no-autonomy'] = false;

  return Object.freeze({
    ...config,
    yolo: true,
    tools: Object.freeze({
      ...config.tools,
      disabledTools: [],
    }),
  });
}

/**
 * Mark the independent SimpleUI surface as coordination-light. Mailbox
 * heartbeat/telemetry keeps running, but routine presence and chatter stays
 * outside the model conversation. Actionable control/results are still
 * delivered by the core mailbox loop.
 */
export function configureSimpleUiRuntimeContext(
  meta: Record<string, unknown>,
  flags: CliFlags,
): void {
  if (flags['simpleui'] !== true) return;
  meta['source'] = 'webui';
  meta['surface'] = 'simpleui';
  meta['coordinationContextMode'] = 'background';
}
