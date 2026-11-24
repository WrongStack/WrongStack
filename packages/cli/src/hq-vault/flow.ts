/**
 * "Import from HQ" as one question-at-a-time flow, shared by the readline
 * `/auth` menu (`wstack auth`, key `h`) and the TUI auth panel (via the panel
 * host). Not enrolled yet → asks for the HQ address and the enrollment token,
 * enrolls, shows both fingerprints. Enrolled → lists what HQ grants this
 * device and imports what the user picks (Enter = everything).
 */
import { color } from '@wrongstack/core/utils';
import type { AuthMenuDeps } from '../auth-menu/types.js';
import { globalRootForConfigPath } from '../provider-config-utils.js';
import { HqCredentialService, type HqImportReport } from './service.js';

export function createHqCredentialService(
  deps: Pick<AuthMenuDeps, 'vault' | 'profileConfigPath' | 'modelsRegistry'>,
  globalRoot = globalRootForConfigPath(deps.profileConfigPath),
): HqCredentialService {
  return new HqCredentialService({
    globalRoot,
    vault: deps.vault,
    profileConfigPath: deps.profileConfigPath,
    modelsRegistry: deps.modelsRegistry,
  });
}

/** The report as plain lines (no colour), for any renderer. */
export function formatHqImportReport(report: HqImportReport): string[] {
  const lines: string[] = [];
  const name = (c: { providerId: string; label: string }): string => `${c.providerId}/${c.label}`;
  for (const c of report.added) lines.push(`+ added    ${name(c)}`);
  for (const c of report.updated) lines.push(`~ updated  ${name(c)} (HQ replaced it)`);
  for (const c of report.removed) lines.push(`- removed  ${name(c)} (HQ no longer grants it)`);
  for (const c of report.skipped) lines.push(`! skipped  ${name(c)} — ${c.reason}`);
  if (lines.length === 0) {
    lines.push(
      report.unchanged.length > 0
        ? `Already up to date (${report.unchanged.length} key${report.unchanged.length === 1 ? '' : 's'}).`
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
        'In HQ open System → Keys → "Enroll a device" and copy the address and token it shows.',
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
        `${color.dim('  Compare both with HQ → System → Keys.')}\n`,
    );
    if (device.status !== 'approved') {
      deps.renderer.writeInfo(
        'HQ has to approve this device before it can receive keys. Approve it in HQ, then run Import from HQ again.',
      );
      return 0;
    }
  }

  const granted = await service.list();
  const usable = granted.filter((item) => item.policy === 'local');
  if (granted.length === 0) {
    deps.renderer.writeInfo(`HQ (${device.hqUrl}) grants this device no keys yet.`);
    return 0;
  }
  deps.renderer.write(`\n${color.bold('Keys HQ grants this device')} ${color.dim(device.hqUrl)}\n`);
  granted.forEach((item, index) => {
    const lease = item.policy === 'lease' ? color.dim(' (lease — not imported yet)') : '';
    const active = item.setActive ? color.dim(' · becomes active') : '';
    deps.renderer.write(
      `  ${color.bold(String(index + 1).padStart(2))}  ${item.providerId}/${item.label} ${color.dim(`v${item.version}`)}${active}${lease}\n`,
    );
  });
  if (usable.length === 0) {
    deps.renderer.writeInfo('Every granted key is a lease; nothing can be imported to disk.');
    return 0;
  }
  const answer = (
    await deps.reader.readLine(
      `\n${color.amber('?')} Import which? ${color.dim('(Enter = all, e.g. 1,3; q = cancel)')} `,
    )
  )
    .trim()
    .toLowerCase();
  if (answer === 'q' || answer === 'quit') return 0;
  let keyIds: string[] | undefined;
  if (answer !== '' && answer !== 'all') {
    const picked = answer
      .split(/[\s,]+/)
      .map((part) => Number.parseInt(part, 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= granted.length);
    if (picked.length === 0) {
      deps.renderer.writeError(`No key matches "${answer}".`);
      return 1;
    }
    keyIds = [...new Set(picked.map((n) => granted[n - 1]!.secretId))];
  }
  const report = await service.importKeys({ ...(keyIds ? { keyIds } : {}) });
  for (const line of formatHqImportReport(report)) deps.renderer.write(`  ${line}\n`);
  return report.skipped.length > 0 && report.added.length + report.updated.length === 0 ? 1 : 0;
}
