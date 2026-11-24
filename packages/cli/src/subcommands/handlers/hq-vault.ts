/**
 * `wstack hq enroll|device|sync|unenroll` — this machine's side of the HQ key
 * vault. Everything goes through HqCredentialService; see `hq-vault/service.ts`.
 *
 *   wstack hq enroll <hq-url> <token> [--label <name>] [--replace]
 *   wstack hq device                     enrollment, fingerprints, granted keys
 *   wstack hq sync                       import granted keys, apply rotations, drop revoked ones
 *   wstack hq unenroll [--remove-keys]   forget the HQ identity (and the keys it delivered)
 */
import { color } from '@wrongstack/core/utils';
import { hqDeviceFingerprint } from '../../hq-vault/device-store.js';
import { createHqCredentialService, formatHqImportReport } from '../../hq-vault/flow.js';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import type { SubcommandDeps } from '../contracts.js';

export const HQ_VAULT_SUBCOMMANDS = new Set(['enroll', 'device', 'sync', 'unenroll']);

function flagOn(deps: SubcommandDeps, name: string): boolean {
  const value = deps.flags?.[name];
  return value === true || value === 'true' || value === '1';
}

export async function hqVaultCmd(
  sub: string,
  args: string[],
  deps: SubcommandDeps,
): Promise<number> {
  const service = createHqCredentialService(
    {
      vault: deps.vault,
      profileConfigPath: activeProfileConfigPath(deps.paths, deps.config),
      modelsRegistry: deps.modelsRegistry,
    },
    deps.paths.globalRoot,
  );
  try {
    if (sub === 'enroll') {
      const [url, token] = args;
      if (!url || !token) {
        deps.renderer.writeError(
          'Usage: wstack hq enroll <hq-url> <enrollment-token> [--label <name>] [--replace]\n' +
            'Get both from HQ → System → Keys → "Enroll a device".\n',
        );
        return 1;
      }
      const label = typeof deps.flags?.['label'] === 'string' ? deps.flags['label'] : undefined;
      const { device, fingerprint } = await service.enroll(url, token, {
        label,
        replace: flagOn(deps, 'replace'),
      });
      deps.renderer.write(
        `${color.green('✓')} Enrolled with ${device.hqUrl}\n` +
          `  HQ fingerprint:  ${device.hq.fingerprint}\n` +
          `  This device:     ${fingerprint}\n` +
          `  Compare both with HQ → System → Keys.\n`,
      );
      deps.renderer.write(
        device.status === 'approved'
          ? 'Next: `wstack hq sync` imports the keys HQ grants this device.\n'
          : 'HQ has to approve this device first (System → Keys → Devices). Then run `wstack hq sync`.\n',
      );
      return 0;
    }

    if (sub === 'device') {
      const device = await service.device();
      if (!device) {
        deps.renderer.write('Not enrolled with an HQ key vault. See `wstack hq enroll`.\n');
        return 0;
      }
      deps.renderer.write(
        `HQ:              ${device.hqUrl}\n` +
          `HQ fingerprint:  ${device.hq.fingerprint}\n` +
          `This device:     ${hqDeviceFingerprint(device)} (${device.deviceId.slice(0, 12)})\n` +
          `Enrolled:        ${device.enrolledAt}\n`,
      );
      try {
        const items = await service.list();
        deps.renderer.write(
          items.length === 0
            ? 'Granted keys:    none yet\n'
            : `Granted keys:\n${items
                .map(
                  (i) =>
                    `  ${i.providerId}/${i.label} v${i.version} (${i.policy}${i.setActive ? ', active' : ''})`,
                )
                .join('\n')}\n`,
        );
      } catch (error) {
        deps.renderer.write(`Granted keys:    unavailable — ${(error as Error).message}\n`);
      }
      return 0;
    }

    if (sub === 'sync') {
      const report = await service.sync();
      for (const line of formatHqImportReport(report)) deps.renderer.write(`${line}\n`);
      return 0;
    }

    if (sub === 'unenroll') {
      const removeKeys = flagOn(deps, 'remove-keys');
      const { removed } = await service.unenroll({ removeKeys });
      deps.renderer.write(
        `${color.green('✓')} This machine no longer holds an HQ key-vault identity.\n` +
          (removeKeys
            ? `Removed ${removed.length} imported key${removed.length === 1 ? '' : 's'}.\n`
            : 'Keys imported from HQ were kept; pass --remove-keys to delete them too. Revoke the device in HQ as well.\n'),
      );
      return 0;
    }
  } catch (error) {
    deps.renderer.writeError(`${(error as Error).message}\n`);
    return 1;
  }
  deps.renderer.writeError(`Unknown hq subcommand: ${sub}\n`);
  return 1;
}
