/**
 * The approval dialog's pending-edit diff (the content the user approves)
 * through the real DiffBlock and Ink renderer. The summary and write targets
 * were already stripped of bidi/invisible characters; the diff was not, so a
 * model-chosen `new_string` could show the user text that differs from what
 * will be written.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmPrompt } from '../src/components/confirm-prompt.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const HIDDEN = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;

async function frame(input: Record<string, unknown>): Promise<string> {
  const view = renderRealTty(
    React.createElement(ConfirmPrompt, {
      toolName: 'edit',
      input,
      suggestedPattern: 'edit',
      onDecision: vi.fn(),
      onEnableYolo: vi.fn(),
    }),
    { columns: 120, rows: 60 },
  );
  await settle();
  const out = view.lastFrame();
  view.unmount();
  return out;
}

describe('ConfirmPrompt diff preview', () => {
  it('strips bidi overrides and invisible text from the diff being approved', async () => {
    const tag = String.fromCodePoint(0xe0041);
    const out = await frame({
      path: 'src/run.ts',
      old_string: 'const ok = true;',
      new_string: `const ok = false; // ‮eurt = ko${tag}`,
    });
    expect(out).toContain('const ok = false;');
    expect(out).not.toMatch(HIDDEN);
  });

  it('strips them from a whole-file write preview too', async () => {
    const out = await frame({ path: 'notes.md', content: `hello⁦ world${'​'}` });
    expect(out).toContain('hello');
    expect(out).not.toMatch(HIDDEN);
  });
});
