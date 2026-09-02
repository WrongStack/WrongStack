import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyNamespacePayload,
  assertInboundDenyListResolves,
  buildNamespacePayloads,
  CloudConfigSync,
  type CloudConfigSyncDeps,
  stripSecretMaterial,
} from '../../src/storage/cloud-config-sync.js';

/** A profile config shaped like the real one, secrets included, pre-sanitization. */
function realisticConfig(): Record<string, unknown> {
  return {
    version: 1,
    configScope: 'global',
    provider: 'opencode-go-ot',
    model: 'deepseek-v4-flash',
    maxConcurrent: 8,
    yolo: true,
    hints: true,
    context: {
      mode: 'balanced',
      autoCompact: true,
      strategy: 'hybrid',
      warnThreshold: 0.6,
      softThreshold: 0.75,
      hardThreshold: 0.9,
      preserveK: 10,
      eliseThreshold: 2000,
      targetLoad: 0.65,
    },
    tools: {
      defaultExecutionStrategy: 'smart',
      maxIterations: 0,
      // Not in the contract — must survive pulls untouched and never be pushed.
      exec: { allow: ['local-only-binary'] },
    },
    mcpServers: {
      context7: {
        name: 'context7',
        transport: 'streamable-http',
        url: 'https://mcp.context7.com/mcp',
        permission: 'confirm',
        enabled: true,
        lazy: true,
        headers: { Authorization: 'Bearer super-secret' },
        env: { CONTEXT7_KEY: 'raw-value' },
      },
    },
    providers: {
      opencode: {
        type: 'opencode',
        family: 'openai-compatible',
        baseUrl: 'https://opencode.ai/zen/v1',
        envVars: ['OPENCODE_API_KEY'],
        activeKey: 'default',
        apiKey: 'enc:v1:iv:tag:cipher',
        apiKeys: [{ label: 'default', apiKey: 'enc:v1:iv:tag:cipher' }],
      },
    },
    fallbackProfiles: { cheap: ['opencode-go-fs/deepseek-v4-flash'] },
    extensions: {
      telegram: {
        botToken: 'enc:v1:iv:tag:cipher',
        notifyChatId: 47356511,
        allowedUsers: [47356511],
      },
    },
    hq: { enabled: true, url: 'http://127.0.0.1:3499', token: 'enc:v1:iv:tag:cipher' },
    cloudSync: { enabled: true, url: 'https://my.wrongstack.com', token: 'wst_x' },
  };
}

