interface ProviderKeyStoreInput {
  provider: string;
  envVar?: string | undefined;
  label?: string | undefined;
  setActive?: boolean | undefined;
}

interface ProviderKeyStoreOptions {
  updateConfig: (mutate: (cfg: Record<string, unknown>) => void) => Promise<void>;
}

export interface ProviderKeyStoreOutput {
  status: 'ok';
  message: string;
}

export async function storeProviderKey(
  providers: Record<string, Record<string, unknown>>,
  input: ProviderKeyStoreInput,
  keyValue: string,
  opts: ProviderKeyStoreOptions,
): Promise<ProviderKeyStoreOutput> {
  const providerId = input.provider;

  // Ensure the provider config exists.
  if (!providers[providerId]) {
    // Auto-create with a best-guess type; users can configure details later.
    providers[providerId] = { type: providerId };
  }

  const entry = providers[providerId]!;
  const existingKeys = Array.isArray(entry.apiKeys)
    ? [...(entry.apiKeys as Array<Record<string, unknown>>)]
    : [];
  const label = input.label ?? 'default';

  existingKeys.push({
    label,
    apiKey: keyValue,
    createdAt: new Date().toISOString(),
  });

  entry.apiKeys = existingKeys;
  // `delete`, not `= undefined` — the same `entry` object is mirrored into the
  // in-memory configStore by updateConfig, and an `apiKey: undefined` property
  // survives there (`'apiKey' in entry` stays true) even though JSON
  // serialization drops it on disk. Deleting keeps both views identical.
  delete entry.apiKey;

  if (input.setActive !== false) {
    entry.activeKey = label;
  }

  providers[providerId] = entry;

  await opts.updateConfig((cfg) => {
    cfg.providers = providers;
  });

  const sourceName = input.envVar ? `env:${input.envVar}` : 'direct key';
  return {
    status: 'ok',
    message:
      `✓ API key stored for "${providerId}" from ${sourceName}. ` +
      `Now add models to favorites with favorite_manage to use them in fallback chains.`,
  };
}
