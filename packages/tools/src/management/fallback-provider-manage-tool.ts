import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import { embeddedIPv4, expandIPv6 } from '@wrongstack/core/utils';
import type { FallbackManageToolOptions } from './fallback-manage-tool-options.js';

export const PROVIDER_MANAGE_TOOL_NAME = 'provider_manage';

const PROVIDER_MANAGE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'add', 'configure', 'remove', 'disable', 'enable'],
      description:
        'Operation: list (show all providers), add (add a new provider config), ' +
        'configure (update fields of an existing provider), remove (delete a provider config), ' +
        'disable (skip every model of the provider in fallback routing and pickers while ' +
        'keeping its config and credentials), enable (undo a disable).',
    },
    provider: {
      type: 'string',
      description:
        'Provider id (e.g. "openai", "anthropic"). Required for all actions except list.',
    },
    type: {
      type: 'string',
      description: 'Provider type (e.g. "openai", "anthropic"). Required for "add".',
    },
    models: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Model list to restrict visibility for this provider. Optional for add/configure.',
    },
    baseUrl: {
      type: 'string',
      description: 'Custom base URL (e.g. for self-hosted endpoints). Optional.',
    },
    family: {
      type: 'string',
      description:
        'Wire-family override (e.g. "openai", "openai-compatible", "anthropic"). ' +
        'When set, the provider can be constructed without a catalog entry.',
    },
    envVars: {
      type: 'array',
      items: { type: 'string' },
      description: 'Custom env var names to probe when apiKey is missing. Optional.',
    },
    autoDiscoverModels: {
      type: 'boolean',
      description: 'Auto-fetch model list from {baseUrl}/models. Optional.',
    },
    apiKey: {
      type: 'string',
      description:
        '**NOT RECOMMENDED** — use provider_key_set instead. ' +
        'The LLM output may contain this value; use env var references for safety.',
    },
  },
  required: ['action'],
  additionalProperties: false,
};

interface ProviderManageInput {
  action: 'list' | 'add' | 'configure' | 'remove' | 'disable' | 'enable';
  provider?: string | undefined;
  type?: string | undefined;
  models?: string[] | undefined;
  baseUrl?: string | undefined;
  family?: string | undefined;
  envVars?: string[] | undefined;
  autoDiscoverModels?: boolean | undefined;
  apiKey?: string | undefined;
}

interface ProviderManageOutput {
  status: 'ok';
  message: string;
  providers?: string[];
}

export const CREDENTIAL_SELECTOR_FIELDS = ['apiKey', 'apiKeys', 'activeKey', 'envVars'] as const;

export function envVarsClaimedByOtherProviders(
  providers: Record<string, Record<string, unknown>>,
  exceptProvider: string,
): Map<string, string> {
  const claimed = new Map<string, string>();
  for (const [id, entry] of Object.entries(providers)) {
    if (id === exceptProvider) continue;
    const names = entry?.['envVars'];
    if (!Array.isArray(names)) continue;
    for (const name of names) {
      if (typeof name === 'string' && !claimed.has(name)) claimed.set(name, id);
    }
  }
  return claimed;
}

export function rejectBorrowedEnvVars(
  providers: Record<string, Record<string, unknown>>,
  provider: string,
  requested: readonly unknown[] | undefined,
): string | null {
  if (!requested) return null;
  const claimed = envVarsClaimedByOtherProviders(providers, provider);
  for (const name of requested) {
    const owner = typeof name === 'string' ? claimed.get(name) : undefined;
    if (owner !== undefined) {
      return `Environment variable "${String(name)}" already supplies the key for provider "${owner}". Reading another provider's credential from "${provider}" is not allowed; use provider_key_set to give "${provider}" its own key.`;
    }
  }
  return null;
}

/**
 * Refuse IPv6 link-local (fe80::/10) and unspecified (`::`) addresses.
 * Kept separate from the IPv4 metadata check so each family's always-block
 * list stays explicit.
 */
