import { describe, expect, it } from 'vitest';
import { truncateShellCommandWarningCommand } from '../src/components/shell-command-warning.js';

// Pure helper coverage keeps the prompt layout contract stable without needing
// a brittle full Ink render: long shell commands should not blow out the TUI.
describe('truncateShellCommandWarningCommand', () => {
  it('keeps short commands unchanged', () => {
    expect(truncateShellCommandWarningCommand('git status')).toBe('git status');
  });

  it('truncates long commands to the requested width with an ellipsis', () => {
    const command = 'x'.repeat(100);
    const rendered = truncateShellCommandWarningCommand(command, 12);

    expect(rendered).toBe(`${'x'.repeat(11)}…`);
    expect(rendered.length).toBe(12);
  });

  it('uses the prompt default width of 80 columns', () => {
    const command = 'x'.repeat(100);
    const rendered = truncateShellCommandWarningCommand(command);

    expect(rendered.length).toBe(80);
    expect(rendered.endsWith('…')).toBe(true);
  });
});
