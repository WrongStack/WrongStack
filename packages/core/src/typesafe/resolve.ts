/**
 * One place that turns `config.typesafe` + the environment into an account.
 *
 * Every TypeSafe-backed feature resolves its transport through here, so "which
 * host does this go to, and where did the key come from" has a single answer
 * and cannot drift between subsystems.
 *
 * ## Why three states rather than a client or an error
 *
 * "No account" and "an account was asked for and is unusable" are not the same
 * situation, and collapsing them is what made the earlier version quietly
 * wrong. A user who never configured TypeSafe must hear NOTHING — they did not
 * ask for this and a warning would be noise on every boot. A user who set
 * `skills.suggest.enabled: true` and has no key asked for something that is not
 * happening, and silence there is a bug report waiting to be filed.
 *
 * The caller decides which of those it is, because only the caller knows
 * whether its own feature switch is on. This module reports the facts.
 *
 * ## What it does not do
 *
 * The master opt-in gates all clients, including diagnostics. It does not
 * otherwise decide whether a feature runs, and it does not define what
 * running without TypeSafe looks like. Each consumer keeps its own `enabled`
 * switch and its own degraded path — the dispatch classifier falls back to the
 * prose classifier, the skill suggester emits no block at all. There is
 * deliberately no shared `isTypeSafeAvailable()` helper: the answer to "what
 * happens without it" differs per consumer, so a shared `if` would be a lie
 * with two call sites.
 */

import type { Config } from '@wrongstack/contracts/types/config/root';
import type { TypeSafeConfig } from '@wrongstack/contracts/types/config/typesafe';
import { observeJevClient } from './activity.js';
import { createTypeSafeBreaker, type TypeSafeBreaker, TypeSafeDisabledError } from './breaker.js';
import { createTypeSafeClient, type TypeSafeUsage } from './client.js';
import { typeSafeAllowed, typeSafePolicySignal } from './policy.js';
import { sharedTypeSafeRestGate, type TypeSafeRestGate, withTypeSafeRest } from './rest.js';
import { isTypeSafeRoute, TYPESAFE_ROUTES, type TypeSafeRoute } from './route.js';

/**
 * Environment variable read when `typesafe.apiKey` is unset.
 *
 * Kept exported under its historical name: it is the native route's variable
 * and the one every existing doc, error message and CI setup names. The
 * OpenRouter route's variable lives in the route table.
 */
export const TYPESAFE_API_KEY_ENV = TYPESAFE_ROUTES.typesafe.env;

/** Where the credential came from, for status output and doctor findings. */
export type TypeSafeKeySource = 'config' | 'env';

export interface ResolveTypeSafeClientDeps {
  config: Pick<Config, 'typesafe'>;
  /** Injected for tests; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** Per-attempt timeout override, when a caller has a tighter budget. */
  timeoutMs?: number | undefined;
  /** Accounting sink, called once per successful request. */
  onUsage?: ((usage: TypeSafeUsage) => void) | undefined;
  /** Called once if the breaker opens on a revoked credential. */
  onDisabled?: ((reason: string) => void) | undefined;
  /**
   * Called each time the host is put to rest after transient failures
   * (429/5xx/timeouts). Rests end on their own; this is informational.
   */
  onRest?: ((reason: string) => void) | undefined;
  /**
   * Transient-failure gate. Defaults to the process-wide gate shared by every
   * client of the same endpoint + credential; `null` disables resting (tests,
   * and the `wstack typesafe test` probe, which must always hit the network).
   */
  restGate?: TypeSafeRestGate | null | undefined;
}

/** An account that can answer questions. */
export interface TypeSafeAccountReady {
  status: 'ready';
  client: TypeSafeBreaker;
  route: TypeSafeRoute;
  /** The endpoint requests will actually go to. */
  endpoint: string;
  /** The model id that will be sent when a caller does not override it. */
  model: string;
  keySource: TypeSafeKeySource;
  /** Env var the key came from, when `keySource` is `env`. */
  keyEnv: string | undefined;
  /** The transient-failure gate in front of `client`, when one is installed. */
  rest: TypeSafeRestGate | undefined;
}

/** No credential anywhere. The user configured nothing; say nothing. */
export interface TypeSafeAccountUnconfigured {
  status: 'unconfigured';
  reason: string;
}

export interface TypeSafeAccountDisabled {
  status: 'disabled';
  reason: string;
}

/** A credential or endpoint exists but cannot be used as written. */
export interface TypeSafeAccountUnusable {
  status: 'unusable';
  reason: string;
}

export type TypeSafeAccount =
  | TypeSafeAccountReady
  | TypeSafeAccountDisabled
  | TypeSafeAccountUnconfigured
  | TypeSafeAccountUnusable;

/**
 * Pick the route this config asks for, without needing a key to do it.
 *
 * Exported because `wstack typesafe status` and the doctor both have to
 * describe the route a config WOULD use, including when no credential is
 * present yet.
 */
export function resolveTypeSafeRoute(
  config: Pick<Config, 'typesafe'>,
  _env: NodeJS.ProcessEnv,
): TypeSafeRoute {
  const account = config.typesafe ?? {};
  if (account.route) return account.route;
  // An explicit endpoint is a self-hosted or proxied deployment. Applying a
  // route's default model to it would send `~typesafe/jev-latest` to a host
  // that has never heard of OpenRouter's naming.
  if (account.endpoint?.trim()) return 'custom';
  if (account.apiKey?.trim()) return 'typesafe';
  // Only TypeSafe's OWN variable is ever inferred from the environment.
  // `OPENROUTER_API_KEY` is overwhelmingly there for chat; inferring the
  // OpenRouter route from it sent the user's prompts to a host they never
  // chose for this feature and billed a key they set up for something else.
  // OpenRouter is one explicit line away: `typesafe.route: "openrouter"`.
  return 'typesafe';
}

