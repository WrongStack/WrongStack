import type { AuthenticatedGovernanceProjectService } from './authenticated-project-service.js';
import type { GovernanceServiceCredential } from './capability-grant.js';
import type { GovernanceObservationCategory, StoredGovernanceObservation } from './event-store.js';
import {
  GOVERNANCE_SERVICE_PROTOCOL_VERSION,
  type GovernanceServiceResponse,
} from './project-service.js';

interface LegacyRuntimeObservation {
  readonly observationId: string;
  readonly taskId?: string | undefined;
  readonly category: GovernanceObservationCategory;
  readonly observedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

type LegacyShadowObservationResult =
  | {
      readonly observed: true;
      readonly idempotentReplay: boolean;
      readonly observation: StoredGovernanceObservation;
    }
  | {
      readonly observed: false;
      readonly code: string;
      readonly message: string;
    };

/**
 * Observe-only compatibility adapter. It can append shadow observations but has no command capability
 * and therefore cannot create tasks, transition canonical state, or block the legacy runtime.
 */
export class LegacyGovernanceShadowAdapter {
  private requestSequence = 0;

  constructor(
    private readonly service: AuthenticatedGovernanceProjectService,
    private readonly source: string,
    private readonly credential: GovernanceServiceCredential,
  ) {
    if (credential.clientId !== source) {
      throw new Error('Legacy shadow source must match the authenticated client identity.');
    }
  }

  observe(observation: LegacyRuntimeObservation): LegacyShadowObservationResult {
    this.requestSequence += 1;
    const response = this.service.handleUnknown(
      {
        protocolVersion: GOVERNANCE_SERVICE_PROTOCOL_VERSION,
        requestId: `shadow:${this.source}:${this.requestSequence}`,
        type: 'record_observation',
        observation: {
          observationId: observation.observationId,
          projectId: this.service.projectId,
          taskId: observation.taskId ?? null,
          source: this.source,
          category: observation.category,
          observedAt: observation.observedAt,
          payload: observation.payload,
        },
      },
      this.credential,
    );
    return this.toResult(response);
  }

  private toResult(response: GovernanceServiceResponse): LegacyShadowObservationResult {
    if (!response.ok) {
      return { observed: false, code: response.error.code, message: response.error.message };
    }
    if (response.result.type !== 'observation_result') {
      return {
        observed: false,
        code: 'unexpected_response',
        message: `Expected observation_result, received ${response.result.type}.`,
      };
    }
    if (!response.result.result.handled) {
      return {
        observed: false,
        code: response.result.result.code,
        message: response.result.result.message,
      };
    }
    return {
      observed: true,
      idempotentReplay: response.result.result.idempotentReplay,
      observation: response.result.result.observation,
    };
  }
}
