import { ToolValidationError } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { boardCreateInput } from '../src/kanban-board-inputs.js';

describe('boardCreateInput null-prototype gateEnforcement guard (F2262)', () => {
  it('throws ToolValidationError instead of TypeError for null-prototype gateEnforcement', () => {
    expect(() =>
      boardCreateInput(
        { action: 'create_board', gateEnforcement: Object.create(null) } as never,
        'Board',
      ),
    ).toThrow(ToolValidationError);
  });
});
