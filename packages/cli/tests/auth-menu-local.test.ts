import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { ModelsRegistry } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { type AuthMenuDeps, runAuthLocal } from '../src/auth-menu/index.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

/**
 * `wstack auth local` is a quick-add shortcut for the three local-LLM
 * presets. It must:
 *
 *   1. Save the right family / baseUrl / envVars shape for each preset.
 *   2. Skip the key prompt entirely for noAuth presets (Ollama).
 *   3. For vLLM / LM Studio, prompt for a key but accept "Enter to skip"
 *      so auth-disabled servers can be configured without a key entry.
 *   4. Save the right `type` so the matching wire-format preset in
 *      `@wrongstack/providers/src/presets/local-llm.ts` is selected.
 *   5. Refuse unknown --name values.
 *   6. Persist no plaintext key when no key was entered.
 *
 * The shortcut saves the provider under its canonical id (`ollama`,
 * `vllm`, `lmstudio`). The matching wire-format preset in
 * `@wrongstack/providers` looks up its config by that exact id.
 */

// --- Test helpers ----------------------------------------------------------

async function mkTempDir(prefix = 'wstack-auth-local-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRenderer(): TerminalRenderer {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeBlock: vi.fn(),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(),
    writeError: vi.fn(),
    writeInfo: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as never as TerminalRenderer;
}

function makeReader(lines: string[], secrets: string[] = []): ReadlineInputReader {
  let li = 0;
  let si = 0;
  return {
    readLine: vi.fn(async () => {
      if (li >= lines.length) throw new Error('EOF');
      return lines[li++] ?? '';
    }),
    readSecret: vi.fn(async () => {
      if (si >= secrets.length) throw new Error('EOF (secret)');
      return secrets[si++] ?? '';
    }),
    close: vi.fn(async () => {}),
  } as never as ReadlineInputReader;
}

function makeModelsRegistry(): ModelsRegistry {
  return {
    getProvider: vi.fn(async () => undefined),
    listProviders: vi.fn(async () => []),
    suggestModel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  } as never as ModelsRegistry;
}

async function setupDeps(opts: {
  lines?: string[];
  secrets?: string[];
  preExisting?: object;
}): Promise<{ deps: AuthMenuDeps; configPath: string; tmpDir: string }> {
  const tmpDir = await mkTempDir();
  const configPath = path.join(tmpDir, 'config.json');
  if (opts.preExisting) {
    await fs.writeFile(configPath, JSON.stringify(opts.preExisting), { mode: 0o600 });
  }
  const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });
  const deps: AuthMenuDeps = {
    renderer: makeRenderer(),
    reader: makeReader(opts.lines ?? [], opts.secrets ?? []),
    modelsRegistry: makeModelsRegistry(),
    vault,
    profileConfigPath: configPath,
  };
  return { deps, configPath, tmpDir };
}

async function readSaved(configPath: string): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
  return raw.providers as Record<string, unknown>;
}

// --- Tests -----------------------------------------------------------------

describe('runAuthLocal — Ollama (noAuth preset)', () => {
  it('saves the preset config with the canonical base URL and no key entry', async () => {
    const { deps, configPath } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'ollama', noProbe: true });
    expect(code).toBe(0);

    const saved = await readSaved(configPath);
    const ollama = saved['ollama'] as {
      type: string;
      family: string;
      baseUrl: string;
      envVars?: string[];
      activeKey?: string;
      apiKeys?: { label: string; apiKey: string }[];
      apiKey?: string;
    };
    expect(ollama).toBeDefined();
    expect(ollama.type).toBe('ollama');
    expect(ollama.family).toBe('openai-compatible');
    expect(ollama.baseUrl).toBe('http://localhost:11434/v1');
    // No key was entered → no apiKeys / apiKey / activeKey.
    expect(ollama.apiKeys).toBeUndefined();
    expect(ollama.apiKey).toBeUndefined();
    expect(ollama.activeKey).toBeUndefined();
  });

  it('does not call readSecret (no prompt) for the noAuth preset', async () => {
    const { deps } = await setupDeps({});
    const readSecret = vi.spyOn(deps.reader, 'readSecret');
    await runAuthLocal(deps, { name: 'ollama', noProbe: true });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('writes no plaintext secret anywhere on disk', async () => {
    const { deps, configPath, tmpDir } = await setupDeps({});
    await runAuthLocal(deps, { name: 'ollama', noProbe: true });
    const dirContents = await fs.readdir(tmpDir);
    for (const name of dirContents) {
      const full = path.join(tmpDir, name);
      const stat = await fs.stat(full);
      if (stat.isFile()) {
        const buf = await fs.readFile(full, 'utf8');
        expect(buf).not.toMatch(/sk-[A-Za-z0-9]/);
      }
    }
    // The config itself has no apiKey field for this case.
    const saved = await readSaved(configPath);
    const ollama = saved['ollama'] as { apiKey?: string };
    expect(ollama.apiKey).toBeUndefined();
  });
});

