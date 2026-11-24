/**
 * Provider sign-ins run on HQ (ChatGPT, GitHub Copilot, …), so HQ holds the
 * account's refresh token and devices only ever get access tokens.
 *
 * The same engine every client uses (`@wrongstack/providers/oauth`, IO-free),
 * driven like WebUI's sign-in (`webui-server/src/server/provider/oauth.ts`)
 * but addressed by attempt id and polled over HTTP:
 *
 *   start  → { attemptId, interaction }   browser URL or device code
 *   poll   → phase: awaiting_browser | awaiting_code | exchanging | success | error
 *   code   → paste the redirected URL / code (a dashboard on another machine
 *            cannot reach HQ's loopback callback, so this is always offered)
 *   cancel
 *
 * A finished sign-in is stored on the vault profile (created from the outcome
 * when missing) and audited as `oauth.signin`. Attempts live in memory, at most
 * {@link MAX_ATTEMPTS} at once, and expire after {@link ATTEMPT_TTL_MS}.
 */
import { randomBytes } from 'node:crypto';
import type {
  ModelsRegistry,
  ProviderAuthBeginDeps,
  ProviderAuthOutcome,
  ProviderAuthSession,
  ProviderAuthStrategyMetadata,
} from '@wrongstack/contracts/types';
import type { HqVaultProfileMeta, HqVaultRefresher, HqVaultSignInResult } from '@wrongstack/hq';
import {
  createBuiltinProviderAuthRegistry,
  RENEWABLE_SIGN_INS,
  renewStoredOAuthCredential,
} from '@wrongstack/providers/oauth';

const MAX_ATTEMPTS = 4;
const ATTEMPT_TTL_MS = 15 * 60_000;

/** The slice of `ProviderAuthRegistry` HQ uses (a fake in tests). */
export interface HqVaultAuthRegistry {
  list(): ProviderAuthStrategyMetadata[];
  resolveId(idOrAlias: string): string | undefined;
  begin(
    idOrAlias: string,
    deps?: ProviderAuthBeginDeps,
    signal?: AbortSignal,
  ): Promise<ProviderAuthSession>;
}

/**
 * The built-in sign-ins HQ can keep alive: a sign-in whose tokens HQ cannot
 * renew (Antigravity needs a host OAuth client) would hand devices a token that
 * dies within the hour, so it is not offered here.
 */
export function createHqVaultAuthRegistry(): HqVaultAuthRegistry {
  const registry = createBuiltinProviderAuthRegistry();
  return {
    list: () => registry.list().filter((s) => RENEWABLE_SIGN_INS.has(s.id)),
    resolveId: (id) => {
      const resolved = registry.resolveId(id);
      return resolved && RENEWABLE_SIGN_INS.has(resolved) ? resolved : undefined;
    },
    begin: (id, deps, signal) => registry.begin(id, deps, signal),
  };
}

/** HQ's renewal of a stored sign-in, with the account's own refresh token. */
export const hqVaultRefresher: HqVaultRefresher = async ({ key, secrets }) => {
  if (!key.signIn) return undefined;
  const renewed = await renewStoredOAuthCredential(
    {
      label: key.label,
      apiKey: secrets.apiKey,
      createdAt: key.createdAt,
      authMethod: 'oauth',
      ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
      ...(secrets.idToken ? { idToken: secrets.idToken } : {}),
      ...(secrets.tokenType ? { tokenType: secrets.tokenType } : {}),
      ...(secrets.scope ? { scope: secrets.scope } : {}),
      ...(secrets.project ? { project: secrets.project } : {}),
      ...(secrets.oauthClientId ? { oauthClientId: secrets.oauthClientId } : {}),
      ...(secrets.oauthSubject ? { oauthSubject: secrets.oauthSubject } : {}),
      ...(key.oauthStrategyId ? { oauthStrategyId: key.oauthStrategyId } : {}),
      ...(key.accountId ? { accountId: key.accountId } : {}),
      ...(key.expiresAt ? { expiresAt: key.expiresAt } : {}),
    },
    key.signIn,
  );
  if (!renewed) return undefined;
  const secretsOut: Record<string, string> = { apiKey: renewed.apiKey };
  for (const field of [
    'refreshToken',
    'idToken',
    'tokenType',
    'scope',
    'project',
    'oauthClientId',
    'oauthSubject',
  ] as const) {
    const value = renewed[field];
    if (typeof value === 'string' && value !== '') secretsOut[field] = value;
  }
  return {
    secrets: secretsOut as { apiKey: string },
    ...(renewed.expiresAt ? { expiresAt: renewed.expiresAt } : {}),
    ...(renewed.accountId ? { accountId: renewed.accountId } : {}),
  };
};

