/**
 * HqCredentialService for the CLI: the device client from `@wrongstack/hq`
 * (`vault/device-service.ts`, shared with the WebUI hosts) writing through the
 * CLI's locked config writer, `mutateConfigProviders`.
 */
import type { SecretVault } from '@wrongstack/contracts/types/secret-vault';
import {
  HqCredentialService as HqDeviceService,
  type HqCredentialServiceDeps as HqDeviceServiceDeps,
} from '@wrongstack/hq';
import { setLeasedCredentials } from '@wrongstack/providers';
import { mutateConfigProviders } from '../provider-config-utils.js';

export {
  HQ_REQUEST_TIMEOUT_MS,
  type HqImportChange,
  type HqImportReport,
  HqVaultClientRequestError,
  normalizeHqOrigin,
} from '@wrongstack/hq';

export interface HqCredentialServiceDeps extends Omit<HqDeviceServiceDeps, 'mutateProviders'> {
  vault: SecretVault;
  profileConfigPath: string;
}

export class HqCredentialService extends HqDeviceService {
  constructor(deps: HqCredentialServiceDeps) {
    const { profileConfigPath, ...rest } = deps;
    super({
      // Memory-only (lease) values go to this process's lease store.
      onLeases: (hqId, leases, scope) => setLeasedCredentials(hqId, leases, scope),
      ...rest,
      mutateProviders: (mutator) => mutateConfigProviders(profileConfigPath, deps.vault, mutator),
    });
  }
}
