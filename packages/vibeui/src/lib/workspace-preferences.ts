export type WorkspaceView = 'cozy' | 'focus' | 'studio';
export interface WorkspacePreferences {
  view: WorkspaceView;
  ideas: boolean;
  shortcuts: boolean;
  guidance: boolean;
  collections: 'cards' | 'list';
  mascot: 'roam' | 'quiet' | 'off';
  hiddenIntros: string[];
}
export const WORKSPACE_PREFERENCES_KEY = 'wrongstack.vibeui.workspace-view.v1';
export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  view: 'cozy',
  ideas: false,
  shortcuts: true,
  guidance: true,
  collections: 'cards',
  mascot: 'roam',
  hiddenIntros: [],
};
export function readWorkspacePreferences(raw: string | null): WorkspacePreferences {
  try {
    const value: unknown = JSON.parse(raw || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return {
        ...DEFAULT_WORKSPACE_PREFERENCES,
        hiddenIntros: [...DEFAULT_WORKSPACE_PREFERENCES.hiddenIntros],
      };
    const item = value as Record<string, unknown>;
    return {
      view: item.view === 'focus' || item.view === 'studio' ? item.view : 'cozy',
      ideas: typeof item.ideas === 'boolean' ? item.ideas : false,
      shortcuts: typeof item.shortcuts === 'boolean' ? item.shortcuts : true,
      guidance: typeof item.guidance === 'boolean' ? item.guidance : true,
      collections: item.collections === 'list' ? 'list' : 'cards',
      mascot: item.mascot === 'quiet' || item.mascot === 'off' ? item.mascot : 'roam',
      hiddenIntros: Array.isArray(item.hiddenIntros)
        ? [
            ...new Set(
              item.hiddenIntros.filter(
                (id): id is string =>
                  typeof id === 'string' && id.trim().length > 0 && id.length < 80,
              ),
            ),
          ].slice(0, 30)
        : [],
    };
  } catch {
    return {
      ...DEFAULT_WORKSPACE_PREFERENCES,
      hiddenIntros: [...DEFAULT_WORKSPACE_PREFERENCES.hiddenIntros],
    };
  }
}
