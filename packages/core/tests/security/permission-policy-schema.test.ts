import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import {
  TRUST_POLICY_JSON_SCHEMA,
  TRUST_POLICY_SCHEMA_VERSION,
  validateTrustPolicy,
} from '../../src/security/permission-policy-schema.js';
import type { Context } from '../../src/core/context.js';
import type { Tool } from '../../src/types/index.js';

function readTool(): Tool {
  return {
    name: 'read',
    description: 'read',
    inputSchema: { type: 'object' },
    permission: 'auto',
    mutating: false,
    async execute() {
      return 'ok';
    },
  };
}

describe('validateTrustPolicy', () => {
  it('exposes the current machine-readable schema version', () => {
    expect(TRUST_POLICY_SCHEMA_VERSION).toBe(1);
    expect(TRUST_POLICY_JSON_SCHEMA).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
    });
  });

  it('normalizes duplicate patterns and reports a warning', () => {
    const result = validateTrustPolicy({
      bash: { allow: ['git status', 'git status'], deny: ['rm *'], auto: false },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid policy');
    expect(result.policy).toEqual({
      bash: { allow: ['git status'], deny: ['rm *'], auto: false },
    });
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'duplicate_pattern' }),
    );
  });

  it('rejects unknown fields, wrong value types, and reserved property names', () => {
    const input = JSON.parse('{"__proto__":{"auto":true},"bash":{"deny":"rm *","surprise":true}}');
    const result = validateTrustPolicy(input);

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['unsafe_tool_name', 'invalid_pattern_list', 'unknown_field']),
    );
  });
});

describe('DefaultPermissionPolicy schema enforcement', () => {
  let dir: string;
  let trustFile: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'permission-schema-'));
    trustFile = path.join(dir, 'trust.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('fails closed on malformed JSON even in YOLO mode', async () => {
    await fs.writeFile(trustFile, '{broken');
    const policy = new DefaultPermissionPolicy({ trustFile, yolo: true });

    const decision = await policy.evaluate(readTool(), { path: 'README.md' }, {} as Context);

    expect(decision).toMatchObject({ permission: 'deny', source: 'deny' });
    expect(policy.getPolicyDiagnostics()).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'invalid_json' }),
    );
  });

  it('fails closed when a parsed rule does not match the canonical schema', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ read: { deny: 'secret.txt' } }));
    const policy = new DefaultPermissionPolicy({ trustFile, yolo: true });

    const decision = await policy.evaluate(readTool(), { path: 'public.txt' }, {} as Context);

    expect(decision.permission).toBe('deny');
    expect(policy.getPolicyDiagnostics()).toContainEqual(
      expect.objectContaining({ code: 'invalid_pattern_list', path: '$["read"].deny' }),
    );
    await expect(policy.trust({ tool: 'read', pattern: 'public.txt' })).rejects.toThrow(
      /trust\.json is invalid/,
    );
    expect(await fs.readFile(trustFile, 'utf8')).toBe(
      JSON.stringify({ read: { deny: 'secret.txt' } }),
    );
  });

  it('treats a missing trust file as an empty valid policy', async () => {
    const policy = new DefaultPermissionPolicy({ trustFile, yolo: true });

    const decision = await policy.evaluate(readTool(), { path: 'README.md' }, {} as Context);

    expect(decision).toMatchObject({ permission: 'auto', source: 'yolo' });
    expect(policy.getPolicyDiagnostics()).toEqual([]);
  });
});
