import type { Tool } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { startLeaderGateway } from '../../src/wrongforge-leader/wrongforge-leader-gateway.js';

interface ServedTool {
  name: string;
  description?: string | undefined;
  input_schema?: Record<string, unknown> | undefined;
}

describe('the leader gateway tool listing', () => {
  it('serves schemas in the wire-normalized form instead of verbatim', async () => {
    // This listing reaches Claude through WrongForge: Anthropic-family
    // endpoints reject a top-level oneOf/allOf/anyOf at the input_schema
    // root, so the same wire-normalized form every provider converter
    // applies (compactToolDefinitionForWire) must be served here too.
    const combined = {
      name: 'combined',
      description: 'carries a top-level allOf',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'string' } },
        allOf: [{ properties: { b: { type: 'number' } }, required: ['b'] }, { required: ['a'] }],
      },
    } as unknown as Tool;
    const clean = {
      name: 'clean',
      description: 'already clean',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
    } as unknown as Tool;

    const gateway = await startLeaderGateway(
      { listTools: () => [combined, clean] } as never,
      'test-session',
    );
    expect(gateway).toBeDefined();
    try {
      const res = await fetch(`${gateway!.spec.url}/v1/tools`, {
        headers: { authorization: `Bearer ${gateway!.spec.token}` },
      });
      expect(res.ok).toBe(true);
      const body = (await res.json()) as { tools: ServedTool[] };
      const byName = new Map(body.tools.map((t) => [t.name, t]));

      const servedCombined = byName.get('combined')!.input_schema!;
      expect(servedCombined['allOf']).toBeUndefined();
      expect(servedCombined['oneOf']).toBeUndefined();
      expect(servedCombined['anyOf']).toBeUndefined();
      expect(servedCombined['type']).toBe('object');
      // Branch fields and requirements merge into the flattened root.
      expect(Object.keys(servedCombined['properties'] as object)).toEqual(
        expect.arrayContaining(['a', 'b']),
      );
      expect(servedCombined['required']).toEqual(expect.arrayContaining(['a', 'b']));

      // A contract-clean schema passes through structurally intact.
      const servedClean = byName.get('clean')!.input_schema!;
      expect(servedClean['type']).toBe('object');
      expect(servedClean).not.toHaveProperty('allOf');
      expect((servedClean['properties'] as Record<string, unknown>)['x']).toBeDefined();
    } finally {
      await gateway!.close();
    }
  });

  it('returns undefined when the host offers nothing', async () => {
    const gateway = await startLeaderGateway({ listTools: () => [] } as never, 'test-session');
    expect(gateway).toBeUndefined();
  });
});
