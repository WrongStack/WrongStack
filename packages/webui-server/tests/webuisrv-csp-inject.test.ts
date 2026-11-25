import { describe, expect, it } from 'vitest';
import { integrationConnectSources } from '../src/server/http-server/integration-connect-src.js';

describe('integrationConnectSources CSP injection guard (F2282)', () => {
  it('drops URLs containing CSP delimiters and emits canonical HTTP(S) origins only', () => {
    expect(
      integrationConnectSources({ hq: { url: 'http://localhost:3000; script-src *' } } as never),
    ).toEqual([]);
    expect(
      integrationConnectSources({ hq: { url: 'http://localhost:3000/api' } } as never),
    ).toEqual(['http://localhost:3000']);
  });
});
