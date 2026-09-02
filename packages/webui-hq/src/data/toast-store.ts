/**
 * Toast notification store — lightweight queue for transient error/success
 * messages in the HQ dashboard. Uses zustand, matching the same pattern as
 * store.ts so the existing state infrastructure is reused without adding a
 * new dependency.
 */

import { create } from 'zustand';

export type ToastSeverity = 'error' | 'warning' | 'info' | 'success';

export interface ToastEntry {
  id: string;
  message: string;
  severity: ToastSeverity;
  createdAt: number;
  /** Auto-dismiss timeout in ms. 0 = sticky (must close manually). */
  ttlMs: number;
  /** Optional action label shown on a dismiss button. */
  action?: string | undefined;
}

interface ToastState {
  toasts: ToastEntry[];
  addToast: (message: string, severity?: ToastSeverity, ttlMs?: number, action?: string) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

const MAX_TOASTS = 5;
const DEFAULT_TTL_MS = 6_000;

let counter = 0;

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],
  addToast: (message, severity = 'info', ttlMs = DEFAULT_TTL_MS, action) => {
    const id = `toast-${++counter}-${Date.now()}`;
    const entry: ToastEntry = { id, message, severity, createdAt: Date.now(), ttlMs, action };
    set((state) => ({
      toasts: [...state.toasts.slice(-(MAX_TOASTS - 1)), entry],
    }));
    if (ttlMs > 0) {
      setTimeout(() => {
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }));
      }, ttlMs);
    }
  },
  removeToast: (id) =>
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    })),
  clearToasts: () => set({ toasts: [] }),
}));
