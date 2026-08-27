import { Check, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores/config-store';
import { useActiveSessionId } from '@/stores/session-lanes';
import { systemPromptCurrent, useSystemPromptStore } from '@/stores/system-prompt-store';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

/**
 * Identity-prompt size picker.
 *
 * Opened two ways, and the difference is the whole point of
 * `pickerStartsSession`:
 *  - **New session** — the user asked for a fresh context, so confirming here
 *    applies the variant *and then* starts the session. Applying first matters:
 *    `session.new` keeps the process alive, so the new session inherits
 *    whatever system prompt is live at that moment.
 *  - **First run** — no variant has ever been chosen, and the chat is still
 *    empty. Confirming only applies the variant; there is nothing to restart.
 *
 * The token figures are upper bounds computed from the same builder the server
 * uses, so they track a project's own `.wrongstack/instructions` overrides
 * instead of quoting the shipped defaults.
 */
export function SystemPromptDialog() {
  const { t } = useAppTranslation();
  const { wsUrl } = useConfigStore();
  const { info, pickerOpen, pickerStartsSession, closePicker } = useSystemPromptStore();
  const sessionId = useActiveSessionId();
  // Which variant is live HERE. The catalogue is shared between tabs; the
  // choice is not.
  const current = useSystemPromptStore((s) => systemPromptCurrent(s, sessionId));
  const [selected, setSelected] = useState<string | null>(null);

  // Re-seed the selection from the live variant each time the dialog opens, so
  // an abandoned pick does not linger into the next open.
  useEffect(() => {
    if (pickerOpen) setSelected(current);
  }, [pickerOpen, current]);

  // Only one `system_prompt.get` is sent per connection, so a tab opened later
  // has never had its own variant answered for and would fall back to the last
  // tab that did. Ask for this one on open — the reply is stamped and lands in
  // its own slot.
  useEffect(() => {
    if (!pickerOpen || !sessionId) return;
    if (useSystemPromptStore.getState().currentBySession[sessionId] !== undefined) return;
    getWSClient(wsUrl).getSystemPrompt();
  }, [pickerOpen, sessionId, wsUrl]);

  const variants = info?.variants ?? [];
  const unavailable = variants.length === 0;

  const confirm = () => {
    const client = getWSClient(wsUrl);
    if (selected && selected !== current) {
      client.setSystemPromptVariant(selected as 'lite' | 'default' | 'pro');
    }
    if (pickerStartsSession) {
      client.newSession({ systemPromptVariant: selected ?? undefined });
    }
    closePicker();
  };

  return (
    <Dialog open={pickerOpen} onOpenChange={(open) => !open && closePicker()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4" />
            {t('activity:systemPrompt.title')}
          </DialogTitle>
          <DialogDescription>
            {info?.chosen === false
              ? t('activity:systemPrompt.firstRunDescription')
              : t('activity:systemPrompt.description')}
          </DialogDescription>
        </DialogHeader>

        {unavailable ? (
          <p className="text-sm text-muted-foreground py-2">
            {t('activity:systemPrompt.unavailable')}
          </p>
        ) : (
          <div className="flex flex-col gap-2 py-1">
            {variants.map((v) => {
              const active = selected === v.variant;
              return (
                <button
                  key={v.variant}
                  type="button"
                  onClick={() => setSelected(v.variant)}
                  aria-pressed={active}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                    active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      active ? 'border-primary bg-primary text-primary-foreground' : 'border-border'
                    }`}
                  >
                    {active && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="font-medium">{v.label}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {t('activity:systemPrompt.tokens', { count: v.tokens })}
                      </span>
                      {v.variant === current && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t('activity:systemPrompt.current')}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{v.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={closePicker}>
            {t('activity:systemPrompt.cancel')}
          </Button>
          <Button onClick={confirm} disabled={unavailable}>
            {pickerStartsSession
              ? t('activity:systemPrompt.applyAndStart')
              : t('activity:systemPrompt.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
