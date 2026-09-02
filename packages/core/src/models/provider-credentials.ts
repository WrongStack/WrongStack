/**
 * "Does this provider have a usable credential?" — one answer.
 *
 * There were three, and they disagreed:
 *
 *  - `cli/src/provider-helpers.ts` — env var OR `config.providers[id].apiKey`
 *    OR any entry in `apiKeys[]`. The complete rule.
 *  - `cli/src/slash-commands/modelcaps.ts` — config only. `/modelcaps` printed
 *    a hollow `○` next to every provider keyed purely through
 *    `ANTHROPIC_API_KEY`, which is the most common way to key one.
 *  - `webui-server/src/server/provider-handlers.ts` — `savedIds.has(id) || env`.
 *    `savedIds` means "appears in the saved config at all", so a provider saved
 *    with a `baseUrl` and no key reported `hasApiKey: true` and the WebUI
 *    offered it as ready to use.
 *
 * The rule itself is small; that it lives in three places is the defect. This
 * module is in core because the CLI and the WebUI server both need it and
 * neither may import the other.
 */

/** The provider fields the check reads. Both call sites can supply these. */
export interface ProviderCredentialSubject {
  readonly id: string;
  /** Environment variables that carry this provider's key, if any. */
  readonly envVars?: readonly string[] | undefined;
}

/** The saved-config shape the check reads. */
export interface ProviderCredentialConfig {
  readonly providers?:
    | Readonly<
        Record<
          string,
          | {
              readonly apiKey?: string | undefined;
              readonly apiKeys?:
                | readonly ({ readonly apiKey?: string | undefined } | undefined)[]
                | undefined;
            }
          | undefined
        >
      >
    | undefined;
}

/**
 * Is a key present in the environment for this provider?
 *
 * Split out because the WebUI reports the two sources separately in places, and
 * because a caller with no config still has a meaningful answer.
 */
export function hasProviderKeyInEnv(
  provider: ProviderCredentialSubject,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (provider.envVars ?? []).some((name) => !!env[name]);
}

/** Is a non-empty key stored in the saved config for this provider? */
export function hasProviderKeyInConfig(
  providerId: string,
  config: ProviderCredentialConfig | undefined,
): boolean {
  const entry = config?.providers?.[providerId];
  if (!entry) return false;
  if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) return true;
  // An `apiKeys` array can hold rotation entries; any one with a key counts.
  return Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => !!k?.apiKey);
}

/**
 * Can the user call this provider right now?
 *
 * Deliberately does NOT cover keyless local gateways (loopback servers that
 * declare no env vars). They need no credential at all, which is a different
 * question with a different answer — see `isKeylessLocalProvider`. Folding the
 * two together here would make "has a key" mean "is usable" and quietly lose
 * the distinction the picker needs.
 */
export function hasProviderCredential(
  provider: ProviderCredentialSubject,
  config: ProviderCredentialConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return hasProviderKeyInEnv(provider, env) || hasProviderKeyInConfig(provider.id, config);
}
