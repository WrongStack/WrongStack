import type { ProviderConfig } from '@wrongstack/contracts/types';

/** A pointer to an existing profile credential. No credential values are persisted here. */
export interface CredentialReference {
  profile: string;
  provider: string;
  keyLabel: string;
  envName: string;
}
export interface ResolvedCredentialBundle {
  env: Readonly<Record<string, string>>;
  providers: Readonly<Record<string, ProviderConfig>>;
}
export function isCredentialEnvName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !/^(?:HOME|PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|SHELL|ENV|BASH_ENV|NODE_.*|LD_.*|DOCKER_.*|GIT_CONFIG_.*|GIT_SSH.*|WRONGSTACK_HOME|__proto__|constructor|prototype)$/i.test(
      name,
    )
  );
}
