/**
 * RestoreTabsModal — "these sessions were in your tabs; want them back?"
 *
 * The tab strip is persisted in the browser, so it outlives the process that
 * created it. Two behaviours were wrong in opposite directions: restoring it
 * blindly made a fresh `wstack --webui` come up wearing the previous run's
 * tabs and pay for a full journal resume before the user typed anything;
 * dropping it silently made work the user meant to return to vanish.
 *
 * This is the third option, and the only honest one. A fresh WebUI IS fresh —
 * one new session, one tab — and the sessions that were in the strip are
 * offered by name. Resuming becomes what it always should have been: an
 * explicit act on sessions the user picked.
 *
 * Only appears when the runtime came up holding NONE of the persisted tabs
 * (see `restoreTabsAfterBoot`). An F5 against a live server restores in place
 * and never reaches here — there is nothing to ask about.
 */

import { useEffect, useMemo, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { getWSClient } from '@/lib/ws-client';
import { useHistoryStore } from '@/stores/history-store';
import { useRestoreTabsStore } from '@/stores/restore-tabs-store';
import { MAX_OPEN_TABS, useSessionTabStore } from '@/stores/session-tab-store';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

function relativeTime(iso: string | undefined): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function RestoreTabsModal() {
  const { t } = useAppTranslation();
  const candidates = useRestoreTabsStore((s) => s.candidates);
  const dismiss = useRestoreTabsStore((s) => s.dismiss);
  const historyEntries = useHistoryStore((s) => s.entries);
  const openTabIds = useSessionTabStore((s) => s.openTabIds);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // How many more tabs will fit beside the ones already open. The fresh boot
  // session normally occupies one, so this is usually MAX_OPEN_TABS - 1.
  const room = Math.max(0, MAX_OPEN_TABS - openTabIds.length);

  // Preselect as many as will fit, newest first — the common answer is "yes,
  // bring them back", and an offer that starts with nothing ticked makes the
  // user do the work twice.
  useEffect(() => {
    setSelected(new Set(candidates.slice(0, room)));
  }, [candidates, room]);

  const rows = useMemo(
    () =>
      candidates.map((id) => {
        const entry = historyEntries.find((e) => e.id === id);
        return {
          id,
          title: entry?.name || entry?.title || id,
          meta: [
            entry?.messageCount ? `${entry.messageCount} messages` : '',
            relativeTime(entry?.lastActivityAt ?? entry?.startedAt),
          ]
            .filter(Boolean)
            .join(' · '),
        };
      }),
    [candidates, historyEntries],
  );

  if (candidates.length === 0) return null;

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < room) next.add(id);
      return next;
    });
  };

  const restore = (): void => {
    const ws = getWSClient();
    const tabs = useSessionTabStore.getState();
    for (const id of candidates) {
      if (!selected.has(id)) continue;
      // The same path the History list uses, so a restored tab is
      // indistinguishable from one the user opened by hand.
      tabs.openTab(id, { resumeSession: (target) => ws.resumeSessionById(target) });
    }
    dismiss();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Escape / click-away means "start fresh" — the safe answer, and the
        // one the user gets by doing nothing.
        if (!open) dismiss();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('restoreTabs.title', { defaultValue: 'Restore your previous tabs?' })}
          </DialogTitle>
          <DialogDescription>
            {t('restoreTabs.body', {
              count: candidates.length,
              defaultValue:
                'This WebUI started fresh. {{count}} session(s) were open in this browser before — they are still on disk. Pick the ones to reopen, or start clean.',
            })}
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border/60 bg-muted/30 p-2">
          {rows.map((row) => {
            const checked = selected.has(row.id);
            const full = !checked && selected.size >= room;
            return (
              <li key={row.id}>
                <label
                  className={`flex cursor-pointer items-start gap-3 rounded px-2 py-1.5 text-left text-xs hover:bg-muted/60 ${
                    full ? 'opacity-50' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 shrink-0"
                    checked={checked}
                    disabled={full}
                    onChange={() => toggle(row.id)}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{row.title}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {row.meta ? `${row.meta} · ` : ''}
                      {row.id}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>

        {room < candidates.length && (
          <p className="text-[11px] text-muted-foreground">
            {t('restoreTabs.limit', {
              room,
              max: MAX_OPEN_TABS,
              defaultValue:
                'At most {{room}} more can be reopened ({{max}} tabs total). The rest stay in History.',
            })}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={dismiss}>
            {t('restoreTabs.fresh', { defaultValue: 'Start fresh' })}
          </Button>
          <Button size="sm" disabled={selected.size === 0} onClick={restore}>
            {t('restoreTabs.confirm', {
              count: selected.size,
              defaultValue: 'Reopen {{count}}',
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
