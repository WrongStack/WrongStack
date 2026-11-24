/**
 * HQ → every connected client: the key vault changed. It names no profile,
 * device or key and carries no value — a machine enrolled with this HQ (the
 * `hqId` it pinned) fetches its own sealed, signed bundle; every other client
 * ignores it. Nothing here travels through the command queue.
 */
export interface HqVaultChangedNotice {
  /** The vault's HQ identity (`hqId`), as a device pinned it at enrollment. */
  hqId: string;
  /** HQ's change counter after the change (see `HqVaultBundle.revision`). */
  revision: number;
}

export interface HqServerVaultChangedMessage {
  type: 'hq.vault_changed';
  payload: HqVaultChangedNotice;
}

export function isHqVaultChangedNotice(value: unknown): value is HqVaultChangedNotice {
  if (!value || typeof value !== 'object') return false;
  const notice = value as Partial<HqVaultChangedNotice>;
  return (
    typeof notice.hqId === 'string' &&
    /^[0-9a-f]{16,64}$/.test(notice.hqId) &&
    Number.isSafeInteger(notice.revision) &&
    (notice.revision as number) >= 0
  );
}
