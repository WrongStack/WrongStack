/**
 * The HQ server's update check (`GET /api/system/update`): advisory only. A
 * notice shows when the server says a newer release exists AND the check did
 * not fail; anything malformed shows nothing rather than a wrong version.
 */
export interface HqUpdateStatus {
  current?: unknown;
  latest?: unknown;
  outdated?: unknown;
  checkFailed?: unknown;
  command?: unknown;
}

export interface UpdateNotice {
  current: string;
  latest: string;
  command: string;
}

const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function updateNotice(status: HqUpdateStatus | null | undefined): UpdateNotice | null {
  if (status === null || status === undefined) return null;
  if (status.outdated !== true || status.checkFailed === true) return null;
  const { current, latest, command } = status;
  if (typeof current !== 'string' || typeof latest !== 'string') return null;
  if (!VERSION.test(current) || !VERSION.test(latest) || current === latest) return null;
  return {
    current: current.replace(/^v/, ''),
    latest: latest.replace(/^v/, ''),
    command: typeof command === 'string' && command.trim() !== '' ? command : 'wstack update',
  };
}

/** Six hours: an update notice is advisory, not something to poll for. */
export const UPDATE_POLL_MS = 6 * 60 * 60 * 1000;
