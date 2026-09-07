/**
 * Neutral authorization contract for privileged actions initiated by any host
 * surface. Executors remain surface-specific; this module owns only the
 * decision request/result vocabulary and its untrusted-input decoder.
 */

export const TRUST_BOUNDARY_VERSION = 1 as const;

export type TrustSurface =
  | 'acp'
  | 'webui'
  | 'hq'
  | 'desktop'
  | 'cli'
  | 'tui'
  | 'plugin'
  | 'internal';

export type TrustActorKind = 'user' | 'agent' | 'subagent' | 'plugin' | 'remote-client' | 'system';
export type TrustRisk = 'low' | 'elevated' | 'high' | 'critical';
export type TrustAuthMethod =
  | 'interactive'
  | 'session'
  | 'bearer-token'
  | 'scoped-token'
  | 'local-process';
export type TrustAttribute = string | number | boolean | null;

export interface TrustActor {
  readonly kind: TrustActorKind;
  readonly id?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface TrustSubject {
  readonly kind: 'path' | 'command' | 'process' | 'resource' | 'role' | 'url' | 'custom';
  readonly id: string;
  readonly attributes?: Readonly<Record<string, TrustAttribute>> | undefined;
}

export interface TrustScope {
  readonly projectId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly cwd?: string | undefined;
  readonly constraints?: Readonly<Record<string, TrustAttribute>> | undefined;
}

export interface TrustAuthContext {
  readonly method: TrustAuthMethod;
  readonly principalId?: string | undefined;
  readonly tokenId?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly claims?: Readonly<Record<string, TrustAttribute>> | undefined;
}

export interface TrustBoundaryRequest {
  readonly version: typeof TRUST_BOUNDARY_VERSION;
  readonly requestId: string;
  readonly actor: TrustActor;
  readonly surface: TrustSurface;
  /** Namespaced semantic action, for example `filesystem.write` or `hq.control`. */
  readonly capability: string;
  readonly subject: TrustSubject;
  readonly risk: TrustRisk;
  readonly scope: TrustScope;
  readonly authContext?: TrustAuthContext | undefined;
  readonly metadata?: Readonly<Record<string, TrustAttribute>> | undefined;
}

export interface TrustAllowDecision {
  readonly kind: 'allow';
  readonly reason: string;
  readonly policyId?: string | undefined;
}

export interface TrustDenyDecision {
  readonly kind: 'deny';
  readonly reason: string;
  readonly policyId?: string | undefined;
}

export interface TrustConfirmDecision {
  readonly kind: 'confirm';
  readonly reason: string;
  readonly prompt: string;
  readonly policyId?: string | undefined;
}

export interface TrustScopedTokenDecision {
  readonly kind: 'scoped-token';
  readonly reason: string;
  readonly token: string;
  readonly tokenId: string;
  readonly expiresAt: string;
  readonly capabilities: readonly string[];
  readonly scope: TrustScope;
  readonly policyId?: string | undefined;
}

export type TrustBoundaryDecision =
  | TrustAllowDecision
  | TrustDenyDecision
  | TrustConfirmDecision
  | TrustScopedTokenDecision;

export interface TrustBoundary {
  evaluate(request: TrustBoundaryRequest): Promise<TrustBoundaryDecision>;
}

export interface TrustBoundaryAuditEntry {
  readonly request: TrustBoundaryRequest;
  readonly decision: TrustBoundaryDecision;
  readonly evaluatedAt: string;
}

export interface CompatibilityTrustBoundaryOptions {
  readonly policyId?: string | undefined;
  readonly audit?: ((entry: TrustBoundaryAuditEntry) => void | Promise<void>) | undefined;
  /**
   * When {@code true} (the default), the compatibility boundary denies
   * `critical` risk actions whose actor is `remote-client`. This closes
   * the trust gap where any WebSocket client that can reach the server
   * could shut down the host or kill all tracked processes, even though
   * the boundary is supposed to be a "trusted host" policy. Hosts that
   * genuinely need the old unconditional-allow behaviour can set this to
   * {@code false}.
   */
  readonly denyCriticalRiskRemoteClient?: boolean | undefined;
  /**
   * E4 (AC-005 / API-003): when true (default), `remote-client` actors
   * are also denied actions at `risk === 'high'` (covering the broad
   * majority of HQ-issued commands), not just `critical`. The single-
   * shape-only mode that ships in the prior audit is preserved for
   * callers that explicitly set this to `false`.
   */
  readonly denyHighRiskRemoteClient?: boolean | undefined;
}

/**
 * Migration policy for trusted hosts that historically executed privileged
 * actions directly. It preserves that behaviour while ensuring every action
 * crosses the shared request/decision contract and can be audited. Hosts can
 * replace it with a stricter policy without changing their executors.
 *
 * By default, `critical` risk requests from `remote-client` actors are
 * denied to prevent unauthenticated or insufficiently trusted WebSocket
 * clients from executing host-wide destructive operations (host shutdown,
 * kill-all processes). Other risk levels (`high`, `elevated`, `low`) and
 * local/user actors are unaffected — this preserves the migration contract
 * for legitimate privileged features like terminal spawning and individual
 * process kills.
 */
export function createCompatibilityTrustBoundary(
  options: CompatibilityTrustBoundaryOptions = {},
): TrustBoundary {
  const denyCriticalRiskRemoteClient = options.denyCriticalRiskRemoteClient ?? true;
  // E4 (AC-005 / API-003): the previous boundary only denied the single
  // shape `remote-client + critical` and returned `allow` for every
  // other request, including `remote-client + high` (which covers the
  // broad majority of HQ-issued commands). Combined with `/api/auth/
  // upgrade` flipping `actor.kind` from `remote-client` to `user`, the
  // boundary was effectively decorative — the only control the
  // architecture advertised had no backstop. The default now denies
  // any `risk >= 'high'` from `remote-client` actors; the option to
  // opt back into the old single-shape behaviour remains for the
  // migration path.
  const denyHighRiskRemoteClient = options.denyHighRiskRemoteClient ?? true;
  return {
    async evaluate(request) {
      const isRemoteClient = request.actor.kind === 'remote-client';
      const riskLevel = request.risk;
      const shouldDeny =
        (denyCriticalRiskRemoteClient && isRemoteClient && riskLevel === 'critical') ||
        (denyHighRiskRemoteClient && isRemoteClient && (riskLevel === 'critical' || riskLevel === 'high'));
      if (shouldDeny) {
        const decision: TrustDenyDecision = {
          kind: 'deny',
          reason: `Compatibility policy denies ${riskLevel} risk actions from remote-client actors`,
          policyId: options.policyId ?? 'trusted-host-compat-v1',
        };
        await options.audit?.({ request, decision, evaluatedAt: new Date().toISOString() });
        return decision;
      }
      const decision: TrustAllowDecision = {
        kind: 'allow',
        reason: 'Trusted host compatibility policy',
        policyId: options.policyId ?? 'trusted-host-compat-v1',
      };
      await options.audit?.({ request, decision, evaluatedAt: new Date().toISOString() });
      return decision;
    },
  };
}

export function isTrustDecisionAllowed(decision: TrustBoundaryDecision): boolean {
  return decision.kind === 'allow' || decision.kind === 'scoped-token';
}

export interface TrustDecodeIssue {
  readonly path: string;
  readonly message: string;
}

export type TrustDecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly TrustDecodeIssue[] };

