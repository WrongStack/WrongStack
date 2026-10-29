import { expect, it } from 'vitest';
import { vectorTags } from '../src/VectorMemoryEntries';

it('reads tags separated by commas or lines without blanks or repeats', () => {
  expect(vectorTags(' api, auth ,\n\napi,  ')).toEqual(['api', 'auth']);
  expect(vectorTags('')).toEqual([]);
});
