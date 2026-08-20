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
});
