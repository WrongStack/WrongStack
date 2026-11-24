/**
 * The one hand-off between a process's HQ connection (the publisher, which
 * receives `hq.vault_changed`) and its HQ key-vault client (which knows
 * whether this machine is enrolled, and with which HQ). Kept apart from the
 * client so the publisher pulls in nothing of it.
 */
import type { HqVaultChangedNotice } from '../protocol/vault.js';

type HqVaultNoticeListener = (notice: HqVaultChangedNotice) => void;

const listeners = new Set<HqVaultNoticeListener>();

/** Listen for vault-changed notices from any HQ connection in this process. */
export function onHqVaultNotice(listener: HqVaultNoticeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by the publisher; a listener's failure never reaches the socket. */
export function deliverHqVaultNotice(notice: HqVaultChangedNotice): void {
  for (const listener of listeners) {
    try {
      listener(notice);
    } catch {
      // A listener reports its own failures.
    }
  }
}
