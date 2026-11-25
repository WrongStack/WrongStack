import { describe, expect, it } from 'vitest';
import { clearMemoryEvidenceList, setMemoryEvidenceList } from '../src/core/context-evidence.js';

describe('clearMemoryEvidenceList source trimming', () => {
  it('trims source consistently with setMemoryEvidenceList', () => {
    const list = setMemoryEvidenceList([], ' sage.tool-memory ', 'evidence text');
    expect(list).toHaveLength(1);
    expect(clearMemoryEvidenceList(list, '  sage.tool-memory  ')).toEqual([]);
  });
});
