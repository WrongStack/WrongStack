import type {
  ExistingGovernanceAdminCredential,
  GovernanceCompatibilityCleanup,
  GovernanceCompatibilityFallback,
  GovernanceCompatibilityFallbackCode,
  GovernanceCompatibilityRuntime,
  GovernanceCompatibilityRuntimeSnapshot,
  GovernanceModelCapability,
  GovernanceModelSession,
  PrepareGovernanceCompatibilityOptions,
  PrepareGovernanceCompatibilityResult,
} from '@wrongstack/governance';
import { prepareGovernanceCompatibilityRuntime } from '@wrongstack/governance';

export interface BootstrapGovernanceRuntimeOptions {
  readonly projectRoot: string;
  readonly projectId: string;
  readonly adminClientId: string;
  readonly modelClientId: string;
  readonly modelCapabilities: readonly GovernanceModelCapability[];
  readonly adminTtlMs?: number | undefined;
  readonly modelTtlMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly existingAdmin?: ExistingGovernanceAdminCredential | undefined;
}

export interface GovernanceRuntimeBootstrapSnapshot {
  readonly mode: 'governed';
  readonly source: 'attached' | 'launched';
  readonly daemon: GovernanceCompatibilityRuntimeSnapshot['admin']['daemon'];
  readonly model: GovernanceCompatibilityRuntimeSnapshot['model'];
}

export interface GovernanceRuntimeBootstrapCloseResult {
  readonly ok: boolean;
  readonly action: 'detach' | 'shutdown';
  readonly message: string;
}

const GOVERNANCE_RUNTIME_BOOTSTRAP_HANDLE_CONSTRUCTION = Symbol(
  'governance-runtime-bootstrap-handle-construction',
);

export class GovernanceRuntimeBootstrapHandle {
  readonly model: GovernanceModelSession;
  readonly #runtime: GovernanceCompatibilityRuntime;
  readonly #snapshot: GovernanceRuntimeBootstrapSnapshot;
  #closePromise: Promise<GovernanceRuntimeBootstrapCloseResult> | undefined;

  constructor(
    construction: typeof GOVERNANCE_RUNTIME_BOOTSTRAP_HANDLE_CONSTRUCTION,
    runtime: GovernanceCompatibilityRuntime,
  ) {
    if (construction !== GOVERNANCE_RUNTIME_BOOTSTRAP_HANDLE_CONSTRUCTION) {
      throw new Error('Governance runtime handles must be created through the bootstrap adapter.');
    }
    this.#runtime = runtime;
    this.model = runtime.model;
    const snapshot = runtime.snapshot();
    this.#snapshot = Object.freeze({
      mode: 'governed',
      source: snapshot.source,
      daemon: snapshot.admin.daemon,
      model: snapshot.model,
    });
  }

  snapshot(): GovernanceRuntimeBootstrapSnapshot {
    return this.#snapshot;
  }

  close(): Promise<GovernanceRuntimeBootstrapCloseResult> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.closeOnce();
    return this.#closePromise;
  }

  private async closeOnce(): Promise<GovernanceRuntimeBootstrapCloseResult> {
    const action = this.#snapshot.source === 'launched' ? 'shutdown' : 'detach';
    try {
      const response =
        action === 'shutdown'
          ? await this.#runtime.shutdownDaemon('WrongStack runtime session ended')
          : await this.#runtime.close();
      if (response === null) {
        return Object.freeze({ ok: true, action, message: 'Governance runtime already closed.' });
      }
      if (!response.ok) {
        return Object.freeze({
          ok: false,
          action,
          message: sanitize(response.error.message),
        });
      }
      const expectedType =
        action === 'shutdown' ? 'daemon_shutdown_accepted' : 'capability_grant_revoked';
      return Object.freeze({
        ok: response.result.type === expectedType,
        action,
        message:
          response.result.type === expectedType
            ? `Governance runtime ${action} completed.`
            : `Governance runtime ${action} returned an unexpected response.`,
      });
    } catch (error) {
      return Object.freeze({
        ok: false,
        action,
        message: sanitize(error instanceof Error ? error.message : String(error)),
      });
    }
  }
}

export type GovernanceRuntimeBootstrapResult =
  | { readonly mode: 'governed'; readonly handle: GovernanceRuntimeBootstrapHandle }
  | {
      readonly mode: 'legacy';
      readonly code: 'bootstrap_failed' | GovernanceCompatibilityFallbackCode;
      readonly phase: 'bootstrap' | GovernanceCompatibilityFallback['phase'];
      readonly message: string;
      readonly cleanup: GovernanceCompatibilityCleanup;
    };

type GovernanceCompatibilityFactory = (
  options: PrepareGovernanceCompatibilityOptions,
) => Promise<PrepareGovernanceCompatibilityResult>;

function sanitize(message: string): string {
  return message.replace(/wsg_\S{1,700}/gu, '[credential]').slice(0, 512);
}

export function bootstrapGovernanceRuntime(
  options: BootstrapGovernanceRuntimeOptions,
): Promise<GovernanceRuntimeBootstrapResult> {
  return bootstrapGovernanceRuntimeWithFactory(options, prepareGovernanceCompatibilityRuntime);
}

/** Internal source-test seam. Package consumers use bootstrapGovernanceRuntime. */
export async function bootstrapGovernanceRuntimeWithFactory(
  options: BootstrapGovernanceRuntimeOptions,
  prepare: GovernanceCompatibilityFactory,
): Promise<GovernanceRuntimeBootstrapResult> {
  let prepared: PrepareGovernanceCompatibilityResult;
  try {
    prepared = await prepare(options);
  } catch (error) {
    return Object.freeze({
      mode: 'legacy',
      code: 'bootstrap_failed',
      phase: 'bootstrap',
      message: sanitize(error instanceof Error ? error.message : String(error)),
      cleanup: 'unavailable',
    });
  }
  if (prepared.mode === 'legacy') return prepared;
  return Object.freeze({
    mode: 'governed',
    handle: new GovernanceRuntimeBootstrapHandle(
      GOVERNANCE_RUNTIME_BOOTSTRAP_HANDLE_CONSTRUCTION,
      prepared.runtime,
    ),
  });
}
