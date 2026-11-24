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
      ...rest,
      mutateProviders: (mutator) => mutateConfigProviders(profileConfigPath, deps.vault, mutator),
    });
  }
}
