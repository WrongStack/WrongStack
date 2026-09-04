import { useLocalPrefs, useUIStore } from '@/stores';
import { useAppTranslation } from '@/i18n';
import { platformKeyLabel } from '@/lib/platform';
import { Keyboard } from 'lucide-react';
import { useEffect } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from './ui/dialog';

interface Shortcut {
  keys: string[];
  descKey: string;
}

const SHORTCUTS: Array<{ sectionKey: string; items: Shortcut[] }> = [
  {
    sectionKey: 'sectionGlobal',
    items: [
      { keys: ['Ctrl', 'K'], descKey: 'dCommandPalette' },
      { keys: ['?'], descKey: 'dShowOverlay' },
      { keys: ['Ctrl', '\\'], descKey: 'dToggleSidebar' },
      { keys: ['Ctrl', '1-8'], descKey: 'dOpenPanel' },
      { keys: ['Ctrl', '9'], descKey: 'dSettings' },
      { keys: ['Ctrl', '0'], descKey: 'dDesignStudio' },
      { keys: ['Ctrl', 'Shift', 'W'], descKey: 'dWorktrees' },
      { keys: ['Ctrl', 'Shift', 'K'], descKey: 'dMemory' },
      { keys: ['Ctrl', '/'], descKey: 'dFocusInput' },
    ],
  },
  {
    sectionKey: 'sectionTuiParity',
    items: [
      { keys: ['F1'], descKey: 'dSessionPanel' },
      { keys: ['F2'], descKey: 'dFleetOverlay' },
      { keys: ['F3'], descKey: 'dAgentsOverlay' },
      { keys: ['F4'], descKey: 'dWorktreeMonitor' },
      { keys: ['F5'], descKey: 'dPlanPanel' },
      { keys: ['F6'], descKey: 'dTodosPanel' },
      { keys: ['F7'], descKey: 'dQueuePanel' },
      { keys: ['F8'], descKey: 'dProcessMonitor' },
      { keys: ['F9'], descKey: 'dGoalPanel' },
      { keys: ['F10'], descKey: 'dSessionsDashboard' },
      { keys: ['F11'], descKey: 'dOfficeMap' },
      { keys: ['F12'], descKey: 'dDockPicker' },
    ],
  },
  {
    sectionKey: 'sectionFleet',
    items: [
      { keys: ['Ctrl', 'Shift', 'M'], descKey: 'dOpenFleet' },
      { keys: ['Ctrl', 'Shift', 'A'], descKey: 'dOpenAgents' },
      { keys: ['↑', '↓'], descKey: 'dNavigateAgents' },
      { keys: ['Enter'], descKey: 'dSelectAgent' },
      { keys: ['Esc'], descKey: 'dCloseOverlay' },
    ],
  },
  {
    sectionKey: 'sectionChatInput',
    items: [
      { keys: ['Enter'], descKey: 'dSendMessage' },
      { keys: ['Shift', 'Enter'], descKey: 'dNewline' },
      { keys: ['↑'], descKey: 'dRecallPrev' },
      { keys: ['↓'], descKey: 'dRecallNext' },
      { keys: ['/'], descKey: 'dSlashPopup' },
      { keys: ['Tab'], descKey: 'dAutocomplete' },
      { keys: ['Esc'], descKey: 'dDismissPopup' },
    ],
  },
  {
    sectionKey: 'sectionChat',
    items: [
      { keys: ['Alt', 'Enter'], descKey: 'dFastSend' },
      { keys: ['↑'], descKey: 'dPreviousPrompt' },
      { keys: ['↓'], descKey: 'dNextPrompt' },
      { keys: ['Esc'], descKey: 'dAbortStream' },
    ],
  },
  {
    sectionKey: 'sectionChatNav',
    items: [
      { keys: ['j'], descKey: 'dFocusNext' },
      { keys: ['k'], descKey: 'dFocusPrev' },
      { keys: ['g'], descKey: 'dJumpFirst' },
      { keys: ['Shift', 'G'], descKey: 'dJumpLast' },
      { keys: ['c'], descKey: 'dCopyFocused' },
      { keys: ['Esc'], descKey: 'dClearFocused' },
    ],
  },
];

export function ShortcutsOverlay() {
  const { t } = useAppTranslation();
  const open = useUIStore((s) => s.shortcutsOpen);
  const setOpen = useUIStore((s) => s.setShortcutsOpen);
  const keyboardShortcuts = useLocalPrefs((s) => s.keyboardShortcuts);

  useEffect(() => {
    if (!keyboardShortcuts) return;
    const onKey = (e: KeyboardEvent) => {
      // "?" toggles from anywhere (open when closed); Escape-on-close is
      // handled by Radix Dialog now, so it's intentionally not mirrored here.
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTyping = tag === 'input' || tag === 'textarea' || target?.isContentEditable;
      if (!isTyping && e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen(!useUIStore.getState().shortcutsOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen, keyboardShortcuts]);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setOpen(false);
      }}
    >
      <DialogContent className="max-w-2xl gap-0 p-0 overflow-hidden flex flex-col max-h-[80dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-muted-foreground" />
            <DialogTitle className="text-sm font-semibold">
              {t('activity:shortcuts.heading')}
            </DialogTitle>
          </div>
        </div>
        <DialogDescription className="sr-only">{t('activity:shortcuts.heading')}</DialogDescription>
        <div className="overflow-y-auto overscroll-contain px-5 py-4 space-y-6">
          {SHORTCUTS.map((group) => (
            <div key={group.sectionKey}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
                {t(`activity:shortcuts.${group.sectionKey}`)}
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {group.items.map((s) => (
                  <div
                    key={s.descKey}
                    className="flex items-center justify-between gap-3 text-sm px-2 py-1.5 rounded hover:bg-muted/40"
                  >
                    <span className="text-foreground/80">
                      {t(`activity:shortcuts.${s.descKey}`)}
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k, ki) => (
                        <span key={k} className="flex items-center gap-1">
                          {ki > 0 && <span className="text-muted-foreground/65 text-xs">+</span>}
                          <kbd className="font-mono text-[10px] border rounded px-1.5 py-0.5 bg-background">
                            {platformKeyLabel(k)}
                          </kbd>
                        </span>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t px-5 py-3 text-xs text-muted-foreground">
          {t('activity:shortcuts.footerPre')}{' '}
          <kbd className="font-mono text-[10px] border rounded px-1 py-0.5 bg-background">?</kbd>{' '}
          {t('activity:shortcuts.footerPost')}
        </div>
      </DialogContent>
    </Dialog>
  );
}
