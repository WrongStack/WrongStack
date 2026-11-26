export const paneIds = ['explorer', 'fileTree', 'inspector'] as const;
export type PaneId = (typeof paneIds)[number];
export type PaneLayout = Record<PaneId, { width: number; open: boolean }>;

export const paneBounds = {
  explorer: { min: 160, max: 400 },
  fileTree: { min: 160, max: 420 },
  inspector: { min: 240, max: 460 },
} as const;

export const paneLabels = {
  explorer: 'Projects and sessions',
  fileTree: 'File tree',
  inspector: 'Session inspector',
} as const;

export const defaultPaneLayout: PaneLayout = {
  explorer: { width: 220, open: true },
  fileTree: { width: 240, open: true },
  inspector: { width: 296, open: true },
};

export const panePresets = {
  Code: {
    explorer: { width: 180, open: true },
    fileTree: { width: 260, open: true },
    inspector: { width: 296, open: false },
  },
  Review: {
    explorer: { width: 220, open: false },
    fileTree: { width: 220, open: true },
    inspector: { width: 360, open: true },
  },
  Focus: {
    explorer: { width: 220, open: false },
    fileTree: { width: 240, open: false },
    inspector: { width: 296, open: false },
  },
} satisfies Record<string, PaneLayout>;

export function clampPaneWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

export function decodePaneLayout(raw: string | null): PaneLayout {
  let saved: Record<string, unknown> | undefined;
  try {
    saved = record(raw === null ? null : JSON.parse(raw));
  } catch {
    return defaultPaneLayout;
  }
  if (saved?.['version'] !== 1) return defaultPaneLayout;
  const panes = record(saved['panes']);
  const layout = { ...defaultPaneLayout };
  for (const id of paneIds) {
    const pane = record(panes?.[id]);
    const width = pane?.['width'];
    const open = pane?.['open'];
    const { min, max } = paneBounds[id];
    layout[id] = {
      width:
        typeof width === 'number' && Number.isFinite(width)
          ? clampPaneWidth(width, min, max)
          : layout[id].width,
      open: typeof open === 'boolean' ? open : layout[id].open,
    };
  }
  return layout;
}

export const paneStorageKey = (scope: string) => `wrongstack.desktop.panes:${scope}`;
