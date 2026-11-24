/**
 * "Import from HQ" for every WebUI-protocol client (WebUI, VibeUI, Desktop):
 * enroll this machine with an HQ key vault, list and import the provider
 * profiles HQ grants it, keep them in step, and forget the HQ again.
 *
 * The work is `@wrongstack/hq`'s device client (the same one `wstack hq` and
 * the TUI use), injected by the host with its own locked config writer.
 * Every request answers `hq.state`; changes also broadcast the saved list.
 *
 * Enrolling carries the one-time code, whose secrecy the enrollment MAC rests
 * on, so it is accepted only from a loopback peer or over TLS — the same rule
 * HQ applies to minting the code.
 */
import type { HqCredentialService, HqImportReport, HqVaultOpenedProfile } from '@wrongstack/hq';
import { hqDeviceFingerprint } from '@wrongstack/hq';
import type { WebSocket } from 'ws';
import { errMessage } from '../ws-utils.js';
import type { ProviderServiceContext } from './mutations.js';

export interface HqGrantedProfileView {
  id: string;
  type: string;
  family?: string;
  baseUrl?: string;
  keyCount: number;
  activeKey?: string;
}

export interface HqStateView {
  /** False when this host has no HQ client (nothing below is set). */
  available: boolean;
  enrolled: boolean;
  hqUrl?: string;
  hqFingerprint?: string;
  deviceFingerprint?: string;
  status?: string;
  granted?: HqGrantedProfileView[];
  /** Why the granted list could not be read (HQ unreachable, device pending…). */
  grantedError?: string;
  /** What the last import / sync / unenroll did, one line each. */
  report?: string[];
  error?: string;
}

function grantedView(profile: HqVaultOpenedProfile): HqGrantedProfileView {
  return {
    id: profile.id,
    type: profile.type,
    ...(profile.family ? { family: profile.family } : {}),
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    keyCount: profile.keys.length,
    ...(profile.activeKey ? { activeKey: profile.activeKey } : {}),
  };
}

/** Plain lines for a report; kept beside the CLI's wording. */
export function hqReportLines(report: HqImportReport): string[] {
  const name = (c: { providerId: string; profileId: string; key?: string }) => {
    const where =
      c.providerId === c.profileId ? c.providerId : `${c.providerId} (HQ ${c.profileId})`;
    return c.key ? `${where}/${c.key}` : where;
  };
  const lines = [
    ...report.added.map((c) => `Added ${name(c)}`),
    ...report.updated.map((c) => `Updated ${name(c)} (changed in HQ)`),
    ...report.removed.map((c) => `Removed ${name(c)} (HQ no longer grants it)`),
    ...report.renamed.map((c) => `Renamed ${name(c)} → ${c.to} (HQ now uses that key name)`),
  ];
  if (lines.length === 0) {
    lines.push(
      report.unchanged.length > 0
        ? `Already up to date (${report.unchanged.length} provider${report.unchanged.length === 1 ? '' : 's'}).`
        : 'Nothing to import.',
    );
  }
  return lines;
}

/** Whether a socket's peer keeps the enrollment code off the network. */
export function isPrivateHqChannel(ws: WebSocket): boolean {
  const socket = (ws as WebSocket & { _socket?: { remoteAddress?: unknown; encrypted?: unknown } })
    ._socket;
  if (socket?.encrypted === true) return true;
  const address = typeof socket?.remoteAddress === 'string' ? socket.remoteAddress : '';
  return address === '::1' || /^(?:::ffff:)?127\./.test(address);
}

export function createHqImportHandlers(ctx: ProviderServiceContext) {
  const service = (): HqCredentialService | undefined => ctx.deps.hqCredentials;

  async function state(extra: Partial<HqStateView> = {}): Promise<HqStateView> {
    const hq = service();
    if (!hq) return { available: false, enrolled: false, ...extra };
    const device = await hq.device().catch(() => undefined);
    if (!device) return { available: true, enrolled: false, ...extra };
    const view: HqStateView = {
      available: true,
      enrolled: true,
      hqUrl: device.hqUrl,
      hqFingerprint: device.hq.fingerprint,
      deviceFingerprint: hqDeviceFingerprint(device),
      status: device.status,
    };
    try {
      view.granted = (await hq.list()).map(grantedView);
      view.status = 'approved';
    } catch (error) {
      view.grantedError = errMessage(error);
    }
    return { ...view, ...extra };
  }

  async function reply(ws: WebSocket, extra: Partial<HqStateView> = {}): Promise<void> {
    ctx.sendMessage(ws, { type: 'hq.state', payload: await state(extra) });
  }

  async function changed(): Promise<void> {
    ctx.broadcastSaved(await ctx.loadConfigProviders());
  }

  async function handleHqStatus(ws: WebSocket): Promise<void> {
    await reply(ws);
  }

  async function handleHqEnroll(
    ws: WebSocket,
    payload: { hqUrl: string; token: string; label?: string | undefined },
  ): Promise<void> {
    const hq = service();
    if (!hq) return reply(ws, { error: 'This host has no HQ client.' });
    if (!isPrivateHqChannel(ws)) {
      return reply(ws, {
        error:
          'Enroll from this machine (or over HTTPS): the enrollment code must not cross the network in the clear.',
      });
    }
    try {
      await hq.enroll(payload.hqUrl, payload.token, {
        ...(payload.label ? { label: payload.label } : {}),
      });
      await reply(ws);
    } catch (error) {
      await reply(ws, { error: errMessage(error) });
    }
  }

  async function run(
    ws: WebSocket,
    op: (hq: HqCredentialService) => Promise<string[]>,
  ): Promise<void> {
    const hq = service();
    if (!hq) return reply(ws, { error: 'This host has no HQ client.' });
    try {
      const report = await op(hq);
      await changed();
      await reply(ws, { report });
    } catch (error) {
      await reply(ws, { error: errMessage(error) });
    }
  }

  return {
    handleHqStatus,
    handleHqEnroll,
    handleHqImport: (ws: WebSocket, profileIds?: string[]) =>
      run(ws, async (hq) => hqReportLines(await hq.importKeys(profileIds ? { profileIds } : {}))),
    handleHqSync: (ws: WebSocket) => run(ws, async (hq) => hqReportLines(await hq.sync())),
    handleHqUnenroll: (ws: WebSocket, removeKeys: boolean) =>
      run(ws, async (hq) => {
        const { removed } = await hq.unenroll({ removeKeys });
        return removed.length > 0
          ? removed.map((c) => `Removed ${c.key ? `${c.providerId}/${c.key}` : c.providerId}`)
          : ['This machine no longer talks to HQ.'];
      }),
  };
}
