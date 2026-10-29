import { describe, expect, it } from 'vitest';
import {
  chronicleFileName,
  chronicleJsonl,
  chronicleLineageMarkdown,
  chronicleMarkdown,
} from '../src/chronicle-export';

const tool = {
  eventId: 'e1',
  eventType: 'tool.completed',
  occurredAt: '2026-10-29T10:00:00.000Z',
  outcome: 'success',
  attributes: { toolName: 'edit | write\nfile' },
  resource: { path: 'src/`odd`.ts' },
};
const model = {
  eventId: 'e2',
  eventType: 'model.attempt',
  occurredAt: '2026-10-29T10:01:00.000Z',
  runtime: { modelId: 'model-a' },
};

describe('Chronicle export', () => {
  it('writes the loaded events exactly as returned, one per line', () => {
    const text = chronicleJsonl([tool, model]);
    expect(
      text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toEqual([tool, model]);
    expect(chronicleJsonl([])).toBe('');
  });
  it('writes a readable table whose recorded text cannot break it', () => {
    const markdown = chronicleMarkdown([tool, model], {
      filters: 'no filters',
      exportedAt: '2026-10-29T11:00:00.000Z',
      total: 7,
    });
    const lines = markdown.trimEnd().split('\n');
    expect(lines[0]).toBe('# WrongStack Chronicle');
    expect(lines[2]).toBe(
      'Exported 2026-10-29T11:00:00.000Z · 2 of 7 matching events · no filters',
    );
    expect(lines[6]).toBe(
      '| 2026-10-29T10:00:00.000Z | tool.completed | edit \\| write file | ``src/`odd`.ts`` | success |',
    );
    expect(
      chronicleMarkdown([{ ...tool, resource: { path: '`edge`' } }], {
        filters: '',
        exportedAt: 't',
        total: 1,
      }),
    ).toContain('| `` `edge` `` |');
    // A missing outcome is stated, and the subject falls back to the model.
    expect(lines[7]).toBe(
      '| 2026-10-29T10:01:00.000Z | model.attempt | model · attempt | `model-a` | unknown |',
    );
    expect(chronicleMarkdown([], { filters: 'x', exportedAt: 't', total: undefined })).toContain(
      '0 of unknown matching events',
    );
  });
  it('names files without path separators or colons', () => {
    expect(chronicleFileName('2026-10-29T11:00:00.000Z', 'jsonl')).toBe(
      'wrongstack-chronicle-2026-10-29T11-00-00-000Z.jsonl',
    );
  });
});

describe('Chronicle lineage export', () => {
  it('lists events and relationships with the engine confidence unchanged', () => {
    const markdown = chronicleLineageMarkdown(
      {
        nodes: [tool, model],
        edges: [
          { from: 'e1', to: 'e2', kind: 'caused_by', confidence: 'inferred' },
          { from: 'e1', to: 'missing', kind: 'x', confidence: 'explicit' },
        ],
        truncated: true,
      },
      { seed: 'e1', exportedAt: 't' },
    );
    expect(markdown).toContain(
      'seed `e1` · 2 events · 1 relationships · truncated at the engine limit',
    );
    expect(markdown).toContain('| edit \\| write file | caused by | inferred | model · attempt |');
    expect(markdown).not.toContain('missing');
  });
  it('names lineage files apart from timeline exports', () => {
    expect(chronicleFileName('2026-10-29T11:00:00.000Z', 'json', 'lineage')).toBe(
      'wrongstack-chronicle-lineage-2026-10-29T11-00-00-000Z.json',
    );
  });
});