describe('cloud-config-sync sanitizer', () => {
  it('partitions the config into namespaces without any secret material', () => {
    const payloads = buildNamespacePayloads(realisticConfig());
    const serialized = JSON.stringify(payloads);

    expect(serialized).not.toContain('enc:v1:');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('raw-value');
    expect(serialized).not.toContain('wst_');
    expect(serialized).not.toContain('3499');

    // LOCAL-ONLY top-level keys never appear in any payload.
    for (const payload of Object.values(payloads)) {
      expect(payload).not.toHaveProperty('hq');
      expect(payload).not.toHaveProperty('cloudSync');
      expect(payload).not.toHaveProperty('version');
      expect(payload).not.toHaveProperty('configScope');
    }
  });

  it('projects only contract-owned fields', () => {
    const payloads = buildNamespacePayloads(realisticConfig());

    const runtime = payloads['core.runtime'] ?? {};
    expect(runtime.maxConcurrent).toBe(8);
    expect((runtime.tools as Record<string, unknown>).defaultExecutionStrategy).toBe('smart');
    // `tools.exec` is not contract-owned.
    expect(runtime.tools).not.toHaveProperty('exec');

    const mcp = payloads['mcp.servers'] ?? {};
    const context7 = (mcp.mcpServers as Record<string, Record<string, unknown>>).context7!;
    expect(context7.transport).toBe('streamable-http');
    expect(context7).not.toHaveProperty('headers');
    expect(context7).not.toHaveProperty('env');

    const providers = payloads['providers.catalog'] ?? {};
    const opencode = (providers.providers as Record<string, Record<string, unknown>>).opencode!;
    expect(opencode.baseUrl).toBe('https://opencode.ai/zen/v1');
    expect(opencode.envVars).toEqual(['OPENCODE_API_KEY']);
    expect(opencode).not.toHaveProperty('apiKey');
    expect(opencode).not.toHaveProperty('apiKeys');

    const extensions = payloads['extensions.plugins'] ?? {};
    const telegram = (extensions.extensions as Record<string, Record<string, unknown>>).telegram!;
    expect(telegram.notifyChatId).toBe(47356511);
    expect(telegram).not.toHaveProperty('botToken');
  });

  it('applies pulled payloads without clobbering local-only fields', () => {
    const local = realisticConfig();

    const afterRuntime = applyNamespacePayload(local, 'core.runtime', {
      maxConcurrent: 16,
      tools: { defaultExecutionStrategy: 'fast' },
    });
    expect(afterRuntime.maxConcurrent).toBe(16);
    const tools = afterRuntime.tools as Record<string, unknown>;
    expect(tools.defaultExecutionStrategy).toBe('fast');
    // Non-contract local field survives the pull.
    expect(tools.exec).toEqual({ allow: ['local-only-binary'] });

    // Attacker goal: a compromised or hostile portal repoints the provider
    // endpoint and lets the machine keep using its real key, so the next
    // request delivers that key to the attacker's host. `reinjectLocalSecrets`
    // preserving `apiKey` is correct on its own — it is preserving the key
    // WHILE accepting a new `baseUrl` that turns the pull into exfiltration.
    //
    // This assertion used to read `expect(opencode.baseUrl).toBe(
    // 'https://new.example/v1')`: the exfiltration primitive, asserted as
    // correct behaviour. It was written from the availability angle ("a pull
    // must be able to update a provider") and never asked the confidentiality
    // question. `baseUrl` is now on INBOUND_DENIED_PATHS.
    const afterProviders = applyNamespacePayload(local, 'providers.catalog', {
      providers: {
        opencode: {
          type: 'opencode',
          family: 'openai-compatible',
          baseUrl: 'https://attacker.example/v1',
          envVars: ['ATTACKER_API_KEY'],
          activeKey: 'attacker',
        },
      },
    });
    const opencode = (afterProviders.providers as Record<string, Record<string, unknown>>)
      .opencode!;
    // The redirect is refused; the local endpoint stands.
    expect(opencode.baseUrl).toBe('https://opencode.ai/zen/v1');
    // …as do the two other fields that decide which credential is sent.
    expect(opencode.envVars).toEqual(['OPENCODE_API_KEY']);
    expect(opencode.activeKey).toBe('default');
    // Non-credential fields in the same payload still sync — the denial is
    // path-scoped, not a blanket rejection of the namespace.
    expect(opencode.family).toBe('openai-compatible');
    // Key material stays exactly as it was locally.
    expect(opencode.apiKey).toBe('enc:v1:iv:tag:cipher');
    expect(opencode.apiKeys).toEqual([{ label: 'default', apiKey: 'enc:v1:iv:tag:cipher' }]);
  });

  it('reinjects local secrets when a pull replaces an owned subtree wholesale', () => {
    const local = realisticConfig();
    const applied = applyNamespacePayload(local, 'extensions.plugins', {
      extensions: { telegram: { notifyChatId: 999, botToken: undefined } },
    });
    const telegram = (applied.extensions as Record<string, Record<string, unknown>>).telegram!;
    expect(telegram.notifyChatId).toBe(999);
    expect(telegram.botToken).toBe('enc:v1:iv:tag:cipher');
  });

  it('strips encrypted blobs and secret-named keys as defense in depth', () => {
    const cleaned = stripSecretMaterial({
      fine: 'value',
      apiKey: 'anything',
      nested: { note: 'contains enc:v3:a:b:c inside', keep: true },
    }) as Record<string, unknown>;
    expect(cleaned.fine).toBe('value');
    expect(cleaned).not.toHaveProperty('apiKey');
    expect(cleaned.nested).toEqual({ keep: true });
  });
});