const SURFACES = new Set<TrustSurface>([
  'acp',
  'webui',
  'hq',
  'desktop',
  'cli',
  'tui',
  'plugin',
  'internal',
]);
const ACTORS = new Set<TrustActorKind>([
  'user',
  'agent',
  'subagent',
  'plugin',
  'remote-client',
  'system',
]);
const RISKS = new Set<TrustRisk>(['low', 'elevated', 'high', 'critical']);
const AUTH_METHODS = new Set<TrustAuthMethod>([
  'interactive',
  'session',
  'bearer-token',
  'scoped-token',
  'local-process',
]);
const SUBJECT_KINDS = new Set<TrustSubject['kind']>([
  'path',
  'command',
  'process',
  'resource',
  'role',
  'url',
  'custom',
]);
const RESERVED_BYPASS_FIELDS = new Set([
  'bypass',
  'force',
  'yolo',
  'skipAuthorization',
  'skip_authorization',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addString(
  issues: TrustDecodeIssue[],
  value: unknown,
  path: string,
  required = true,
): value is string {
  if (typeof value === 'string' && value.trim().length > 0) return true;
  if (!required && value === undefined) return false;
  issues.push({ path, message: 'must be a non-empty string' });
  return false;
}

function addEnum<T extends string>(
  issues: TrustDecodeIssue[],
  value: unknown,
  path: string,
  values: ReadonlySet<T>,
): value is T {
  if (typeof value === 'string' && values.has(value as T)) return true;
  issues.push({ path, message: `must be one of: ${[...values].join(', ')}` });
  return false;
}

function validateAttributes(
  issues: TrustDecodeIssue[],
  value: unknown,
  path: string,
): value is Record<string, TrustAttribute> {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return false;
  }
  let valid = true;
  for (const [key, item] of Object.entries(value)) {
    if (RESERVED_BYPASS_FIELDS.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: 'generic authorization bypass fields are forbidden',
      });
      valid = false;
    } else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) {
      issues.push({
        path: `${path}.${key}`,
        message: 'must be a string, number, boolean, or null',
      });
      valid = false;
    }
  }
  return valid;
}

