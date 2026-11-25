import { describe, expect, it } from 'vitest';
import { errorToJsonRpc, parseMcpServers } from '../src/agent/protocol-session-ops.js';
import { acpLegacyModelOption, acpRuntimeOptions } from '../src/client/acp-runtime-options.js';
import { acpBenchCoverage } from '../src/integration/acp-bench.js';

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

describe('ACP boundary normalization audit regressions', () => {
  it('does not split surrogate pairs in legacy model names', () => {
    const option = acpLegacyModelOption({
      availableModels: [{ modelId: 'm', name: `${'a'.repeat(1999)}😀` }],
    });
    expect(hasLoneSurrogate(option?.options[0]?.name ?? '')).toBe(false);
  });

  it('bounds top-level runtime option metadata', () => {
    const option = acpRuntimeOptions([
      {
        type: 'select',
        id: 'model',
        name: 'x'.repeat(2001),
        description: 'y'.repeat(2001),
        currentValue: 'm',
        options: [{ value: 'm', name: 'M' }],
      },
    ])[0];
    expect(option?.name.length).toBeLessThanOrEqual(2000);
    expect(option?.description?.length).toBeLessThanOrEqual(2000);
  });

  it('maps non-finite JSON-RPC codes to internal error', () => {
    expect(errorToJsonRpc({ code: Number.POSITIVE_INFINITY, message: 'x' }).code).toBe(-32603);
  });

  it('does not split surrogate pairs in ACP bench samples', () => {
    expect(hasLoneSurrogate(acpBenchCoverage.firstLine(`${'a'.repeat(116)}😀tail`))).toBe(false);
  });

  it('rejects MCP commands containing control characters', () => {
    expect(parseMcpServers([{ name: 'x', command: 'bad\0cmd' }])).toEqual([]);
  });
});
