import { describe, expect, it } from 'vitest';
import type { ArchitectureDecisionContent } from '../../src/storage/architecture-decision.js';
import {
  formatArchitectureDecisionTransfer,
  parseArchitectureDecisionTransfer,
} from '../../src/storage/architecture-decision-transfer.js';

const content: ArchitectureDecisionContent = {
  title: 'Provider boundary',
  context: 'Keep core independent.\n## A literal heading',
  decision: 'Use a provider port.',
  alternatives: ['Direct imports'],
  consequences: ['Explicit interfaces'],
  constraints: ['No provider imports in core'],
  scope: ['packages/core'],
  revisitWhen: '',
  checks: [
    {
      id: 'port',
      kind: 'contains_text',
      path: 'packages/core/port.ts',
      text: 'export interface Port',
    },
  ],
};

describe('portable ADR proposal content', () => {
  it('round-trips content and checks without importing approval or predecessor authority', () => {
    const record = {
      ...content,
      id: 'ADR-source',
      projectId: 'source',
      revision: 9,
      status: 'accepted',
      resolvedBy: 'source-user',
      resolutionReason: 'Approved.',
      supersedes: 'ADR-predecessor',
      predecessorRevision: 3,
      contentHash: 'a'.repeat(64),
    };
    const text = formatArchitectureDecisionTransfer(record);
    expect(parseArchitectureDecisionTransfer(text)).toEqual(content);
    const envelope = JSON.parse(text);
    expect(Object.keys(envelope)).toEqual(['format', 'version', 'proposal']);
    for (const field of [
      'id',
      'projectId',
      'revision',
      'status',
      'resolvedBy',
      'resolutionReason',
      'supersedes',
      'predecessorRevision',
      'contentHash',
    ])
      expect(envelope.proposal).not.toHaveProperty(field);
  });

  it.each([
    null,
    [],
    {},
    { format: 'wrongstack-adr', version: 2, proposal: content },
    { format: 'wrongstack-adr', version: 1, proposal: content, status: 'accepted' },
    { format: 'wrongstack-adr', version: 1, proposal: { ...content, projectId: 'source' } },
    { format: 'wrongstack-adr', version: 1, proposal: { ...content, supersedes: 'ADR-local' } },
  ])('rejects unsupported envelopes and approval metadata %#', (value) => {
    expect(() => parseArchitectureDecisionTransfer(JSON.stringify(value))).toThrow(/ADR transfer/);
  });

  it('applies character/UTF-8 byte limits before parsing and validates imported scope/checks', () => {
    expect(() => parseArchitectureDecisionTransfer('x'.repeat(60_001))).toThrow(
      /ADR transfer exceeds/,
    );
    expect(() => parseArchitectureDecisionTransfer('界'.repeat(45_000))).toThrow(
      /ADR transfer exceeds/,
    );
    expect(() => parseArchitectureDecisionTransfer('{')).toThrow(/valid JSON/);
    expect(() =>
      parseArchitectureDecisionTransfer(
        JSON.stringify({
          format: 'wrongstack-adr',
          version: 1,
          proposal: { ...content, scope: ['../escape'] },
        }),
      ),
    ).toThrow(/scope/);
    expect(() =>
      parseArchitectureDecisionTransfer(
        JSON.stringify({
          format: 'wrongstack-adr',
          version: 1,
          proposal: {
            ...content,
            checks: [
              { id: 'shell', kind: 'script', path: 'packages/core/port.ts', command: 'anything' },
            ],
          },
        }),
      ),
    ).toThrow(/check/i);
  });
});
