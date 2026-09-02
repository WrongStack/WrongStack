/**
 * Desktop renderer SVG icons — extracted from renderer.ts for maintainability.
 * Each icon is a Lucide-style SVG path string (24×24 viewBox).
 */

const ICON_NAMES = [
  'agents',
  'branch',
  'chart',
  'check',
  'checklist',
  'chevron',
  'chip',
  'clock',
  'collab',
  'command',
  'compress',
  'cursor',
  'debug',
  'document',
  'download',
  'external',
  'files',
  'folder',
  'folder-plus',
  'gallery',
  'git',
  'history',
  'kanban',
  'keyboard',
  'list',
  'mail',
  'map',
  'message',
  'monitor',
  'phase',
  'plan',
  'plus',
  'project',
  'pulse',
  'refresh',
  'search',
  'settings',
  'shield',
  'skill',
  'spark',
  'target',
  'tasks',
  'terminal',
  'wand',
  'x',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const ICON_PATHS: Record<IconName, string> = {
  agents:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path><circle cx="9.5" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.9"></path><path d="M16 3.1a4 4 0 0 1 0 7.8"></path>',
  branch:
    '<circle cx="6" cy="6" r="3"></circle><circle cx="18" cy="6" r="3"></circle><circle cx="18" cy="18" r="3"></circle><path d="M9 6h6"></path><path d="M18 9v6"></path><path d="M6 9v3a6 6 0 0 0 6 6h3"></path>',
  chart:
    '<path d="M3 3v18h18"></path><rect x="7" y="12" width="3" height="5"></rect><rect x="12" y="8" width="3" height="9"></rect><rect x="17" y="5" width="3" height="12"></rect>',
  check: '<path d="M20 6L9 17l-5-5"></path>',
  checklist:
    '<path d="M9 6h11"></path><path d="M9 12h11"></path><path d="M9 18h11"></path><path d="M4 6l1 1 2-2"></path><path d="M4 12l1 1 2-2"></path><path d="M4 18l1 1 2-2"></path>',
  chevron: '<path d="M9 18l6-6-6-6"></path>',
  chip: '<rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M4 9h3"></path><path d="M4 15h3"></path><path d="M17 9h3"></path><path d="M17 15h3"></path><path d="M9 4v3"></path><path d="M15 4v3"></path><path d="M9 17v3"></path><path d="M15 17v3"></path>',
  clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  command:
    '<path d="M7 7h.01"></path><path d="M12 7h.01"></path><path d="M17 7h.01"></path><path d="M7 12h.01"></path><path d="M12 12h.01"></path><path d="M17 12h.01"></path><path d="M7 17h.01"></path><path d="M12 17h.01"></path><path d="M17 17h.01"></path>',
  collab:
    '<circle cx="8" cy="8" r="3"></circle><circle cx="16" cy="8" r="3"></circle><path d="M3 20a5 5 0 0 1 10 0"></path><path d="M11 20a5 5 0 0 1 10 0"></path>',
  compress:
    '<path d="M8 3v6H2"></path><path d="M16 3v6h6"></path><path d="M8 21v-6H2"></path><path d="M16 21v-6h6"></path>',
  cursor: '<path d="M4 4l9 17 2-7 7-2L4 4z"></path>',
  debug:
    '<path d="M8 2h8"></path><path d="M9 2v4"></path><path d="M15 2v4"></path><path d="M5 10h14"></path><path d="M7 10v4a5 5 0 0 0 10 0v-4"></path><path d="M3 14h4"></path><path d="M17 14h4"></path><path d="M4 20l3-3"></path><path d="M20 20l-3-3"></path>',
  document:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M8 13h8"></path><path d="M8 17h6"></path>',
  download: '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path>',
  external:
    '<path d="M15 3h6v6"></path><path d="M10 14L21 3"></path><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path>',
  files:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>',
  'folder-plus':
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><path d="M12 11v5"></path><path d="M9.5 13.5h5"></path>',
  git: '<path d="M7 7h10"></path><path d="M7 12h10"></path><path d="M7 17h10"></path><path d="M4 7h.01"></path><path d="M4 12h.01"></path><path d="M4 17h.01"></path>',
  gallery:
    '<rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path>',
  history:
    '<path d="M3 12a9 9 0 1 0 3-6.7"></path><path d="M3 4v6h6"></path><path d="M12 7v5l3 2"></path>',
  kanban:
    '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path><path d="M15 4v16"></path><path d="M6 8h.01"></path><path d="M12 12h.01"></path><path d="M18 9h.01"></path>',
  keyboard:
    '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M7 9h.01"></path><path d="M11 9h.01"></path><path d="M15 9h.01"></path><path d="M19 9h.01"></path><path d="M7 13h.01"></path><path d="M11 13h.01"></path><path d="M15 13h.01"></path><path d="M7 17h10"></path>',
  list: '<path d="M8 6h13"></path><path d="M8 12h13"></path><path d="M8 18h13"></path><path d="M3 6h.01"></path><path d="M3 12h.01"></path><path d="M3 18h.01"></path>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path>',
  map: '<path d="M9 18l-6 3V6l6-3 6 3 6-3v15l-6 3-6-3z"></path><path d="M9 3v15"></path><path d="M15 6v15"></path>',
  message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>',
  monitor:
    '<rect x="3" y="4" width="18" height="14" rx="2"></rect><path d="M8 21h8"></path><path d="M12 18v3"></path><path d="M7 13l3-3 2 2 4-5 1 3"></path>',
  phase:
    '<path d="M4 7h6"></path><path d="M14 7h6"></path><path d="M4 17h6"></path><path d="M14 17h6"></path><circle cx="12" cy="7" r="2"></circle><circle cx="12" cy="17" r="2"></circle><path d="M12 9v6"></path>',
  plan: '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M8 8h8"></path><path d="M8 12h8"></path><path d="M8 16h5"></path>',
  plus: '<path d="M12 5v14"></path><path d="M5 12h14"></path>',
  project:
    '<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M8 4v16"></path><path d="M8 9h13"></path>',
  pulse: '<path d="M3 12h4l2-6 4 12 2-6h6"></path>',
  refresh:
    '<path d="M21 12a9 9 0 0 1-15.4 6.4"></path><path d="M3 12A9 9 0 0 1 18.4 5.6"></path><path d="M18 2v5h-5"></path><path d="M6 22v-5h5"></path>',
  search: '<circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path>',
  settings:
    '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"></path><path d="M4 12a8 8 0 0 1 .2-1.8l-2-1.5 2-3.4 2.4 1a8 8 0 0 1 3-1.7L10 2h4l.4 2.6a8 8 0 0 1 3 1.7l2.4-1 2 3.4-2 1.5A8 8 0 0 1 20 12a8 8 0 0 1-.2 1.8l2 1.5-2 3.4-2.4-1a8 8 0 0 1-3 1.7L14 22h-4l-.4-2.6a8 8 0 0 1-3-1.7l-2.4 1-2-3.4 2-1.5A8 8 0 0 1 4 12z"></path>',
  shield:
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="M9 12l2 2 4-5"></path>',
  skill: '<path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5L12 2z"></path>',
  spark:
    '<path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3z"></path><path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z"></path>',
  target:
    '<circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5"></circle><circle cx="12" cy="12" r="1"></circle>',
  tasks:
    '<path d="M4 6h2"></path><path d="M4 12h2"></path><path d="M4 18h2"></path><path d="M10 6h10"></path><path d="M10 12h10"></path><path d="M10 18h10"></path>',
  terminal: '<path d="M4 17l6-5-6-5"></path><path d="M12 19h8"></path>',
  wand: '<path d="M15 4l5 5"></path><path d="M14 5l-9 9 5 5 9-9"></path><path d="M5 3v4"></path><path d="M3 5h4"></path><path d="M19 17v4"></path><path d="M17 19h4"></path>',
  x: '<path d="M18 6L6 18"></path><path d="M6 6l12 12"></path>',
};

/**
 * Render an inline SVG icon element string.
 */
export function iconSvg(name: IconName): string {
  return `<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
}