function isV6LinkLocalOrUnspecified(address: string): boolean {
  if (address === '::') return true;
  const first = expandIPv6(address.toLowerCase())?.[0];
  return first !== undefined && (first & 0xffc0) === 0xfe80;
}

/**
 * Validate a provider `baseUrl` before it is persisted (VULN-006).
 *
 * IMDS-class link-local/metadata ranges — IPv4 169.254.0.0/16 (AWS/GCE/Azure
 * IMDS), 0.0.0.0/8, IPv6 fe80::/10 and `::` — are refused outright. No
 * legitimate LLM endpoint lives there, and a redirect is both a
 * credential-delivery and a metadata-theft primitive (the cloud metadata
 * service hands out host role credentials to whoever asks). Deliberately NOT
 * gated: CGNAT (100.64/10) and benchmarking (198.18/15) — those are
 * tenant-network space, not metadata endpoints, and hard-blocking them could
 * break legitimate internal deployments; revisit if the threat model grows.
 *
 * Other private/loopback hosts (127/8, RFC1918, ::1, ULA, `localhost`) stay
 * allowed: pointing a provider at a local server is a documented, pinned
 * product contract (Ollama, LM Studio, omniroute), and a redirect there is a
 * same-user boundary (T4). The credential-theft half of VULN-006 is closed
 * by `endpointChanged`'s `envVars: []` sentinel, which stops the resolver
 * from silently re-arming the old credential for the new endpoint.
 *
 * Async because hostnames are DNS-resolved — the same resolution gate
 * `assertNotPrivateHost` applies before sockets. DNS failure is not treated
 * as a metadata hit: the endpoint simply fails to connect when used.
 */
export async function validateProviderBaseUrl(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Invalid baseUrl: ${raw} is not a valid URL.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Invalid baseUrl: ${url.protocol} is not supported — use http: or https:.`;
  }
  if (url.username || url.password) {
    return 'Invalid baseUrl: credentials embedded in the URL are not accepted.';
  }

  const host =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;

  let addresses: string[];
  if (host === 'localhost' || host.endsWith('.localhost')) {
    // localhost itself is loopback-tier (allowed); resolving it adds nothing.
    return null;
  }
  if (net.isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((record) => record.address);
    } catch {
      // Unresolvable hostname: nothing to gate here — the endpoint fails on
      // first use. (Same policy as assertNotPrivateHost's DNS handling.)
      return null;
    }
  }

  for (const address of addresses) {
    // Classify the always-block set through BOTH representations: the literal
    // itself and any IPv4 it embeds (mapped `::ffff:a9fe:a9fe`, NAT64
    // `64:ff9b::a9fe:a9fe`, 6to4) — isPrivateIPv6's transition-format logic
    // flags these as private, but only the embedded IPv4 reveals that the
    // target is specifically link-local/metadata (VULN-006 review).
    if (net.isIP(address) === 4) {
      // Full 0.0.0.0/8 ("this host") and 169.254.0.0/16 (IMDS + link-local).
      if (address.startsWith('0.') || address.startsWith('169.254.')) {
        return metadataRefusal(address);
      }
      continue;
    }
    if (isV6LinkLocalOrUnspecified(address)) {
      return metadataRefusal(address);
    }
    // IPv6 loopback (::1) is loopback-tier (allowed) — it is NOT metadata.
    if (address === '::1') continue;
    // Classify the IPv4 a v6 address embeds. The MAPPED format
    // (::ffff:a9fe:a9fe — WHATWG's serialization of ::ffff:169.254.169.254)
    // must be handled explicitly here: embeddedIPv4 deliberately skips it
    // (its doc: "the formats the mapped-address branch does not"), and
    // isPrivateIPv6 owns the mapped branch but only answers a boolean, while
    // this gate needs the embedded IPv4 STRING to recognize 0/8 and
    // 169.254/16. Without this, a mapped IMDS target passes as "no embedded
    // IPv4".
    let embedded: string | undefined;
    const groups = expandIPv6(address.toLowerCase());
    if (groups) {
      if (groups[5] === 0xffff && groups.slice(0, 5).every((g) => g === 0)) {
        const g = (i: number): number => groups[i] ?? 0;
        embedded = `${g(6) >> 8}.${g(6) & 0xff}.${g(7) >> 8}.${g(7) & 0xff}`;
      } else {
        embedded = embeddedIPv4(groups);
      }
    }
    if (embedded && (embedded.startsWith('0.') || embedded.startsWith('169.254.'))) {
      return metadataRefusal(`${address} (embeds ${embedded})`);
    }
  }
  return null;
}

function metadataRefusal(address: string): string {
  return `Invalid baseUrl: link-local/metadata address "${address}" is not a valid provider endpoint — it exposes the machine's internal network and cloud metadata services.`;
}

