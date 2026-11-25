import { describe, expect, it } from 'vitest';
import {
  clearProviderReportedMaxOutputs,
  providerReportedMaxOutput,
  recordProviderReportedMaxOutput,
} from '../src/types/provider-output-caps.js';

describe('provider-output-caps blank id guard (F2283)', () => {
  it('rejects whitespace-only providerId/modelId and trims valid ids', () => {
    clearProviderReportedMaxOutputs();
    expect(recordProviderReportedMaxOutput('   ', '   ', 4096)).toBe(false);
    expect(recordProviderReportedMaxOutput(' openai ', ' gpt-4o ', 4096)).toBe(true);
    expect(providerReportedMaxOutput('openai', 'gpt-4o')).toBe(4096);
    clearProviderReportedMaxOutputs();
  });
});
