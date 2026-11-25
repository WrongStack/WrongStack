import type { Config } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { integrationConnectSources } from '../src/server/http-server/integration-connect-src.js';

describe('integrationConnectSources URL trimming', () => {
  it('returns trimmed HQ and WrongProxy URLs', () => {
    const sources = integrationConnectSources({
      hq: { url: '  http://127.0.0.1:8787  ' },
      tools: { wrongProxy: { url: '\thttp://127.0.0.1:9000\n' } },
    } as unknown as Config);
    expect(sources).toEqual(['http://127.0.0.1:8787', 'http://127.0.0.1:9000']);
  });
});
