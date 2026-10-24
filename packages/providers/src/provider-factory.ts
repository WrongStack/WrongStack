import type {
  Logger,
  ModelsRegistry,
  Provider,
  ProviderConfig,
  ResolvedProvider,
} from '@wrongstack/contracts/types';
import { ConfigError } from '@wrongstack/contracts/types';
import { isKeylessLocalProvider } from '@wrongstack/core/models';
import type { ProviderFactory } from '@wrongstack/core/registry';
import { bindProviderCatalogId } from '@wrongstack/core/utils';
import { attachAccountQuotaReporting } from './account-quota.js';
import { AiGatewayProvider, createAiGatewayProviderFactory } from './ai-gateway.js';
import { CATALOG_ALIAS_BY_PROVIDER_TYPE, capabilitiesFor } from './capabilities.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { buildProvider, readFromEnv, resolveActiveKey, validateQuirks } from './provider-build.js';
import { SubscriptionOAuthProvider } from './subscription-oauth.js';
import { withZaiAccountPlane, zaiWireContract } from './zai.js';

export type { CompatiblePreset, ProviderCredentialSource } from './provider-build.js';
export {
  _modelsPersist,
  _oauthPersist,
  buildProvider,
  COMPATIBLE_PRESETS,
  oauthPersistenceCallbacks,
  readFromEnv,
  resolveActiveKey,
  resolveActiveKeyEntry,
  resolveAntigravityClient,
  setOAuthTokenPersister,
  setProviderModelPersister,
  validateQuirks,
} from './provider-build.js';

export interface BuildFactoriesOptions {
  registry: ModelsRegistry;
  /** Used to log unsupported families during boot. */
  log?: Logger | undefined;
}

/**
 * Known openai-compatible provider ids with tuned wire-format presets.
 *
 * Presets are exported directly for manual use:
 *   ```
 *   import { mistralWireFormat } from '@wrongstack/providers';
 *   const factory = createWireFormatFactory(mistralWireFormat);
 *   ```
 */

/**
 * Build one ProviderFactory per provider known to models.dev. The factory's
 * `create(cfg)` resolves the wire-family at construction time and returns the
 * matching transport. Unsupported families return a stub that throws when
 * complete() is called, so the system can still boot.
 */
/**
 * Wrap a provider so the catalog-resolved `Capabilities` overlay is
 * applied after construction. The factory itself was created with the
 * family default; `capabilitiesFor(registry, ...)` layers per-model
 * facts on top — `ModelsDevModel.limit.output` for `maxOutput`, which
 * drives Chimera's `Request.maxTokens`.
 *
 * Failures inside the resolution step are swallowed: the family default
 * stands, and the per-request `resolveMaxOutputTokens` lookup still reaches
 * the catalog for `req.model`. The diagnostic lives at DEBUG so a healthy
 * boot stays quiet.
 */