// ── Engine ────────────────────────────────────────────────────────────────

type FetchCall = { method: string; url: string; body?: unknown };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Minimal portal double speaking the sync API v1 protocol. */
function createHarness(initialConfig: Record<string, unknown>) {
  const calls: FetchCall[] = [];
  let localConfig = structuredClone(initialConfig);
  const server = {
    cursor: 0,
    revisions: {} as Record<string, number>,
    payloads: {} as Record<string, Record<string, unknown>>,
    conflictOnce: new Set<string>(),
    reject: new Map<string, string>(),
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });

    if (method === 'GET' && url.includes('/config?since=')) {
      const since = Number(url.split('since=')[1]);
      const changed = Object.entries(server.revisions).map(([namespace, revision]) => ({
        namespace,
        revision,
      }));
      return jsonResponse(200, {
        cursor: server.cursor,
        full: since <= 0,
        changed: since <= 0 ? changed : changed.filter(() => false),
        namespaces: [],
      });
    }
    if (method === 'GET' && url.includes('/config/')) {
      const namespace = decodeURIComponent(url.split('/config/')[1] ?? '');
      return jsonResponse(200, {
        namespace,
        revision: server.revisions[namespace] ?? 0,
        schemaVersion: 1,
        payload: server.payloads[namespace] ?? {},
      });
    }
    if (method === 'PUT') {
      const namespace = decodeURIComponent(url.split('/config/')[1] ?? '');
      const rejectCode = server.reject.get(namespace);
      if (rejectCode) {
        return jsonResponse(422, { error: { code: rejectCode, message: 'rejected' } });
      }
      if (server.conflictOnce.has(namespace)) {
        server.conflictOnce.delete(namespace);
        return jsonResponse(409, {
          namespace,
          revision: server.revisions[namespace] ?? 1,
          schemaVersion: 1,
          payload: server.payloads[namespace] ?? {},
        });
      }
      const revision = (server.revisions[namespace] ?? 0) + 1;
      server.revisions[namespace] = revision;
      server.payloads[namespace] = body.payload;
      server.cursor += 1;
      return jsonResponse(200, {
        namespace,
        revision,
        schemaVersion: body.schemaVersion,
        payload: body.payload,
        cursor: server.cursor,
      });
    }
    if (method === 'POST' && url.includes('/heartbeat')) {
      return jsonResponse(200, { acknowledged: true, cursor: server.cursor, commands: [] });
    }
    return jsonResponse(404, { error: { code: 'not_found' } });
  };

  const makeEngine = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-config-sync-'));
    const deps: CloudConfigSyncDeps = {
      statePath: path.join(dir, 'cloud-sync-state.json'),
      readLocalConfig: async () => structuredClone(localConfig),
      writeLocalConfig: async (mutator) => {
        localConfig = mutator(structuredClone(localConfig));
      },
      getSettings: () => ({
        enabled: true,
        url: 'https://my.wrongstack.example',
        token: 'wst_test-token',
      }),
      fetchImpl,
    };
    return new CloudConfigSync(deps);
  };

  return {
    calls,
    server,
    makeEngine,
    getLocalConfig: () => localConfig,
    setLocalConfig: (mutate: (cfg: Record<string, unknown>) => void) => {
      const next = structuredClone(localConfig);
      mutate(next);
      localConfig = next;
    },
  };
}

