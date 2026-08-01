import type {
  BootstrapGovernanceRuntimeOptions,
  GovernanceRuntimeBootstrapHandle,
  GovernanceRuntimeBootstrapResult,
} from '@wrongstack/runtime/governance-bootstrap';

export const WRONGSTACK_GOVERNANCE_ENV = 'WRONGSTACK_GOVERNANCE';

export interface BootstrapCliGovernanceOptions extends BootstrapGovernanceRuntimeOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export type CliGovernanceBootstrapResult =
  | { readonly mode: 'disabled'; readonly reason: 'feature_flag_off' }
  | GovernanceRuntimeBootstrapResult
  | {
      readonly mode: 'legacy';
      readonly code: 'module_unavailable';
      readonly phase: 'bootstrap';
      readonly message: string;
      readonly cleanup: 'not_required';
    };

interface GovernanceBootstrapModule {
  bootstrapGovernanceRuntime(
    options: BootstrapGovernanceRuntimeOptions,
  ): Promise<GovernanceRuntimeBootstrapResult>;
}

interface BootstrapCliGovernanceDependencies {
  readonly load: () => Promise<GovernanceBootstrapModule>;
}

const DEFAULT_DEPENDENCIES: BootstrapCliGovernanceDependencies = {
  load: () => import('@wrongstack/runtime/governance-bootstrap'),
};

function sanitize(message: string): string {
  return message.replace(/wsg_\S{1,700}/gu, '[credential]').slice(0, 512);
}

export function governanceRuntimeEnabled(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return environment[WRONGSTACK_GOVERNANCE_ENV]?.trim() === '1';
}

export function governedHandle(
  result: CliGovernanceBootstrapResult,
): GovernanceRuntimeBootstrapHandle | undefined {
  return result.mode === 'governed' ? result.handle : undefined;
}

export async function bootstrapCliGovernance(
  options: BootstrapCliGovernanceOptions,
  dependencies: BootstrapCliGovernanceDependencies = DEFAULT_DEPENDENCIES,
): Promise<CliGovernanceBootstrapResult> {
  if (!governanceRuntimeEnabled(options.environment)) {
    return Object.freeze({ mode: 'disabled', reason: 'feature_flag_off' });
  }
  let loaded: GovernanceBootstrapModule;
  try {
    loaded = await dependencies.load();
  } catch (error) {
    return Object.freeze({
      mode: 'legacy',
      code: 'module_unavailable',
      phase: 'bootstrap',
      message: sanitize(error instanceof Error ? error.message : String(error)),
      cleanup: 'not_required',
    });
  }
  try {
    return await loaded.bootstrapGovernanceRuntime({
      projectRoot: options.projectRoot,
      projectId: options.projectId,
      adminClientId: options.adminClientId,
      modelClientId: options.modelClientId,
      modelCapabilities: options.modelCapabilities,
      ...(options.adminTtlMs === undefined ? {} : { adminTtlMs: options.adminTtlMs }),
      ...(options.modelTtlMs === undefined ? {} : { modelTtlMs: options.modelTtlMs }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.existingAdmin === undefined ? {} : { existingAdmin: options.existingAdmin }),
    });
  } catch (error) {
    return Object.freeze({
      mode: 'legacy',
      code: 'bootstrap_failed',
      phase: 'bootstrap',
      message: sanitize(error instanceof Error ? error.message : String(error)),
      cleanup: 'unavailable',
    });
  }
}
