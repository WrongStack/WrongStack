import { randomUUID } from 'node:crypto';
import type {
  ExistingGovernanceAdminCredential,
  GovernanceCompatibilityCleanup,
  GovernanceCompatibilityFallback,
  GovernanceCompatibilityFallbackCode,
  GovernanceCompatibilityRuntime,
  GovernanceCompatibilityRuntimeSnapshot,
  GovernanceModelCapability,
  GovernanceModelSession,
  GovernanceObservationCategory,
  PrepareGovernanceCompatibilityOptions,
  PrepareGovernanceCompatibilityResult,
} from '@wrongstack/governance';
import {
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  prepareGovernanceCompatibilityRuntime,
} from '@wrongstack/governance';
import { sanitizeGovernanceMessage } from './governance-sanitize.js';

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

export interface GovernanceRuntimeObservationInput {
  readonly taskId: string | null;
  readonly source: string;
  readonly category: GovernanceObservationCategory;
  readonly observedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type GovernanceRuntimeObservationResult =
  | {
      readonly recorded: true;
      readonly observationId: string;
      readonly idempotentReplay: boolean;
      readonly sequence: number;
    }
  | {
      readonly recorded: false;
      readonly observationId?: string | undefined;
      readonly code:
        | 'backpressure'
        | 'closed'
        | 'request_failed'
        | 'request_rejected'
        | 'unexpected_response';
      readonly message: string;
    };

export const MAX_PENDING_GOVERNANCE_OBSERVATIONS = 256;

const GOVERNANCE_RUNTIME_BOOTSTRAP_HANDLE_CONSTRUCTION = Symbol(
  'governance-runtime-bootstrap-handle-construction',
);

export class GovernanceRuntimeBootstrapHandle {
  readonly model: GovernanceModelSession;
  readonly #runtime: GovernanceCompatibilityRuntime;
  readonly #snapshot: GovernanceRuntimeBootstrapSnapshot;
  readonly #pendingObservations = new Set<Promise<GovernanceRuntimeObservationResult>>();
  #acceptingObservations = true;
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

  observe(input: GovernanceRuntimeObservationInput): Promise<GovernanceRuntimeObservationResult> {
    if (!this.#acceptingObservations) {
      return Promise.resolve(
        Object.freeze({
          recorded: false,
          code: 'closed',
          message: 'Governance runtime is closing and no longer accepts observations.',
        }),
      );
    }
    if (this.#pendingObservations.size >= MAX_PENDING_GOVERNANCE_OBSERVATIONS) {
      return Promise.resolve(
        Object.freeze({
          recorded: false,
          code: 'backpressure',
          message: 'Governance observation queue reached its bounded capacity.',
        }),
      );
    }
    const pending = this.recordObservation(input);
    this.#pendingObservations.add(pending);
    void pending.finally(() => this.#pendingObservations.delete(pending));
    return pending;
  }

  close(): Promise<GovernanceRuntimeBootstrapCloseResult> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.closeOnce();
    return this.#closePromise;
  }

  private async closeOnce(): Promise<GovernanceRuntimeBootstrapCloseResult> {
    this.#acceptingObservations = false;
    await Promise.allSettled([...this.#pendingObservations]);
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
          message: sanitizeGovernanceMessage(response.error.message),
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
        message: sanitizeGovernanceMessage(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  private async recordObservation(
    input: GovernanceRuntimeObservationInput,
  ): Promise<GovernanceRuntimeObservationResult> {
    const observationId = randomUUID();
    try {
      const response = await this.model.request({
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: `observe-${observationId}`,
        type: 'record_observation',
        observation: {
          observationId,
          projectId: this.#snapshot.model.projectId,
          taskId: input.taskId,
          source: input.source,
          category: input.category,
          observedAt: input.observedAt,
          payload: input.payload,
        },
      });
      if (!response.ok) {
        return Object.freeze({
          recorded: false,
          observationId,
          code: 'request_rejected',
          message: sanitizeGovernanceMessage(response.error.message),
        });
      }
      if (response.result.type !== 'observation_result') {
        return Object.freeze({
          recorded: false,
          observationId,
          code: 'unexpected_response',
          message: 'Governance observation returned an unexpected response.',
        });
      }
      if (!response.result.result.handled) {
        return Object.freeze({
          recorded: false,
          observationId,
          code: 'request_rejected',
          message: sanitizeGovernanceMessage(response.result.result.message),
        });
      }
      return Object.freeze({
        recorded: true,
        observationId,
        idempotentReplay: response.result.result.idempotentReplay,
        sequence: response.result.result.observation.sequence,
      });
    } catch (error) {
      return Object.freeze({
        recorded: false,
        observationId,
        code: 'request_failed',
        message: sanitizeGovernanceMessage(error instanceof Error ? error.message : String(error)),
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
      message: sanitizeGovernanceMessage(error instanceof Error ? error.message : String(error)),
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
