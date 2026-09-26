import { describe, expect, it } from 'vitest';
import { applyGoalTuiDefault } from '../src/boot/goal-tui-default.js';

/**
 * `--goal` / `--ask` open the TUI. The decision has to be made in boot, before
 * cli-main derives screen ownership and the HQ client kind from `flags.tui` —
 * made later, a goal run painted the TUI but reported itself to HQ as `cli`.
 */
describe('applyGoalTuiDefault', () => {
  it('turns the TUI on for a bare --goal or --ask', () => {
    const goal: Record<string, string | boolean> = { goal: 'ship it' };
    applyGoalTuiDefault(goal, []);
    expect(goal['tui']).toBe(true);
    const ask: Record<string, string | boolean> = { ask: 'why?' };
    applyGoalTuiDefault(ask, []);
    expect(ask['tui']).toBe(true);
  });

  it('leaves one-shot runs alone', () => {
    const positional: Record<string, string | boolean> = { goal: 'x' };
    applyGoalTuiDefault(positional, ['do this']);
    expect(positional['tui']).toBeUndefined();
    const prompt: Record<string, string | boolean> = { goal: 'x', prompt: 'do this' };
    applyGoalTuiDefault(prompt, []);
    expect(prompt['tui']).toBeUndefined();
  });

  it('does nothing without --goal or --ask', () => {
    const flags: Record<string, string | boolean> = {};
    applyGoalTuiDefault(flags, []);
    expect(flags['tui']).toBeUndefined();
  });
});
