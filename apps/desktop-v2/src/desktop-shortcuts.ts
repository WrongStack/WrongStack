import { type DesktopNavigation, parseDesktopCommand } from './desktop-commands';

/**
 * The desktop's keyboard shortcuts, one table for the handlers and the overlay that lists them.
 * The function keys follow the WebUI's F-key panels where the desktop has the same view; each
 * opens what the named slash command opens, so a key and its command cannot drift apart.
 */
const FUNCTION_KEY_COMMANDS: Readonly<Record<string, string>> = {
  F2: '/fleet',
  F3: '/roster',
  F4: '/worktree',
  F5: '/plan',
  F8: '/processes',
  F9: '/goals',
  F10: '/sessions',
  F11: '/office',
};

/** Where a function key goes, or undefined for a key without a view. */
export function functionKeyTarget(key: string): DesktopNavigation | undefined {
  const name = FUNCTION_KEY_COMMANDS[key];
  return name ? parseDesktopCommand(name)?.command?.opens : undefined;
}

export interface ShortcutGroup {
  /** Stable id for the group's translated title. */
  id: 'desktop' | 'conversation' | 'views';
  title: string;
  /** `id` names the translated description; the views are worded by their command. */
  shortcuts: ReadonlyArray<{ keys: readonly string[]; description: string; id?: string }>;
}

export function shortcutGroups(): ShortcutGroup[] {
  return [
    {
      id: 'desktop',
      title: 'Desktop',
      shortcuts: [
        { id: 'find', keys: ['Ctrl', 'K'], description: 'Find a project or conversation' },
        { id: 'newSession', keys: ['Ctrl', 'N'], description: 'Start a new session' },
        {
          id: 'switchTab',
          keys: ['Alt', '1…9'],
          description: 'Switch to an open conversation tab',
        },
        { id: 'help', keys: ['?'], description: 'Show these shortcuts (also F1)' },
        { id: 'closeDialog', keys: ['Esc'], description: 'Close a dialog' },
      ],
    },
    {
      id: 'conversation',
      title: 'Conversation',
      shortcuts: [
        { id: 'focus', keys: ['Ctrl', '/'], description: 'Focus the composer' },
        { id: 'send', keys: ['Enter'], description: 'Send' },
        { id: 'newLine', keys: ['Shift', 'Enter'], description: 'New line' },
        { id: 'recall', keys: ['↑', '↓'], description: 'Recall earlier prompts' },
        { id: 'commands', keys: ['/'], description: 'Desktop commands (type /help for all)' },
        { id: 'mention', keys: ['@', '$'], description: 'Mention a file or a skill' },
        { id: 'stop', keys: ['Esc'], description: 'Stop the running turn (in the composer)' },
      ],
    },
    {
      id: 'views',
      title: 'Views',
      shortcuts: Object.entries(FUNCTION_KEY_COMMANDS).map(([key, name]) => ({
        keys: [key],
        description: parseDesktopCommand(name)?.command?.description ?? name,
      })),
    },
  ];
}

/** Whether a key press belongs to a text field, where plain keys like `?` are typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const element = target as HTMLElement;
  return (
    element.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName.toUpperCase())
  );
}
