/** Warm only the runtime used by the restored page; other surfaces open theirs on demand. */
export function warmRuntimes(
  snapshot: { projects: readonly { id: string }[] },
  savedLayout: string | null | undefined,
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): void {
  let layout: unknown;
  try {
    layout = savedLayout ? JSON.parse(savedLayout) : null;
  } catch {
    return;
  }
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return;
  if ('section' in layout && (layout.section === 'wrongstack' || layout.section === 'engine')) {
    void request('profile.open', {}).catch(() => undefined);
  } else if (
    'section' in layout &&
    layout.section === 'project' &&
    'project' in layout &&
    typeof layout.project === 'string' &&
    snapshot.projects.some((project) => project.id === layout.project)
  ) {
    void request('project.open', { projectId: layout.project }).catch(() => undefined);
  }
}