function validateScope(
  issues: TrustDecodeIssue[],
  value: unknown,
  path: string,
): value is TrustScope {
  if (!isRecord(value)) {
    issues.push({ path, message: 'must be an object' });
    return false;
  }
  for (const field of ['projectId', 'sessionId', 'cwd'] as const) {
    if (value[field] !== undefined) addString(issues, value[field], `${path}.${field}`);
  }
  if (value.constraints !== undefined)
    validateAttributes(issues, value.constraints, `${path}.constraints`);
  return true;
}

export function decodeTrustBoundaryRequest(
  input: unknown,
): TrustDecodeResult<TrustBoundaryRequest> {
  const issues: TrustDecodeIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] };

  for (const field of RESERVED_BYPASS_FIELDS) {
    if (field in input)
      issues.push({
        path: `$.${field}`,
        message: 'generic authorization bypass fields are forbidden',
      });
  }
  if (input.version !== TRUST_BOUNDARY_VERSION)
    issues.push({ path: '$.version', message: `must equal ${TRUST_BOUNDARY_VERSION}` });
  addString(issues, input.requestId, '$.requestId');
  addEnum(issues, input.surface, '$.surface', SURFACES);
  addString(issues, input.capability, '$.capability');
  addEnum(issues, input.risk, '$.risk', RISKS);

  if (!isRecord(input.actor)) issues.push({ path: '$.actor', message: 'must be an object' });
  else {
    addEnum(issues, input.actor.kind, '$.actor.kind', ACTORS);
    if (input.actor.id !== undefined) addString(issues, input.actor.id, '$.actor.id');
    if (input.actor.sessionId !== undefined)
      addString(issues, input.actor.sessionId, '$.actor.sessionId');
  }

  if (!isRecord(input.subject)) issues.push({ path: '$.subject', message: 'must be an object' });
  else {
    addEnum(issues, input.subject.kind, '$.subject.kind', SUBJECT_KINDS);
    addString(issues, input.subject.id, '$.subject.id');
    if (input.subject.attributes !== undefined)
      validateAttributes(issues, input.subject.attributes, '$.subject.attributes');
  }

  validateScope(issues, input.scope, '$.scope');
  if (input.metadata !== undefined) validateAttributes(issues, input.metadata, '$.metadata');
  if (input.authContext !== undefined) {
    if (!isRecord(input.authContext))
      issues.push({ path: '$.authContext', message: 'must be an object' });
    else {
      addEnum(issues, input.authContext.method, '$.authContext.method', AUTH_METHODS);
      for (const field of ['principalId', 'tokenId', 'expiresAt'] as const) {
        if (input.authContext[field] !== undefined)
          addString(issues, input.authContext[field], `$.authContext.${field}`);
      }
      if (input.authContext.claims !== undefined)
        validateAttributes(issues, input.authContext.claims, '$.authContext.claims');
    }
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: input as unknown as TrustBoundaryRequest };
}

export function decodeTrustBoundaryDecision(
  input: unknown,
): TrustDecodeResult<TrustBoundaryDecision> {
  const issues: TrustDecodeIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: '$', message: 'must be an object' }] };
  if (!['allow', 'deny', 'confirm', 'scoped-token'].includes(String(input.kind))) {
    issues.push({ path: '$.kind', message: 'must be one of: allow, deny, confirm, scoped-token' });
  }
  addString(issues, input.reason, '$.reason');
  if (input.policyId !== undefined) addString(issues, input.policyId, '$.policyId');
  if (input.kind === 'confirm') addString(issues, input.prompt, '$.prompt');
  if (input.kind === 'scoped-token') {
    addString(issues, input.token, '$.token');
    addString(issues, input.tokenId, '$.tokenId');
    addString(issues, input.expiresAt, '$.expiresAt');
    if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
      issues.push({ path: '$.capabilities', message: 'must be a non-empty string array' });
    } else {
      for (const [index, capability] of input.capabilities.entries())
        addString(issues, capability, `$.capabilities[${index}]`);
    }
    validateScope(issues, input.scope, '$.scope');
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: input as unknown as TrustBoundaryDecision };
}
