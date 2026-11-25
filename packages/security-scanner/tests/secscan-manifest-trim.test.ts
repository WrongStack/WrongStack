import { describe, expect, it } from 'vitest';
import { parseNodeDependencies } from '../src/manifest-parser.js';

describe('parseNodeDependencies name/version trimming (F2260)', () => {
  it('trims padded dependency names and versions so duplicates merge cleanly', () => {
    const deps = parseNodeDependencies(
      JSON.stringify({
        devDependencies: { ' lodash ': ' 4.17.20 ' },
        dependencies: { lodash: '4.17.21' },
      }),
    );
    expect(deps).toEqual([{ name: 'lodash', version: '4.17.21', isDev: false }]);
  });
});
