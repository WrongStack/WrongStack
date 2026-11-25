import { describe, expect, it } from 'vitest';
import { prepareResourceInsertion } from '../src/content-selection.js';

describe('MCP content-selection URI credential guard', () => {
  it('rejects embedded credentials on non-HTTP URI schemes such as git://', () => {
    expect(() =>
      prepareResourceInsertion('srv', 'git://user:secret@github.com/org/repo.git', {
        contents: [{ uri: 'git://user:secret@github.com/org/repo.git', text: 'hi' }],
      }),
    ).toThrow(/credentials/);
  });
});
