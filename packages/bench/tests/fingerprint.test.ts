import { describe, expect, it } from 'vitest';
import {
  computeHarnessFingerprint,
  computeStableJsonHash,
  computeTextHash,
  computeToolManifestHash,
  fingerprintLabel,
} from '../src/fingerprint.js';

const base = {
  cliVersion: '0.255.0',
  toolNames: ['read', 'write', 'edit', 'bash'],
  maxIterations: 40,
  yolo: true,
  subsetId: 'polyglot:abc123',
};

describe('computeHarnessFingerprint', () => {
  it('is deterministic for identical inputs', () => {
    const a = computeHarnessFingerprint(base);
    const b = computeHarnessFingerprint(base);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toHaveLength(12);
  });

  it('is order-independent in tool names', () => {
    const a = computeHarnessFingerprint(base);
    const b = computeHarnessFingerprint({ ...base, toolNames: ['bash', 'edit', 'write', 'read'] });
    expect(a.hash).toBe(b.hash);
    // The stored list is normalized (sorted) regardless of input order.
    expect(a.toolNames).toEqual(['bash', 'edit', 'read', 'write']);
  });

  it('changes when any harness field changes', () => {
    const ref = computeHarnessFingerprint(base).hash;
    expect(computeHarnessFingerprint({ ...base, cliVersion: '0.256.0' }).hash).not.toBe(ref);
    expect(computeHarnessFingerprint({ ...base, maxIterations: 50 }).hash).not.toBe(ref);
    expect(computeHarnessFingerprint({ ...base, yolo: false }).hash).not.toBe(ref);
    expect(computeHarnessFingerprint({ ...base, subsetId: 'polyglot:def456' }).hash).not.toBe(ref);
    expect(computeHarnessFingerprint({ ...base, toolNames: ['read'] }).hash).not.toBe(ref);
    expect(computeHarnessFingerprint({ ...base, toolManifestHash: 'tools-a' }).hash).not.toBe(ref);
    expect(computeHarnessFingerprint({ ...base, systemPromptHash: 'prompt-a' }).hash).not.toBe(ref);
    expect(computeHarnessFingerprint({ ...base, configHash: 'config-a' }).hash).not.toBe(ref);
  });

  it('renders a readable label', () => {
    const fp = computeHarnessFingerprint(base);
    const label = fingerprintLabel(fp);
    expect(label).toContain('wrongstack@0.255.0');
    expect(label).toContain(`fp:${fp.hash}`);
    expect(label).toContain('maxIter=40');
    expect(label).toContain('yolo');
  });

  it('omits yolo from the label when disabled', () => {
    const fp = computeHarnessFingerprint({ ...base, yolo: false });
    expect(fingerprintLabel(fp)).not.toContain('yolo');
  });

  it('hashes tool manifests independent of tool and schema key order', () => {
    const a = computeToolManifestHash([
      {
        name: 'write',
        description: 'Write a file',
        usageHint: 'Use for file creation',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
        },
        permission: 'auto',
        mutating: true,
      },
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: { properties: { path: { type: 'string' } }, type: 'object' },
        permission: 'auto',
        mutating: false,
      },
    ]);
    const b = computeToolManifestHash([
      {
        name: 'read',
        description: 'Read a file',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        permission: 'auto',
        mutating: false,
      },
      {
        name: 'write',
        description: 'Write a file',
        usageHint: 'Use for file creation',
        inputSchema: {
          properties: { content: { type: 'string' }, path: { type: 'string' } },
          type: 'object',
        },
        permission: 'auto',
        mutating: true,
      },
    ]);
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it('changes tool manifest hash when behavior-facing tool text changes', () => {
    const ref = computeToolManifestHash([
      { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
    ]);
    expect(
      computeToolManifestHash([
        { name: 'read', description: 'Read a file carefully', inputSchema: { type: 'object' } },
      ]),
    ).not.toBe(ref);
  });

  it('exposes stable hashes for prompt text and JSON-like config', () => {
    expect(computeTextHash('system prompt')).toHaveLength(12);
    expect(computeStableJsonHash({ b: 2, a: { y: true, x: [1, 2] } })).toBe(
      computeStableJsonHash({ a: { x: [1, 2], y: true }, b: 2 }),
    );
  });
});
