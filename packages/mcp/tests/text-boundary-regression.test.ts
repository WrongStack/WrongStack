import { describe, expect, it } from 'vitest';
import {
  MCP_INSTRUCTIONS_MAX_CHARS,
  mcpServerInstructionsSection,
} from '../src/server-instructions.js';
import { normalizeMCPTools } from '../src/tool-schema.js';

const hasLoneSurrogate = (value: string): boolean =>
  [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character));

describe('MCP untrusted text boundaries', () => {
  it('does not split an annotation title at its cap', () => {
    const title = normalizeMCPTools([
      {
        name: 'demo',
        inputSchema: {},
        annotations: { title: `${'a'.repeat(511)}😀tail` },
      },
    ])[0]?.annotations?.title;
    expect(title).toBe('a'.repeat(511));
    expect(hasLoneSurrogate(title ?? '')).toBe(false);
  });

  it('does not split server instructions at their cap', () => {
    const section = mcpServerInstructionsSection({
      list: () => [{ name: 'demo' }],
      getCatalog: () => ({
        serverMetadata: {
          instructions: `${'a'.repeat(MCP_INSTRUCTIONS_MAX_CHARS - 1)}😀tail`,
        },
      }),
    });
    expect(section).toContain('[instructions truncated]');
    expect(hasLoneSurrogate(section ?? '')).toBe(false);
  });
});
