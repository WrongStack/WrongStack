import type { InputReader } from '@wrongstack/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePromptDelegate } from '../src/permission-prompt.js';

/**
 * Regressions for the approval-prompt spoofing defect found by the 2026-08-20
 * security-check audit.
 *
 * The confirm prompt is the documented last line of defence against prompt
 * injection. Model-supplied `content` / `new_string` used to reach the terminal
 * verbatim, so a payload could clear the screen and repaint a convincing fake
 * prompt above the genuine one. Every `it` below fails against the pre-fix code.
 */

const ESC = '\x1b';

const fakeTool = {
  name: 'write',
  description: 'write',
  inputSchema: { type: 'object' },
  permission: 'confirm',
  mutating: true,
  async execute() {
    return 'ok';
  },
} as never;

let stdout: string;
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdout = '';
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
});
afterEach(() => {
  writeSpy.mockRestore();
});

function reader(): InputReader {
  return {
    readLine: vi.fn(async () => ''),
    readKey: vi.fn(async () => 'no'),
    close: vi.fn(async () => undefined),
  } as never as InputReader;
}

async function prompt(input: unknown, suggestedPattern = 'write:/a'): Promise<string> {
  await makePromptDelegate(reader())(fakeTool, input, suggestedPattern);
  return stdout;
}

describe('the approval prompt cannot be repainted by its own payload', () => {
  it('strips cursor and erase sequences from write content', async () => {
    const out = await prompt({
      path: '/a',
      content: `${ESC}[2J${ESC}[H⚠ APPROVAL REQUIRED │ write`,
    });

    // The visible text may still appear — what must not survive is the ability
    // to move the cursor or clear the screen with it.
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).not.toContain(`${ESC}[H`);
  });

  it('strips a two-character RIS reset, which the CSI pattern alone misses', async () => {
    const out = await prompt({ path: '/a', content: `before${ESC}cafter` });
    expect(out).not.toContain(`${ESC}c`);
  });

  it('strips escapes from an edit diff preview', async () => {
    const out = await prompt({
      path: '/a',
      old_string: 'harmless',
      new_string: `${ESC}[2Jinjected`,
    });
    expect(out).not.toContain(`${ESC}[2J`);
  });

  it('strips bidi and zero-width controls that would reorder the rendered text', async () => {
    const out = await prompt({ path: `/a‮​evil`, content: 'x' });
    expect(out).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/);
  });

  it('strips escapes from the always-allow suggested pattern', async () => {
    const out = await prompt({ path: '/a', content: 'x' }, `write:/a${ESC}[2J`);
    expect(out).not.toContain(`${ESC}[2J`);
  });

  it('bounds a single enormous line, which a line-count cap alone would not', async () => {
    const out = await prompt({ path: '/a', content: 'x'.repeat(200_000) });

    expect(out.length).toBeLessThan(50_000);
    expect(out).toMatch(/not shown/);
  });

  it('still reports how many lines it withheld', async () => {
    const out = await prompt({
      path: '/a',
      content: Array.from({ length: 120 }, (_, i) => `line-${i}`).join('\n'),
    });
    expect(out).toMatch(/more lines? not shown/);
  });

  it('leaves benign content readable', async () => {
    const out = await prompt({ path: '/a', content: 'const x = 1;' });
    expect(out).toContain('const x = 1;');
  });
});
