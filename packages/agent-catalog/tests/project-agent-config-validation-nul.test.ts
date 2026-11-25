import { describe, expect, it } from 'vitest';
import { validateProjectAgentConfig } from '../src/project-agent-config-validation.js';

describe('validateProjectAgentConfig cwd boundary', () => {
  it('rejects NUL bytes in cwd', () => {
    expect(() => validateProjectAgentConfig({ cwd: 'packages/cli\0/evil' })).toThrow(
      /must stay inside the assigned checkout/i,
    );
    expect(() => validateProjectAgentConfig({ cwd: '\0packages/cli' })).toThrow(
      /must stay inside the assigned checkout/i,
    );
  });
});
