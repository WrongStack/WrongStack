export interface ServiceHealing {
  phase: 'restarting' | 'restarted' | 'failed' | 'escalated' | 'refused';
  message: string;
  at: number;
  attempt: number;
}
const HEALING_PHASES = ['restarting', 'restarted', 'failed', 'escalated', 'refused'] as const;

export function serviceHealing(payload: Record<string, unknown>): ServiceHealing | null {
  const phase = payload['phase'],
    at = payload['at'];
  if (
    typeof phase !== 'string' ||
    !(HEALING_PHASES as readonly string[]).includes(phase) ||
    typeof at !== 'number' ||
    !Number.isFinite(at)
  )
    return null;
  return {
    phase: phase as ServiceHealing['phase'],
    at,
    message: typeof payload['message'] === 'string' ? payload['message'] : '',
    attempt: typeof payload['attempt'] === 'number' ? payload['attempt'] : 0,
  };
}
export const healingBusy = (value: ServiceHealing | undefined, now: number) =>
  value?.phase === 'restarting' && now - value.at < 120000 && now >= value.at;