export type HqVaultSignInPhase =
  | 'awaiting_browser'
  | 'awaiting_code'
  | 'exchanging'
  | 'success'
  | 'error';

export interface HqVaultSignInView {
  attemptId: string;
  strategyId: string;
  providerId: string;
  profileId: string;
  phase: HqVaultSignInPhase;
  authorizeUrl?: string;
  /** False: HQ's loopback callback is not listening; paste the redirected URL. */
  bound?: boolean;
  verificationUri?: string;
  userCode?: string;
  message?: string;
  profile?: HqVaultProfileMeta;
}

type SaveSignIn = (
  input: { profileId?: string | undefined; strategyId: string; result: HqVaultSignInResult },
  actor: string,
) => Promise<HqVaultProfileMeta>;

interface Attempt {
  view: HqVaultSignInView;
  requestedProfileId: string | undefined;
  session: ProviderAuthSession | undefined;
  controller: AbortController;
  createdAt: number;
  settled: boolean;
  /** Completion paths in flight (HQ's own callback, a pasted code). */
  completing: number;
  /** A completion failure, reported only when nothing else can finish the sign-in. */
  pendingFailure: string | undefined;
}

export class HqVaultSignInError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HqVaultSignInError';
  }
}

function toResult(outcome: ProviderAuthOutcome): HqVaultSignInResult {
  return {
    providerId: outcome.providerId,
    family: outcome.family,
    ...(outcome.baseUrl ? { baseUrl: outcome.baseUrl } : {}),
    models: outcome.models,
    credential: { ...outcome.credential },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HqVaultSignIns {
  private readonly attempts = new Map<string, Attempt>();
  /** Slots taken by starts that are past the cap check but not yet registered. */
  private starting = 0;

  constructor(
    private readonly registry: HqVaultAuthRegistry,
    private readonly save: SaveSignIn,
    private readonly modelsRegistry: () => ModelsRegistry | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  strategies(): ProviderAuthStrategyMetadata[] {
    return this.registry.list();
  }

  view(attemptId: string): HqVaultSignInView {
    this.sweep();
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      throw new HqVaultSignInError(404, 'NOT_FOUND', 'No such sign-in; start a new one.');
    }
    return { ...attempt.view };
  }

  async start(
    strategyInput: unknown,
    profileInput: unknown,
    actor: string,
  ): Promise<HqVaultSignInView> {
    this.sweep();
    const strategyId =
      typeof strategyInput === 'string' ? this.registry.resolveId(strategyInput) : undefined;
    if (!strategyId) throw new HqVaultSignInError(400, 'BAD_REQUEST', 'Unknown sign-in.');
    const requestedProfileId =
      typeof profileInput === 'string' && profileInput.trim() !== ''
        ? profileInput.trim()
        : undefined;
    const live = [...this.attempts.values()].filter((a) => !a.settled).length + this.starting;
    if (live >= MAX_ATTEMPTS) {
      throw new HqVaultSignInError(
        409,
        'VAULT_CONFLICT',
        'Too many sign-ins in progress; finish or cancel one first.',
      );
    }
    const controller = new AbortController();
    const modelsRegistry = this.modelsRegistry();
    // Reserve the slot before the first await: `begin` is where a sign-in starts
    // holding resources (a provider session, a callback port), so a check that
    // counted only registered attempts let every concurrent caller claim the
    // same free slot.
    this.starting += 1;
    let session: ProviderAuthSession;
    try {
      session = await this.registry.begin(
        strategyId,
        modelsRegistry ? { modelsRegistry } : {},
        controller.signal,
      );
    } catch (error) {
      this.starting -= 1;
      throw error;
    }
    const attemptId = randomBytes(12).toString('hex');
    const view: HqVaultSignInView = {
      attemptId,
      strategyId,
      providerId: session.providerId,
      profileId: requestedProfileId ?? session.providerId,
      phase: session.interaction.type === 'device_code' ? 'awaiting_code' : 'awaiting_browser',
      ...(session.interaction.type === 'device_code'
        ? {
            verificationUri: session.interaction.verificationUri,
            userCode: session.interaction.userCode,
          }
        : { authorizeUrl: session.interaction.authorizeUrl, bound: session.interaction.bound }),
    };
    const attempt: Attempt = {
      view,
      requestedProfileId,
      session,
      controller,
      createdAt: this.now(),
      settled: false,
      completing: 0,
      pendingFailure: undefined,
    };
    this.attempts.set(attemptId, attempt);
    // The reservation becomes a registered attempt in this same synchronous
    // continuation, so no caller can observe a window where neither counts it.
    this.starting -= 1;
    // An abandoned sign-in releases its session (and callback port) on its own;
    // unref'd, so it never keeps HQ running.
    setTimeout(() => this.fail(attempt, 'Sign-in expired.'), ATTEMPT_TTL_MS).unref?.();
    // Something to wait for: a device-code poll, or HQ's own loopback callback.
    // The pasted-code path may run beside that callback over the same
    // authorization code, so a failure here only settles the attempt once no
    // sibling completion can still finish the sign-in.
    if (session.interaction.type === 'device_code' || session.interaction.bound) {
      this.beginCompletion(attempt);
      void session
        .waitForCompletion(controller.signal)
        .then((outcome) => this.finish(attempt, outcome, actor))
        .catch((error) => {
          attempt.pendingFailure = errorText(error);
        })
        .finally(() => this.endCompletion(attempt));
    }
    return { ...view };
  }

  async code(attemptId: string, input: unknown, actor: string): Promise<HqVaultSignInView> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.settled || !attempt.session) {
      throw new HqVaultSignInError(404, 'NOT_FOUND', 'This sign-in ended; start a new one.');
    }
    if (typeof input !== 'string' || input.trim() === '' || input.length > 8192) {
      throw new HqVaultSignInError(400, 'BAD_REQUEST', 'Paste the redirected URL or the code.');
    }
    attempt.view.phase = 'exchanging';
    this.beginCompletion(attempt);
    try {
      const outcome = await attempt.session.completeWithCode(
        input.trim(),
        attempt.controller.signal,
      );
      await this.finish(attempt, outcome, actor);
    } catch (error) {
      attempt.pendingFailure = errorText(error);
    } finally {
      this.endCompletion(attempt);
    }
    return { ...attempt.view };
  }

  cancel(attemptId: string): HqVaultSignInView {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) throw new HqVaultSignInError(404, 'NOT_FOUND', 'No such sign-in.');
    if (!attempt.settled) this.fail(attempt, 'Sign-in cancelled.');
    return { ...attempt.view };
  }

  /** Close every open session (server shutdown). */
  close(): void {
    for (const attempt of this.attempts.values()) {
      attempt.controller.abort();
      attempt.session?.close();
    }
    this.attempts.clear();
  }

  /**
   * Completion paths (HQ's own callback, a pasted code) may run at once over
   * the same authorization code. The last one to end settles the attempt: a
   * path that fails while a sibling is still exchanging must not discard the
   * sibling's success, so its message waits for {@link endCompletion}.
   */
  private beginCompletion(attempt: Attempt): void {
    attempt.completing += 1;
  }

  private endCompletion(attempt: Attempt): void {
    attempt.completing = Math.max(0, attempt.completing - 1);
    if (attempt.completing > 0 || attempt.settled) return;
    if (attempt.pendingFailure !== undefined) this.fail(attempt, attempt.pendingFailure);
  }

  private async finish(
    attempt: Attempt,
    outcome: ProviderAuthOutcome | null,
    actor: string,
  ): Promise<void> {
    if (attempt.settled) return;
    if (!outcome) {
      this.fail(attempt, 'Sign-in cancelled or timed out.');
      return;
    }
    attempt.settled = true;
    this.release(attempt);
    try {
      const profile = await this.save(
        {
          profileId: attempt.requestedProfileId,
          strategyId: attempt.view.strategyId,
          result: toResult(outcome),
        },
        actor,
      );
      attempt.view = {
        ...attempt.view,
        phase: 'success',
        profileId: profile.id,
        profile,
        message: `Signed in — saved on ${profile.id}.`,
      };
    } catch (error) {
      attempt.view = { ...attempt.view, phase: 'error', message: errorText(error) };
    }
  }

  private fail(attempt: Attempt, message: string): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.view = { ...attempt.view, phase: 'error', message };
    this.release(attempt);
  }

  private release(attempt: Attempt): void {
    attempt.controller.abort();
    attempt.session?.close();
    attempt.session = undefined;
  }

  private sweep(): void {
    const cutoff = this.now() - ATTEMPT_TTL_MS;
    for (const [id, attempt] of this.attempts) {
      if (attempt.createdAt >= cutoff) continue;
      if (!attempt.settled) this.fail(attempt, 'Sign-in expired.');
      this.attempts.delete(id);
    }
  }
}
