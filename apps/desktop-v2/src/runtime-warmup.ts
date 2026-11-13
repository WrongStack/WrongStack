import type { Snapshot } from './model';

/** How long after the first snapshot the settings (profile) engine starts booting. */
const PROFILE_WARM_DELAY_MS = 3000;

/**
 * Starts the engines the user is about to need while the window is coming up. A project's
 * services engine and the profile engine (settings, model pickers) used to boot only when their
 * page was opened, so the first visit after a launch waited 6-10 s behind "Opening…". Opening
 * is idempotent on the host: a running or starting runtime is left alone. The project the
 * saved layout returns to starts at once; the profile engine a little later, so it does not
 * compete with the first paint.
 */
export function warmRuntimes(
  snapshot: Pick<Snapshot, 'projects'>,
  savedLayout: string | null | undefined,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  later: (run: () => void, ms: number) => void = (run, ms) => void setTimeout(run, ms),
): void {
  let project: unknown;
  try {
    project = savedLayout ? (JSON.parse(savedLayout) as Record<string, unknown>)['project'] : null;
  } catch {
    project = null;
  }
  if (typeof project === 'string' && snapshot.projects.some((p) => p.id === project))
    void request('project.open', { projectId: project }).catch(() => undefined);
  later(() => void request('profile.open', {}).catch(() => undefined), PROFILE_WARM_DELAY_MS);
}