describe('runAuthLocal — vLLM (optional auth preset)', () => {
  it('saves without a key when the user submits an empty key (auth disabled)', async () => {
    const { deps, configPath } = await setupDeps({ secrets: [''] });
    const code = await runAuthLocal(deps, { name: 'vllm', noProbe: true });
    expect(code).toBe(0);

    const saved = await readSaved(configPath);
    const vllm = saved['vllm'] as {
      type: string;
      family: string;
      baseUrl: string;
      apiKey?: string;
      apiKeys?: unknown[];
    };
    expect(vllm.type).toBe('vllm');
    expect(vllm.family).toBe('openai-compatible');
    expect(vllm.baseUrl).toBe('http://localhost:8000/v1');
    expect(vllm.apiKey).toBeUndefined();
    expect(vllm.apiKeys).toBeUndefined();
  });

  it('saves with a key when the user supplies one', async () => {
    const { deps, configPath } = await setupDeps({ secrets: ['sk-local-abc'] });
    const code = await runAuthLocal(deps, { name: 'vllm', noProbe: true });
    expect(code).toBe(0);

    const saved = await readSaved(configPath);
    const vllm = saved['vllm'] as {
      apiKeys?: { label: string; apiKey: string; createdAt: string }[];
      activeKey?: string;
    };
    expect(vllm.apiKeys).toHaveLength(1);
    expect(vllm.apiKeys?.[0]?.label).toBe('default');
    expect(vllm.apiKeys?.[0]?.apiKey).toMatch(/^enc:v1:/); // encrypted-at-rest
    expect(vllm.apiKeys?.[0]?.apiKey).not.toBe('sk-local-abc');
    expect(vllm.activeKey).toBe('default');

    // Encrypted-at-rest: plaintext must NOT appear in the file.
    const rawDisk = await fs.readFile(configPath, 'utf8');
    expect(rawDisk).not.toContain('sk-local-abc');
  });
});

describe('runAuthLocal — LM Studio', () => {
  it('uses port 1234 by default', async () => {
    // LM Studio has optional auth — supply an empty secret to skip the prompt.
    const { deps, configPath } = await setupDeps({ secrets: [''] });
    await runAuthLocal(deps, { name: 'lmstudio', noProbe: true });
    const saved = await readSaved(configPath);
    expect((saved['lmstudio'] as { baseUrl: string }).baseUrl).toBe('http://localhost:1234/v1');
  });
});

describe('runAuthLocal — flag handling', () => {
  it('honors a custom --base-url override', async () => {
    const { deps, configPath } = await setupDeps({});
    await runAuthLocal(deps, {
      name: 'ollama',
      baseUrl: 'http://gpu-box.lan:11434/v1',
      noProbe: true,
    });
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { baseUrl: string }).baseUrl).toBe('http://gpu-box.lan:11434/v1');
  });

  it('rejects an unknown --name', async () => {
    const { deps } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'llamacpp' });
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown local server "llamacpp"'),
    );
  });

  it('lowercases a mixed-case --name (so "Ollama" / "VLLM" work)', async () => {
    const { deps } = await setupDeps({});
    const code = await runAuthLocal(deps, { name: 'Ollama', noProbe: true });
    // We lowercase before lookup, so 'Ollama' should still resolve.
    expect(code).toBe(0);
  });

  it('skips the key prompt for vLLM when --no-key is passed (scripting)', async () => {
    const { deps } = await setupDeps({});
    const readSecret = vi.spyOn(deps.reader, 'readSecret');
    await runAuthLocal(deps, { name: 'vllm', skipKey: true, noProbe: true });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('falls back to the preset default baseUrl when --base-url is empty', async () => {
    const { deps, configPath } = await setupDeps({});
    await runAuthLocal(deps, { name: 'ollama', baseUrl: '   ', noProbe: true });
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { baseUrl: string }).baseUrl).toBe('http://localhost:11434/v1');
  });
});

