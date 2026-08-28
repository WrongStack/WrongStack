/**
 * ConfirmModal — promise-based in-app replacement for window.confirm().
 *
 * Native confirm() blocks the event loop, can't be styled, and on some
 * embedded/webview hosts is silently disabled (returning false and making
 * destructive actions impossible). Call `confirmModal({...})` from any
 * event handler and await the user's choice; `<ConfirmModalHost />` is
 * mounted once in App next to the other global overlays.
 *
 * Distinct from ConfirmDialog.tsx, which handles the agent's tool-approval
 * flow driven by WS `tool.confirm_needed` events.
 */

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useAppTranslation } from '@/i18n';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Input } from './ui/input';

export interface ConfirmModalOptions {
  title: string;
  /** Optional body text shown under the title. */
  message?: string | undefined;
  /** Optional bullet lines rendered under the message — for warnings that
   *  must enumerate exactly what is affected (e.g. running subagents). */
  details?: string[] | undefined;
  /** Label for the confirming button. Default "Confirm". */
  confirmLabel?: string | undefined;
  /** Label for the dismissing button. Default "Cancel". */
  cancelLabel?: string | undefined;
  /** Destructive styling for the confirm button (deletes etc.). */
  danger?: boolean | undefined;
  /** Which choice receives focus and Enter. Defaults to confirm for compatibility. */
  defaultAction?: 'confirm' | 'cancel' | undefined;
}

interface ConfirmRequest extends ConfirmModalOptions {
  resolve: (confirmed: boolean | null) => void;
}

interface ConfirmModalState {
  request: ConfirmRequest | null;
  open: (request: ConfirmRequest) => void;
  settle: (confirmed: boolean | null) => void;
}

/** Internal — used by ConfirmModalHost and tests. Call confirmModal() instead. */
export const useConfirmModalStore = create<ConfirmModalState>()((set, get) => ({
  request: null,
  open: (request) => {
    // A second confirm while one is pending dismisses the first — native
    // confirm() can't stack either, and resolving false is the safe answer.
    get().request?.resolve(false);
    set({ request });
  },
  settle: (confirmed) => {
    get().request?.resolve(confirmed);
    set({ request: null });
  },
}));

/** Ask the user to confirm. Resolves true on confirm, false otherwise. */
export function confirmModal(options: ConfirmModalOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useConfirmModalStore.getState().open({
      ...options,
      resolve: (decision) => resolve(decision === true),
    });
  });
}

export type ConfirmModalChoice = 'confirm' | 'cancel' | 'dismiss';

/** Three-way variant for workflows where dismissing must not equal either button. */
export function confirmModalChoice(options: ConfirmModalOptions): Promise<ConfirmModalChoice> {
  return new Promise<ConfirmModalChoice>((resolve) => {
    useConfirmModalStore.getState().open({
      ...options,
      resolve: (decision) =>
        resolve(decision === null ? 'dismiss' : decision ? 'confirm' : 'cancel'),
    });
  });
}

export function ConfirmModalHost() {
  const { t } = useAppTranslation();
  const request = useConfirmModalStore((s) => s.request);
  const settle = useConfirmModalStore((s) => s.settle);

  // Enter confirms — Radix already maps Escape to close (→ cancel).
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        useConfirmModalStore.getState().settle(request.defaultAction !== 'cancel');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request]);

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          {request?.message && <DialogDescription>{request.message}</DialogDescription>}
          {request?.details && request.details.length > 0 && (
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-left text-xs text-foreground/85">
              {request.details.map((line, i) => (
                <li key={`${i}-${line}`} className="flex gap-2">
                  <span aria-hidden="true" className="shrink-0 text-warning">
                    •
                  </span>
                  <span className="min-w-0 break-words">{line}</span>
                </li>
              ))}
            </ul>
          )}
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            autoFocus={request?.defaultAction === 'cancel'}
            onClick={() => settle(false)}
          >
            {request?.cancelLabel ?? t('common:action.cancel')}
          </Button>
          <Button
            variant={request?.danger ? 'destructive' : 'default'}
            size="sm"
            autoFocus={request?.defaultAction !== 'cancel'}
            onClick={() => settle(true)}
          >
            {request?.confirmLabel ?? t('common:action.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── promptModal — in-app replacement for window.prompt() ────────────────────

export interface PromptModalOptions {
  title: string;
  message?: string | undefined;
  placeholder?: string | undefined;
  defaultValue?: string | undefined;
  confirmLabel?: string | undefined;
  cancelLabel?: string | undefined;
}

interface PromptRequest extends PromptModalOptions {
  resolve: (value: string | null) => void;
}

interface PromptModalState {
  request: PromptRequest | null;
  open: (request: PromptRequest) => void;
  settle: (value: string | null) => void;
}

/** Internal — used by PromptModalHost and tests. Call promptModal() instead. */
export const usePromptModalStore = create<PromptModalState>()((set, get) => ({
  request: null,
  open: (request) => {
    get().request?.resolve(null);
    set({ request });
  },
  settle: (value) => {
    get().request?.resolve(value);
    set({ request: null });
  },
}));

/** Ask the user for a line of text. Resolves the trimmed string, or null on cancel/empty. */
export function promptModal(options: PromptModalOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    usePromptModalStore.getState().open({ ...options, resolve });
  });
}

export function PromptModalHost() {
  const { t } = useAppTranslation();
  const request = usePromptModalStore((s) => s.request);
  const settle = usePromptModalStore((s) => s.settle);
  const [value, setValue] = useState('');

  // Seed the input each time a new request opens.
  useEffect(() => {
    setValue(request?.defaultValue ?? '');
  }, [request]);

  const submit = () => {
    const v = value.trim();
    settle(v.length > 0 ? v : null);
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          {request?.message && <DialogDescription>{request.message}</DialogDescription>}
        </DialogHeader>
        <Input
          autoFocus
          value={value}
          placeholder={request?.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => settle(null)}>
            {request?.cancelLabel ?? t('common:action.cancel')}
          </Button>
          <Button size="sm" disabled={value.trim().length === 0} onClick={submit}>
            {request?.confirmLabel ?? t('common:action.ok')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
