import type { Tool } from '@wrongstack/contracts/types/tool';
import { describe, expect, it } from 'vitest';
import {
  DefaultSystemPromptBuilder,
  SYSTEM_BLOCK_SOURCE,
} from '../../src/core/system-prompt-builder.js';

const make = (name: string, description: string, category?: string): Tool => ({
  name,
  description,
  ...(category ? { category } : {}),
  permission: 'auto',
  mutating: false,
  inputSchema: { type: 'object' },
  async execute() {
    return '';
  },
});

describe('tool hint budgets', () => {
  it.each([undefined, 'Review'])(
    'bounds a long first sentence for category %s',
    async (category) => {
      const long = make('budget_long', 'A'.repeat(240) + '. Second sentence.', category);
      const short = make('budget_short', 'Short.', category);
      const at = async (tier: 'aggressive' | 'minimal') => {
        const b = new DefaultSystemPromptBuilder({ tokenSavingMode: tier, injectMemory: false });
        const blocks = await b.build({
          cwd: process.cwd(),
          projectRoot: process.cwd(),
          tools: [long, short],
        });
        return blocks.find((block) => SYSTEM_BLOCK_SOURCE.get(block) === 'tool-usage')?.text ?? '';
      };
      const aggressive = await at('aggressive');
      const minimal = await at('minimal');
      expect(aggressive).toContain('Short.');
      expect(aggressive).toContain('A'.repeat(20) + '…');
      expect(aggressive).not.toContain('A'.repeat(21));
      expect(minimal).toContain('A'.repeat(30) + '…');
      expect(minimal.length).toBeGreaterThan(aggressive.length);
    },
  );

  it('keeps a short sentence boundary and a Unicode character intact', async () => {
    const tools = [
      make('sentence', 'First sentence. ' + 'A'.repeat(100), 'Review'),
      make('unicode', 'A'.repeat(19) + '😀' + 'B'.repeat(100), 'Review'),
    ];
    const b = new DefaultSystemPromptBuilder({
      tokenSavingMode: 'aggressive',
      injectMemory: false,
    });
    const blocks = await b.build({ cwd: process.cwd(), projectRoot: process.cwd(), tools });
    const text =
      blocks.find((block) => SYSTEM_BLOCK_SOURCE.get(block) === 'tool-usage')?.text ?? '';
    expect(text).toContain('First sentence.…');
    expect(text).toContain('A'.repeat(19) + '…');
    expect(text).not.toContain('\ud83d');
  });
});
