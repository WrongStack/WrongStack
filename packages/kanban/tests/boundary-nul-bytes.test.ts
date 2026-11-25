import { describe, expect, it } from 'vitest';
import {
  evaluateKanbanBoundaryPath,
  type KanbanBoundaryLayer,
  normalizeBoundaryPath,
  normalizeKanbanBoundaryPolicy,
} from '../src/boundary.js';

describe('Kanban boundary NUL byte validation (F1831)', () => {
  it('rejects NUL-byte paths in normalizeBoundaryPath and blocks them in boundary evaluation', () => {
    const layers: KanbanBoundaryLayer[] = [
      {
        source: 'board',
        policy: {
          enabled: true,
          enforcement: 'block',
          shellAccess: 'block',
          allow: [],
          deny: [{ kind: 'file', access: 'read_write', path: 'secrets/key.pem' }],
        },
      },
    ];

    expect(normalizeBoundaryPath('secrets/key.pem\0.txt')).toBeNull();
    expect(evaluateKanbanBoundaryPath(layers, 'secrets/key.pem\0.txt', 'read').decision).toBe(
      'block',
    );
    expect(() =>
      normalizeKanbanBoundaryPolicy({
        enabled: true,
        enforcement: 'block',
        shellAccess: 'block',
        allow: [{ kind: 'file', access: 'read', path: 'src/a\0b.ts' }],
      }),
    ).toThrow('Kanban boundary path must stay inside the project');
  });
});