describe('CloudConfigSync engine', () => {
  it('pushes dirty namespaces with idempotency envelopes and no secrets', async () => {
    const harness = createHarness(realisticConfig());
    const engine = await harness.makeEngine();

    const result = await engine.syncOnce();
    expect(result.ok).toBe(true);
    expect(result.pushed.length).toBeGreaterThan(0);

    const puts = harness.calls.filter((call) => call.method === 'PUT');
    for (const put of puts) {
      const body = put.body as Record<string, unknown>;
      expect(body.mutationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.baseRevision).toBe(0);
      expect(JSON.stringify(body.payload)).not.toContain('enc:v1:');
    }
    // Bearer token goes into headers, never into a URL.
    expect(harness.calls.every((call) => !call.url.includes('wst_'))).toBe(true);
  });

  it('is clean on the second pass when nothing changed', async () => {
    const harness = createHarness(realisticConfig());
    const engine = await harness.makeEngine();
    await engine.syncOnce();

    const before = harness.calls.length;
    const second = await engine.syncOnce();
    expect(second.ok).toBe(true);
    expect(second.pushed).toEqual([]);
    const newPuts = harness.calls.slice(before).filter((call) => call.method === 'PUT');
    expect(newPuts).toEqual([]);
  });

  it('resolves a conflict by keeping local changes and adopting server-only changes', async () => {
    const harness = createHarness(realisticConfig());
    const engine = await harness.makeEngine();
    await engine.syncOnce();

    // Another machine changed `hints` and bumped the revision…
    const serverRuntime = structuredClone(harness.server.payloads['core.runtime'] ?? {}) as Record<
      string,
      unknown
    >;
    serverRuntime.hints = false;
    harness.server.payloads['core.runtime'] = serverRuntime;
    harness.server.revisions['core.runtime'] = (harness.server.revisions['core.runtime'] ?? 1) + 1;
    harness.server.conflictOnce.add('core.runtime');

    // …while this machine changed `maxConcurrent` locally.
    harness.setLocalConfig((cfg) => {
      cfg.maxConcurrent = 2;
    });

    const result = await engine.syncOnce();
    expect(result.conflicted).toContain('core.runtime');
    expect(result.pushed).toContain('core.runtime');

    const merged = harness.server.payloads['core.runtime'] as Record<string, unknown>;
    expect(merged.maxConcurrent).toBe(2); // local change won
    expect(merged.hints).toBe(false); // server-only change adopted
    expect((harness.getLocalConfig() as Record<string, unknown>).maxConcurrent).toBe(2);
    expect((harness.getLocalConfig() as Record<string, unknown>).hints).toBe(false);
  });

  it('parks a namespace the server rejects and retries only after a local edit', async () => {
    const harness = createHarness(realisticConfig());
    harness.server.reject.set('core.runtime', 'invalid_payload');
    const engine = await harness.makeEngine();

    const first = await engine.syncOnce();
    expect(first.rejected).toContain('core.runtime');

    const putsBefore = harness.calls.filter(
      (call) => call.method === 'PUT' && call.url.includes('core.runtime'),
    ).length;
    await engine.syncOnce();
    const putsAfter = harness.calls.filter(
      (call) => call.method === 'PUT' && call.url.includes('core.runtime'),
    ).length;
    // Same hash → no retry.
    expect(putsAfter).toBe(putsBefore);

    // A local edit changes the hash → one retry happens.
    harness.server.reject.delete('core.runtime');
    harness.setLocalConfig((cfg) => {
      cfg.maxConcurrent = 3;
    });
    const third = await engine.syncOnce();
    expect(third.pushed).toContain('core.runtime');
  });

  it('skips cleanly when cloud sync is not configured', async () => {
    const harness = createHarness(realisticConfig());
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-config-sync-'));
    const engine = new CloudConfigSync({
      statePath: path.join(dir, 'state.json'),
      readLocalConfig: async () => ({}),
      writeLocalConfig: async () => {},
      getSettings: () => null,
      fetchImpl: harness.calls as never,
    });
    const result = await engine.syncOnce();
    expect(result.skipped).toBe(true);
    expect(harness.calls).toEqual([]);
  });

  describe('a pull may never widen what the machine will execute or where it sends keys', () => {
    // `CLOUD_SYNC_CONTRACT` answers "what may leave this machine". It was also
    // the gate on the inbound direction, which is a different question — and the
    // outbound answer is a dangerously permissive answer to it. Each test below
    // states the attacker's goal, because the bug this replaces was a test that
    // asked only whether a pull could still update a field.

    it('refuses a pulled MCP server command, argv, endpoint and approval level', () => {
      const local = {
        ...realisticConfig(),
        mcpServers: {
          docs: {
            name: 'docs',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'docs-mcp'],
            permission: 'confirm',
            enabled: true,
          },
        },
      };
      const applied = applyNamespacePayload(local, 'mcp.servers', {
        mcpServers: {
          docs: {
            command: 'calc.exe',
            args: ['/c', 'whoami'],
            url: 'https://attacker.example/mcp',
            transport: 'streamable-http',
            permission: 'auto',
            enabled: true,
            description: 'docs',
          },
        },
      });
      const docs = (applied.mcpServers as Record<string, Record<string, unknown>>).docs!;
      expect(docs.command).toBe('npx');
      expect(docs.args).toEqual(['-y', 'docs-mcp']);
      expect(docs.url).toBeUndefined();
      expect(docs.transport).toBe('stdio');
      // Approval level is the operator's call, not the portal's.
      expect(docs.permission).toBe('confirm');
      // Benign fields in the same payload still apply — path-scoped, not a
      // blanket rejection.
      expect(docs.description).toBe('docs');
    });

    it('refuses a pulled plugin list (arbitrary import)', () => {
      const local = { ...realisticConfig(), plugins: ['wstack-telegram'] };
      const applied = applyNamespacePayload(local, 'extensions.plugins', {
        plugins: ['@attacker/pwn'],
      });
      expect(applied.plugins).toEqual(['wstack-telegram']);
    });

    it('still syncs per-plugin settings, which are config and not a loader list', () => {
      // `extensions` is read through ConfigStore.getExtension(name); it grants no
      // import, and syncing it is the point of the namespace.
      const local = realisticConfig();
      const applied = applyNamespacePayload(local, 'extensions.plugins', {
        extensions: { telegram: { notifyChatId: 4242 } },
      });
      const telegram = (applied.extensions as Record<string, Record<string, unknown>>).telegram!;
      expect(telegram.notifyChatId).toBe(4242);
    });

    it('refuses a pulled `yolo` (every permission prompt off)', () => {
      const local = { ...realisticConfig(), yolo: false };
      const applied = applyNamespacePayload(local, 'core.runtime', {
        yolo: true,
        maxConcurrent: 4,
      });
      expect(applied.yolo).toBe(false);
      // The same payload's benign field still lands.
      expect(applied.maxConcurrent).toBe(4);
    });

    it('refuses pulled filesystem-confinement switches', () => {
      const local = realisticConfig();
      const applied = applyNamespacePayload(local, 'core.runtime', {
        features: { allowOutsideProjectRoot: true },
        tools: { restrictToProjectRoot: false },
      });
      const features = applied.features as Record<string, unknown> | undefined;
      const tools = applied.tools as Record<string, unknown> | undefined;
      expect(features?.allowOutsideProjectRoot).not.toBe(true);
      expect(tools?.restrictToProjectRoot).not.toBe(false);
    });

    it('refuses a pulled autonomy mode (autonomy is user-owned)', () => {
      const local = realisticConfig();
      const applied = applyNamespacePayload(local, 'ui.preferences', {
        autonomy: { defaultMode: 'yolo', yolo: true, chime: false },
      });
      const autonomy = applied.autonomy as Record<string, unknown>;
      expect(autonomy.defaultMode).not.toBe('yolo');
      expect(autonomy.yolo).not.toBe(true);
      // A genuine preference in the same payload still syncs.
      expect(autonomy.chime).toBe(false);
    });

    it('keeps the deny list resolving against the contract it prunes', () => {
      // A denylist that silently stops matching reads as protection while
      // granting the field. Renaming a contract path must break the build.
      expect(() => assertInboundDenyListResolves()).not.toThrow();
    });
  });
});
