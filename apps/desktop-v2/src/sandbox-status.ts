import { record } from './engine-values';

/** The engine's sandbox posture, as `GET /api/sandbox/status` reports it (no paths). */
export interface SandboxStatus {
  mode: string;
  tier: string;
  backend: string;
}

/** Reads the posture from the reply, or null when the reply does not carry one. */
export function readSandboxStatus(body: unknown): SandboxStatus | null {
  const sandbox = record(record(body)['sandbox']);
  if (typeof sandbox['mode'] !== 'string' || !sandbox['mode']) return null;
  return {
    mode: sandbox['mode'],
    tier: typeof sandbox['tier'] === 'string' ? sandbox['tier'] : '',
    backend: typeof sandbox['backend'] === 'string' ? sandbox['backend'] : '',
  };
}

/**
 * The chip's wording key, as the WebUI's line reads it: off unless the mode is `enforced`, then
 * the tier (read-only, workspace write, or full access for any other tier).
 */
export function sandboxChipKey(
  status: SandboxStatus,
): 'off' | 'readOnly' | 'workspaceWrite' | 'full' {
  if (status.mode !== 'enforced') return 'off';
  if (status.tier === 'read-only') return 'readOnly';
  if (status.tier === 'workspace-write') return 'workspaceWrite';
  return 'full';
}