export function createProviderManageTool(
  opts: FallbackManageToolOptions,
): Tool<ProviderManageInput, ProviderManageOutput> {
  return {
    name: PROVIDER_MANAGE_TOOL_NAME,
    description:
      'View or configure provider entries. List all configured providers with their ' +
      'type, model lists, base URL, key status, and disabled state. Add new providers, ' +
      'update their settings, disable or enable them, or remove unused ones. Disabling a ' +
      'provider keeps its config and credentials but excludes every one of its models from ' +
      'fallback routing (including named profiles) and model pickers. API keys should be ' +
      'set via provider_key_set instead of passing them here — they are visible in the LLM output.',
    usageHint:
      '"list" to see all providers. "add" with provider id and type to create. ' +
      '"configure" to update models, baseUrl, family, or envVars. ' +
      '"disable" to park a provider (all its models are skipped everywhere) and "enable" ' +
      'to restore it. "remove" to delete a provider. Use provider_key_set for API key management.',
    category: 'config',
    inputSchema: PROVIDER_MANAGE_SCHEMA,
    permission: 'auto',
    mutating: true,
    subjectKey: 'baseUrl',
    riskTier: 'standard',
    icon: 'settings',
    async execute(input) {
      const config = opts.getConfig();
      const providers = {
        ...((config.providers ?? {}) as unknown as Record<string, Record<string, unknown>>),
      };
      const leaderProvider: string = config.provider ?? '';
      // Raw ids as the user wrote them; compared case-insensitively so a casing
      // difference between the heading id and the entry never silently re-enables
      // a provider.
      const disabledProviders = (
        Array.isArray(config.disabledProviders) ? config.disabledProviders : []
      ).filter((id) => typeof id === 'string' && id.trim().length > 0);
      const isDisabled = (id: string): boolean =>
        disabledProviders.some((entry) => entry.trim().toLowerCase() === id.trim().toLowerCase());

      if (input.action === 'list') {
        const ids = Object.keys(providers);
        if (ids.length === 0) {
          return { status: 'ok', message: 'No providers configured.', providers: [] };
        }
        const msg = ids
          .sort()
          .map((id) => {
            const entry = providers[id] ?? {};
            const type = (entry.type as string) ?? '(unknown)';
            const models = Array.isArray(entry.models)
              ? (entry.models as string[]).join(', ')
              : '(all)';
            const hasKey = entry.apiKey ? '✓' : entry.apiKeys ? '✓' : '✗';
            const prefix = id === leaderProvider ? '★ ' : '  ';
            const baseUrl = entry.baseUrl ? ` url:${entry.baseUrl}` : '';
            const family = entry.family ? ` family:${entry.family}` : '';
            const off = isDisabled(id) ? ' [DISABLED]' : '';
            return `  ${prefix}${id} (${type}) key:${hasKey} models:[${models}]${baseUrl}${family}${off}`;
          })
          .join('\n');
        return {
          status: 'ok',
          message: `Providers (leader: ${leaderProvider}):\n${msg}${
            disabledProviders.length > 0
              ? `\nDisabled providers (${disabledProviders.length}): ${disabledProviders.join(', ')} — all their models are skipped in fallback routing and pickers.`
              : ''
          }`,
          providers: ids,
        };
      }

      if (input.action === 'add') {
        if (!input.provider || !input.type) {
          throw new ToolValidationError({
            message: 'Provide "provider" (id) and "type" to add a provider.',
            field: !input.provider ? 'provider' : 'type',
          });
        }
        if (providers[input.provider]) {
          throw new ToolValidationError({
            message: `Provider "${input.provider}" already exists. Use "configure" to update.`,
            field: 'provider',
          });
        }
        if (input.baseUrl) {
          const invalid = await validateProviderBaseUrl(input.baseUrl);
          if (invalid) throw new ToolValidationError({ message: invalid, field: 'baseUrl' });
        }
        const borrowed = rejectBorrowedEnvVars(providers, input.provider, input.envVars);
        if (borrowed) throw new ToolValidationError({ message: borrowed, field: 'envVars' });
        const entry: Record<string, unknown> = { type: input.type };
        if (input.models) entry.models = input.models;
        if (input.baseUrl) entry.baseUrl = input.baseUrl;
        if (input.family) entry.family = input.family;
        if (input.envVars) entry.envVars = input.envVars;
        // VULN-006 (WS-2026-09-26-01): without envVars the resolver reads the
        // catalog preset of `type` (`type: 'anthropic'` → ANTHROPIC_API_KEY)
        // and sends it to this baseUrl. The credential-bind gate only sees
        // env var NAMES in the input, so under YOLO that was an unprompted
        // "send my key to a host I chose". A new endpoint gets no environment
        // credential unless the caller names one (which the gate then sees).
        if (input.baseUrl && input.envVars === undefined) entry.envVars = [];
        if (input.autoDiscoverModels !== undefined)
          entry.autoDiscoverModels = input.autoDiscoverModels;
        if (input.apiKey) entry.apiKey = input.apiKey;
        providers[input.provider] = entry;
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        return {
          status: 'ok',
          message: `✓ Added provider: ${input.provider} (type: ${input.type})${
            Array.isArray(entry.envVars) && entry.envVars.length === 0 && !entry.apiKey
              ? ' — no environment key is sent to this base URL; set one with provider_key_set'
              : ''
          }`,
        };
      }

      if (input.action === 'configure') {
        if (!input.provider) {
          throw new ToolValidationError({
            message: 'Provide "provider" id to configure.',
            field: 'provider',
          });
        }
        if (!providers[input.provider]) {
          throw new ToolValidationError({
            message: `Provider "${input.provider}" not found. Use "add" first or check "list".`,
            field: 'provider',
          });
        }
        if (input.baseUrl) {
          const invalid = await validateProviderBaseUrl(input.baseUrl);
          if (invalid) throw new ToolValidationError({ message: invalid, field: 'baseUrl' });
        }
        const previous: Record<string, unknown> = { ...providers[input.provider] };
        const entry: Record<string, unknown> = { ...previous };
        if (input.models !== undefined) entry.models = input.models;
        if (input.baseUrl !== undefined) entry.baseUrl = input.baseUrl || undefined;
        if (input.family !== undefined) entry.family = input.family || undefined;
        if (input.envVars !== undefined) entry.envVars = input.envVars;
        if (input.autoDiscoverModels !== undefined)
          entry.autoDiscoverModels = input.autoDiscoverModels;
        if (input.apiKey !== undefined) entry.apiKey = input.apiKey || undefined;

        const endpointChanged =
          input.baseUrl !== undefined &&
          (entry.baseUrl ?? undefined) !== (previous.baseUrl ?? undefined);
        const explicitlySupplied = new Set<string>([
          ...(input.apiKey !== undefined ? ['apiKey'] : []),
          ...(input.envVars !== undefined ? ['envVars'] : []),
        ]);
        // `envVars` is dropped to the sentinel even when the previous entry
        // never listed it: the common `{ type: 'anthropic' }` entry is keyed
        // by the catalog preset alone, and skipping it re-armed that key for
        // the new endpoint (WS-2026-09-26-01). A reset to the default endpoint
        // (`baseUrl: ''`) points back at the vendor, so it adds no sentinel.
        const droppedFields = endpointChanged
          ? CREDENTIAL_SELECTOR_FIELDS.filter(
              (field) =>
                !explicitlySupplied.has(field) &&
                (previous[field] !== undefined ||
                  (field === 'envVars' && entry.baseUrl !== undefined)),
            )
          : [];
        for (const field of droppedFields) {
          // VULN-006: `envVars` must persist as an explicit EMPTY ARRAY, not
          // undefined. An absent key lets the provider resolver fall back to
          // the catalog preset (e.g. OPENAI_API_KEY) and silently re-arm the
          // credential for the NEW endpoint; present-but-empty suppresses
          // that fallback (providers/src/index.ts honors the sentinel).
          entry[field] = field === 'envVars' ? [] : undefined;
        }
        const clearedFields = droppedFields.filter((field) => previous[field] !== undefined);

        const borrowed = rejectBorrowedEnvVars(providers, input.provider, input.envVars);
        if (borrowed) throw new ToolValidationError({ message: borrowed, field: 'envVars' });

        providers[input.provider] = entry;
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        const updated = Object.keys({ ...entry })
          .filter((k) => k !== 'apiKey')
          .join(', ');
        const keyNote =
          clearedFields.length > 0
            ? ` — cleared ${clearedFields.join(', ')} because the base URL changed; set the key again with provider_key_set`
            : droppedFields.length > 0
              ? ' — the environment key is not sent to the new base URL; set one with provider_key_set'
              : '';
        return { status: 'ok', message: `✓ Updated ${input.provider}: ${updated}${keyNote}` };
      }

      if (input.action === 'remove') {
        if (!input.provider) {
          throw new ToolValidationError({
            message: 'Provide "provider" id to remove.',
            field: 'provider',
          });
        }
        if (!providers[input.provider]) {
          throw new ToolValidationError({
            message: `Provider "${input.provider}" not found.`,
            field: 'provider',
          });
        }
        if (input.provider === leaderProvider) {
          throw new ToolValidationError({
            message: `Cannot remove the active leader provider "${input.provider}". Switch the leader first.`,
            field: 'provider',
          });
        }
        delete providers[input.provider];
        await opts.updateConfig((cfg) => {
          cfg.providers = providers;
        });
        return { status: 'ok', message: `✓ Removed provider: ${input.provider}` };
      }

      if (input.action === 'disable' || input.action === 'enable') {
        if (!input.provider) {
          throw new ToolValidationError({
            message: `Provide "provider" id to ${input.action}.`,
            field: 'provider',
          });
        }
        if (!providers[input.provider]) {
          throw new ToolValidationError({
            message: `Provider "${input.provider}" not found. Use "list" to see configured providers.`,
            field: 'provider',
          });
        }
        const target = input.provider.trim();
        // Drop any case-variant first so the stored list stays a true set, then
        // add the caller's spelling when disabling (config stays readable).
        const next = disabledProviders.filter(
          (id) => id.trim().toLowerCase() !== target.toLowerCase(),
        );
        if (input.action === 'disable') next.push(target);
        await opts.updateConfig((cfg) => {
          cfg.disabledProviders = next.length > 0 ? [...next].sort() : undefined;
        });
        if (input.action === 'enable') {
          return {
            status: 'ok',
            message:
              `✓ Enabled provider: ${target} — its models are selectable and eligible for ` +
              'fallback routing again.',
          };
        }
        return {
          status: 'ok',
          message:
            `✓ Disabled provider: ${target} — every one of its models is now skipped in fallback ` +
            'routing (named profiles, explicit chains, smart defaults) and in model pickers. Its ' +
            `config and credentials are kept; re-enable with provider_manage({ action: "enable", provider: "${target}" }).${
              input.provider === leaderProvider
                ? ' The active session keeps running on its current model; new fallbacks will not route to this provider.'
                : ''
            }`,
        };
      }

      throw new ToolValidationError({
        message: `Unknown action: "${input.action}".`,
        field: 'action',
      });
    },
  };
}
