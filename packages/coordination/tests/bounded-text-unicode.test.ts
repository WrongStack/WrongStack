import { expect, it } from 'vitest';
import { boundedText, completedToolReceipt } from '../src/agent-status-helpers.js';

it('does not split an astral character at the status-text cap', () => {
  expect(boundedText('ab😀tail', 4)).toBe('ab…');
});

/** True when `value` contains an unpaired UTF-16 surrogate code unit. */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    }
  }
  return false;
}

// 'x' occupies indices 0..357, U+1F600 its surrogate pair 358..359; the tail
// pushes the length past TOOL_TEXT_CAP (360) so the cap path runs.
const astralAtCap = `${'x'.repeat(358)}\u{1F600}${'y'.repeat(10)}`;

it('does not split an astral character in a completed-tool receipt output', () => {
  const receipt = completedToolReceipt({ name: 'write', output: astralAtCap });
  expect(receipt.output).toBeDefined();
  expect(receipt.output!.endsWith('…')).toBe(true);
  expect(receipt.output!.length).toBeLessThanOrEqual(360);
  expect(hasLoneSurrogate(receipt.output!)).toBe(false);
});

it('does not split an astral character in a compacted tool-input value', () => {
  const receipt = completedToolReceipt({ name: 'terminal', input: { command: astralAtCap } });
  const command = (receipt.input as { command: string }).command;
  expect(command.endsWith('…')).toBe(true);
  expect(hasLoneSurrogate(command)).toBe(false);
});

it('keeps an ASCII boundary at the cap well-formed', () => {
  const receipt = completedToolReceipt({
    name: 'write',
    output: `${'a'.repeat(359)}b${'c'.repeat(10)}`,
  });
  expect(receipt.output!.endsWith('…')).toBe(true);
  expect(receipt.output!.length).toBeLessThanOrEqual(360);
  expect(hasLoneSurrogate(receipt.output!)).toBe(false);
});
