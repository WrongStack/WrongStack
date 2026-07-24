import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/redaction-diagnostic.js', () => ({
  runRedactionDiagnostic: () => ({ redactedFields: [], unchangedFields: [] }),
}));

import { createSecuritySlashCommand } from '../src/slash-command.js';

describe('redaction diagnostic failure presentation', () => {
  it('warns when the diagnostic scrubber redacts no fields', async () => {
    const result = await createSecuritySlashCommand().run('redact-test', {} as never);
    expect(result?.message).toContain('No synthetic secret fields were redacted');
  });
});
