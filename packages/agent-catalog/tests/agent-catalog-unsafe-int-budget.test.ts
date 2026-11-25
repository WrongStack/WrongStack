import { describe, expect, it } from 'vitest';
import { validateProjectAgentConfig } from '../src/project-agent-config-validation.js';

describe('validateProjectAgentConfig safe integer budget guard (F2267)', () => {
  it('rejects non-safe-integer budget values such as 1e30', () => {
    expect(() => validateProjectAgentConfig({ budget: { timeoutMs: 1e30 } })).toThrow();
  });
});