/**
 * Resolve the account, reporting which of the three situations this is.
 *
 * The key is looked up in this order:
 *   1. `typesafe.apiKey` — the normal place, vault-encrypted on disk.
 *   2. The selected route's environment variable.
 *
 * A `custom` route has no environment variable of its own and falls back to
 * the native one, because a proxy in front of TypeSafe is still a TypeSafe
 * credential.
 */
export function resolveTypeSafeAccount(deps: ResolveTypeSafeClientDeps): TypeSafeAccount {
  const account = deps.config.typesafe ?? {};
  if (!typeSafeAllowed(deps.config)) {
    return {
      status: 'disabled',
      reason: 'Jev is disabled. Enable it with /jev on or Settings → Jev.',
    };
  }
  const env = deps.env ?? process.env;
  if (account.route !== undefined && !isTypeSafeRoute(account.route)) {
    return { status: 'unusable', reason: 'typesafe.route must be typesafe, openrouter or custom' };
  }
  const route = resolveTypeSafeRoute(deps.config, env);

  const spec = route === 'custom' ? undefined : TYPESAFE_ROUTES[route];
  const endpoint = (account.endpoint?.trim() || spec?.url) ?? '';
  if (!endpoint) {
    return {
      status: 'unusable',
      reason: 'typesafe.route is "custom" but typesafe.endpoint is not set',
    };
  }
  try {
    const url = new URL(endpoint);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('invalid endpoint');
    }
  } catch {
    return {
      status: 'unusable',
      reason: 'typesafe.endpoint must be an HTTP(S) URL without embedded credentials or a fragment',
    };
  }

  const keyEnv = spec?.env ?? TYPESAFE_ROUTES.typesafe.env;
  const configured = account.apiKey?.trim();
  const fromEnv = env[keyEnv]?.trim();
  const apiKey = configured || fromEnv || '';
  if (!apiKey) {
    return {
      status: 'unconfigured',
      reason: `no TypeSafe API key — set ${keyEnv} or typesafe.apiKey`,
    };
  }

  const model = account.model?.trim() || spec?.model || TYPESAFE_ROUTES.typesafe.model;
  const transport = createTypeSafeClient({
    apiKey,
    endpoint,
    model,
    timeoutMs: deps.timeoutMs ?? account.requestTimeoutMs,
    onUsage: deps.onUsage,
  });
  // Rest sits INSIDE the auth breaker: a resting gate throws its own error
  // type, which the breaker passes through without counting, so load can
  // never be mistaken for a revoked key.
  const rest =
    deps.restGate === null
      ? undefined
      : (deps.restGate ?? sharedTypeSafeRestGate(endpoint, apiKey));
  const client = createTypeSafeBreaker({
    client: {
      systemOne(req, signal) {
        const feature =
          req.activityPurpose === 'self-test'
            ? undefined
            : req.activityFeature?.startsWith('plugin:')
              ? 'tool'
              : req.activityFeature;
        if (!typeSafeAllowed(deps.config, feature))
          throw new TypeSafeDisabledError('Jev is disabled by settings.');
        const policySignal = typeSafePolicySignal(deps.config);
        const requestSignal =
          policySignal && signal
            ? AbortSignal.any([policySignal, signal])
            : (policySignal ?? signal);
        return (rest ? withTypeSafeRest(transport, rest, deps.onRest) : transport).systemOne(
          req,
          requestSignal,
        );
      },
    },
    threshold: account.authFailureLimit,
    label: spec?.label ?? 'TypeSafe',
    onOpen: deps.onDisabled,
  });

  return {
    status: 'ready',
    client: observeJevClient(client, route, model, {
      logContent: logContentWanted(account, env),
      // The key never leaves the process in a body, but a `state` blob built
      // from arbitrary text can still carry one into a debug log.
      secrets: [apiKey],
    }),
    route,
    endpoint,
    model,
    keySource: configured ? 'config' : 'env',
    keyEnv: configured ? undefined : keyEnv,
    rest,
  };
}

/**
 * Whether this process should write full Jev request/response records.
 *
 * The profile setting is the durable answer; the environment variable exists
 * for the "record the next hour while I chase this" case, where editing the
 * profile and restarting every consumer is more than a debugging step should
 * cost. Setting either to a falsy value wins over the other's truthy value, so
 * `logContent: false` in the profile still wins.
 */
export function logContentWanted(account: TypeSafeConfig, env: NodeJS.ProcessEnv): boolean {
  const override = env['WRONGSTACK_JEV_LOG_CONTENT']?.trim();
  if (override !== undefined) return /^(1|true|yes|on)$/i.test(override);
  return account.logContent === true;
}

/**
 * Build a client, or say why one could not be built.
 *
 * Retained as the narrow view for callers that only branch two ways. New code
 * should prefer {@link resolveTypeSafeAccount}, which can tell "nothing was
 * configured" from "what was configured does not work" — the distinction that
 * decides whether a host stays silent or says something once.
 */
export function resolveTypeSafeClient(
  deps: ResolveTypeSafeClientDeps,
): { client: TypeSafeBreaker } | { error: string } {
  const account = resolveTypeSafeAccount(deps);
  return account.status === 'ready' ? { client: account.client } : { error: account.reason };
}

/** The configured model id, for callers that pass it per request. */
export function typeSafeModel(config: Pick<Config, 'typesafe'>): string | undefined {
  return config.typesafe?.model;
}