describe('runAuthLocal — interactive picker', () => {
  it('saves the chosen preset when the user picks a number', async () => {
    // Pick "1" (OmniRoute, the first entry) and submit no key (noAuth → no prompt).
    const { deps, configPath } = await setupDeps({ lines: ['1'] });
    const code = await runAuthLocal(deps, { noProbe: true });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['omniroute'] as { baseUrl: string }).baseUrl).toBe('http://localhost:20128/v1');
  });

  it('saves Ollama when the user picks it by id', async () => {
    // Ollama is no longer at position 1; pick it by id (noAuth → no prompt).
    const { deps, configPath } = await setupDeps({ lines: ['ollama'] });
    const code = await runAuthLocal(deps, { noProbe: true });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { baseUrl: string }).baseUrl).toBe('http://localhost:11434/v1');
  });

  it('accepts the preset id directly as a pick', async () => {
    // vLLM has optional auth — supply an empty secret to skip the prompt.
    const { deps, configPath } = await setupDeps({ lines: ['vllm'], secrets: [''] });
    const code = await runAuthLocal(deps, { noProbe: true });
    expect(code).toBe(0);
    const saved = await readSaved(configPath);
    expect((saved['vllm'] as { baseUrl: string }).baseUrl).toBe('http://localhost:8000/v1');
  });

  it('returns 0 on cancel (q)', async () => {
    const { deps, tmpDir } = await setupDeps({ lines: ['q'] });
    const code = await runAuthLocal(deps, { noProbe: true });
    expect(code).toBe(0);
    // No provider was saved → no config file was created.
    const configPath = path.join(tmpDir, 'config.json');
    await expect(fs.access(configPath)).rejects.toThrow();
  });

  it('returns 0 and reports the error on an unknown pick (no state changed)', async () => {
    // First pick is bad, second is a quit. We exercise only the first
    // pick here to assert the failure path is reachable.
    const { deps, tmpDir } = await setupDeps({ lines: ['99'] });
    const code = await runAuthLocal(deps, { noProbe: true });
    // Unknown pick is a user input error, already reported — exit 0.
    expect(code).toBe(0);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown selection'),
    );
    const configPath = path.join(tmpDir, 'config.json');
    await expect(fs.access(configPath)).rejects.toThrow();
  });
});

describe('runAuthLocal — merge with pre-existing provider', () => {
  it('preserves an existing baseUrl and family when they are already set', async () => {
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          ollama: {
            type: 'ollama',
            family: 'openai-compatible',
            baseUrl: 'http://existing.local:9999/v1',
          },
        },
      },
    });
    await runAuthLocal(deps, { name: 'ollama', noProbe: true });
    const saved = await readSaved(configPath);
    expect((saved['ollama'] as { baseUrl: string }).baseUrl).toBe('http://existing.local:9999/v1');
  });

  it('appends a numeric suffix when the default label collides', async () => {
    const { deps, configPath } = await setupDeps({
      secrets: ['sk-vllm-1'],
      preExisting: {
        providers: {
          vllm: {
            type: 'vllm',
            family: 'openai-compatible',
            baseUrl: 'http://localhost:8000/v1',
            apiKeys: [{ label: 'default', apiKey: 'sk-vllm-0', createdAt: '2024-01-01' }],
            activeKey: 'default',
          },
        },
      },
    });
    await runAuthLocal(deps, { name: 'vllm', noProbe: true });
    const saved = await readSaved(configPath);
    const vllm = saved['vllm'] as {
      apiKeys: { label: string }[];
      activeKey: string;
    };
    // Both the existing and the new key should be present.
    const labels = vllm.apiKeys.map((k) => k.label);
    expect(labels).toContain('default');
    expect(labels).toContain('default-2');
    expect(vllm.activeKey).toBe('default');
  });
});
