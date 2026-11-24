/**
 * "Import from HQ" as one question-at-a-time flow, shared by the readline
 * `/auth` menu (`wstack auth`, key `h`) and the TUI auth panel (via the panel
 * host). Not enrolled yet → asks for the HQ address and the enrollment token,
 * enrolls, shows both fingerprints. Enrolled → lists the provider profiles
 * HQ grants this device and imports what the user picks (Enter = everything).
 */
import { color } from '@wrongstack/core/utils';
import type { HqVaultOpenedProfile } from '@wrongstack/hq';
import type { AuthMenuDeps } from '../auth-menu/types.js';
import { globalRootForConfigPath } from '../provider-config-utils.js';
import { HqCredentialService, type HqImportChange, type HqImportReport } from './service.js';

export function createHqCredentialService(
  deps: Pick<AuthMenuDeps, 'vault' | 'profileConfigPath'>,
  globalRoot = globalRootForConfigPath(deps.profileConfigPath),
): HqCredentialService {
  return new HqCredentialService({
    globalRoot,
    vault: deps.vault,
    profileConfigPath: deps.profileConfigPath,
  });
}

/** One granted profile as a line: id, endpoint, keys, HQ's active key. */
export function formatHqProfileLine(profile: HqVaultOpenedProfile): string {
  const keys = profile.keys.map((k) =>
    k.authMethod === 'oauth' ? `${k.label} (sign-in)` : k.label,
  );
  const endpoint = profile.baseUrl ? ` ${profile.baseUrl}` : '';
  const active = profile.activeKey ? `, active ${profile.activeKey}` : '';
  return `  ${profile.id} [${profile.family ?? profile.type}]${endpoint} — ${keys.length} key${keys.length === 1 ? '' : 's'}${keys.length ? `: ${keys.join(', ')}` : ''}${active}`;
}

/** The report as plain lines (no colour), for any renderer. */
export function formatHqImportReport(report: HqImportReport): string[] {
  const lines: string[] = [];
  const name = (c: HqImportChange): string => {
    const where =
      c.providerId === c.profileId ? c.providerId : `${c.providerId} (HQ ${c.profileId})`;
    return c.key ? `${where}/${c.key}` : where;
  };
  for (const c of report.added) lines.push(`+ added    ${name(c)}`);
  for (const c of report.updated) lines.push(`~ updated  ${name(c)} (changed in HQ)`);
  for (const c of report.removed) lines.push(`- removed  ${name(c)} (HQ no longer grants it)`);
  for (const c of report.renamed) {
    lines.push(`~ renamed  ${name(c)} → ${c.to} (HQ now uses that key name)`);
  }
  if (lines.length === 0) {
    lines.push(
      report.unchanged.length > 0
        ? `Already up to date (${report.unchanged.length} provider${report.unchanged.length === 1 ? '' : 's'}).`
        : 'Nothing to import.',
    );
  }
  return lines;
}

/** Interactive flow. Resolves to an exit code; a thrown prompt (Esc in the TUI) cancels. */
export async function runHqImportFlow(deps: AuthMenuDeps): Promise<number> {
  const service = createHqCredentialService(deps);
  let device = await service.device();
  if (!device) {
    deps.renderer.write(
      `This machine is not enrolled with an HQ key vault yet.\n${color.dim(
        'In HQ open System → Providers → Devices → "Enroll a device" and copy the address and token it shows.',
      )}\n`,
    );
    const url = (await deps.reader.readLine(`${color.amber('?')} HQ address: `)).trim();
    if (!url) return 1;
    const token = (await deps.reader.readSecret('Enrollment token: ')).trim();
    if (!token) return 1;
    const enrolled = await service.enroll(url, token);
    device = enrolled.device;
    deps.renderer.write(
      `${color.green('✓')} Enrolled with ${device.hqUrl}\n` +
        `  HQ fingerprint:     ${device.hq.fingerprint}\n` +
        `  This device:        ${enrolled.fingerprint}\n` +
        `${color.dim('  Compare both with HQ → System → Providers.')}\n`,
    );
    if (device.status !== 'approved') {
      deps.renderer.writeInfo(
        'HQ has to approve this device before it can receive keys. Approve it in HQ, then run Import from HQ again.',
      );
      return 0;
    }
  }

  const granted = await service.list();
  if (granted.length === 0) {
    deps.renderer.writeInfo(`HQ (${device.hqUrl}) grants this device no providers yet.`);
    return 0;
  }
  deps.renderer.write(
    `\n${color.bold('Providers HQ grants this device')} ${color.dim(device.hqUrl)}\n`,
  );
  granted.forEach((profile, index) => {
    deps.renderer.write(
      `  ${color.bold(String(index + 1).padStart(2))}${formatHqProfileLine(profile).slice(1)}\n`,
    );
  });
  const answer = (
    await deps.reader.readLine(
      `\n${color.amber('?')} Import which? ${color.dim('(Enter = all, e.g. 1,3; q = cancel)')} `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer === 'q' || answer === 'quit') return 0;
  let profileIds: string[] | undefined;
  if (answer !== '' && answer !== 'all') {
    const picked = answer
      .split(/[\s,]+/)
      .map((part) => Number.parseInt(part, 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= granted.length);
    if (picked.length === 0) {
      deps.renderer.writeError(`No provider matches "${answer}".`);
      return 1;
    }
    profileIds = [...new Set(picked.map((n) => granted[n - 1]!.id))];
  }
  const report = await service.importKeys({ ...(profileIds ? { profileIds } : {}) });
  for (const line of formatHqImportReport(report)) deps.renderer.write(`  ${line}\n`);
  return 0;
}