export async function withCatalogCapabilities(
  registry: ModelsRegistry,
  providerId: string,
  provider: Provider,
  cfg: ProviderConfig,
  log?: Logger,
): Promise<Provider> {
  try {
    // Gateway transports are absent from models.dev under their own id; their
    // per-model facts live under the upstream provider named in the model id.
    // Detect from the instance, not from config, so user-chosen aliases
    // ("gateway-work") resolve the same way as the canonical id.
    const isGateway = provider instanceof AiGatewayProvider;
    const resolved = await capabilitiesFor(
      registry,
      providerId,
      cfg.model ?? '',
      cfg.customModels,
      {
        // No wire family describes a gateway, so read its facts from the
        // catalog id that does publish them and overlay onto what the transport
        // declared about itself rather than a family default.
        ...(isGateway
          ? {
              catalogProviderId: CATALOG_ALIAS_BY_PROVIDER_TYPE['ai-gateway'],
              baseCapabilities: provider.capabilities,
            }
          : {}),
      },
    );
    // `Provider.capabilities` is `readonly`; the property descriptor was
    // set with `writable: false` at construction time. Redefine it so
    // the catalog overlay lands cleanly.
    //
    // Assign a COPY: `capabilitiesFor` memoises one object per
    // (provider, model, customModels) key, and callers such as the fleet host
    // provider refine fields in place (`capabilities.maxContext = …`). Handing
    // out the cached instance would let one provider's refinement leak into
    // every other provider resolved from the same key.
    Object.defineProperty(provider, 'capabilities', {
      value: { ...resolved },
      writable: true,
      configurable: true,
      enumerable: true,
    });
  } catch (err) {
    log?.debug(
      `Provider capability overlay skipped for ${providerId}/${cfg.model ?? ''}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return provider;
}

export async function buildProviderFactoriesFromRegistry(
  opts: BuildFactoriesOptions,
): Promise<ProviderFactory[]> {
  const providers = await opts.registry.listProviders();
  const factories: ProviderFactory[] = [];
  const unsupported: ResolvedProvider[] = [];

  for (const p of providers) {
    if (p.family === 'unsupported') {
      unsupported.push(p);
      continue;
    }
    factories.push({
      type: p.id,
      family: p.family,
      // `cfg.type` is the user-visible id the host asked for (see makeProvider).
      create: (cfg: ProviderConfig) => {
        const provider = makeProvider(p, cfg, p.id, cfg.type || p.id);
        bindProviderCatalogId(provider, p.id);
        return provider;
      },
    });
  }

  // AI SDK 7 transport for Vercel AI Gateway model ids (`provider/model`).
  factories.push(createAiGatewayProviderFactory());

  // Generic factories so users can hand-roll a provider not in models.dev.
  factories.push({
    type: 'openai-compatible',
    family: 'openai-compatible',
    create: (cfg) => {
      const baseUrl = cfg.baseUrl;
      if (!baseUrl?.trim()) {
        throw new ConfigError({
          message:
            'OpenAI-compatible provider requires a base URL. Specify the endpoint (e.g. "https://api.example.com/v1").',
          code: 'CONFIG_INVALID',
        });
      }
      const glm = zaiWireContract(baseUrl, 'openai-compatible');
      const provider = new OpenAICompatibleProvider({
        // The host passes the config key as `cfg.type`; it names the provider.
        id: cfg.type || 'openai-compatible',
        definitionId: glm?.definitionId ?? 'openai-compatible',
        apiKey: requireKey(cfg),
        baseUrl,
        headers: cfg.headers,
        quirks: { ...glm?.quirks, ...validateQuirks('openai-compatible', cfg.quirks) },
      });
      // A hand-rolled provider pointed at Z.AI / BigModel is still that
      // vendor's account: quota, business codes, region hints.
      const wrapped = withZaiAccountPlane(provider, { apiKey: requireKey(cfg), baseUrl });
      bindProviderCatalogId(wrapped, 'openai-compatible');
      return wrapped;
    },
  });

  if (unsupported.length > 0 && opts.log) {
    // Debug-only: the user already knows their plan; only surface when
    // troubleshooting why a specific provider isn't selectable.
    opts.log.info(
      `${unsupported.length} provider(s) need a plugin (unsupported wire family): ` +
        unsupported.map((p) => p.id).join(', '),
    );
  }

  return factories;
}

/** {@link buildProvider}, plus the host-enabled post-turn account quota read. */
export function makeProvider(
  p: ResolvedProvider,
  cfg: ProviderConfig,
  factoryType: string = p.id,
  instanceId: string = p.id,
): Provider {
  const provider = buildProvider(p, cfg, factoryType, instanceId);
  return attachAccountQuotaReporting(provider, {
    providerId: instanceId,
    type: factoryType,
    baseUrl: cfg.baseUrl ?? p.apiBase,
    get apiKey() {
      return provider instanceof SubscriptionOAuthProvider
        ? provider.accountQuotaToken
        : (resolveActiveKey(cfg) ??
            readFromEnv(Array.isArray(cfg.envVars) ? cfg.envVars : p.envVars) ??
            '');
    },
    managementToken: cfg.managementToken,
    quotaEndpoint: cfg.quotaEndpoint,
  });
}

/**
 * Build a Provider purely from config — no models.dev lookup at all.
 * Used for user-defined providers and offline operation.
 */
export function makeProviderFromConfig(id: string, cfg: ProviderConfig): Provider {
  if (cfg.type === 'ai-gateway' || id === 'ai-gateway') {
    return createAiGatewayProviderFactory().create({ ...cfg, type: id });
  }
  if (!cfg.family) {
    throw new ConfigError({
      message: `Provider "${id}" needs an explicit family ("anthropic" | "openai" | "openai-compatible" | "google") when not in the models.dev catalog.`,
      code: 'CONFIG_INVALID',
    });
  }
  const synthetic: ResolvedProvider = {
    id,
    name: id,
    family: cfg.family,
    apiBase: cfg.baseUrl,
    envVars: cfg.envVars ?? [],
    models: seedConfigModels(cfg),
    npm: undefined,
  };
  return makeProvider(synthetic, cfg, cfg.type ?? id);
}

/** Saved account snapshots seed config-only providers; an absent list stays unknown. */
export function seedConfigModels(cfg: ProviderConfig): Array<{ id: string; name: string }> {
  const saved = cfg.models ?? [];
  if (saved.length > 0) return saved.map((m) => ({ id: m, name: m }));
  return [];
}

export function requireKey(cfg: ProviderConfig): string {
  const key = resolveActiveKey(cfg);
  if (key) return key;
  // A local server on loopback that names no key variable takes none — the
  // same rule boot and the picker use to call it usable.
  if (isKeylessLocalProvider({ apiBase: cfg.baseUrl, envVars: cfg.envVars })) return 'no-key';
  throw new ConfigError({
    message: 'Provider config requires apiKey (or set the corresponding env var).',
    code: 'CONFIG_INVALID',
  });
}
