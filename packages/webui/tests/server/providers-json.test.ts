import { describe, expect, it } from 'vitest';
import { createHttpServer } from '@wrongstack/webui-server';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../dist');

// Security scan 2026-08-04, finding H3: the HTTP surface requires a token on
// every bind, including loopback — static assets included.
const TEST_API_TOKEN = 'test-api-token';

describe('providers.json static file serving', () => {
  it('should have providers.json in dist folder', async () => {
    const providersPath = path.join(distDir, 'providers.json');
    const content = await fs.readFile(providersPath, 'utf8');
    const providers = JSON.parse(content);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]).toHaveProperty('id');
    expect(providers[0]).toHaveProperty('name');
    expect(providers[0]).toHaveProperty('family');
  });

  it('should serve providers.json with correct MIME type', async () => {
    const server = createHttpServer({
      host: '127.0.0.1',
      distDir,
      apiToken: TEST_API_TOKEN,
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/providers.json`, {
        headers: { 'x-ws-token': TEST_API_TOKEN },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');

      const providers = await res.json();
      const expectedProviders = JSON.parse(
        await fs.readFile(path.join(distDir, 'providers.json'), 'utf8'),
      );
      expect(Array.isArray(providers)).toBe(true);
      expect(providers).toEqual(expectedProviders);

      // Check referral data is present
      const minimax = providers.find(
        (p: { id: string; referral?: { code: string; reward: string; url: string } }) =>
          p.id === 'minimax',
      );
      if (!minimax) throw new Error('minimax provider not found in providers.json');
      expect(minimax.referral).toBeDefined();
      expect(minimax.referral!.code).toBe('JrA4R9QAEn');
      expect(minimax.referral!.reward).toContain('10% off');
    } finally {
      server.close();
    }
  });

  it('should validate providers.json schema', async () => {
    const providersPath = path.join(distDir, 'providers.json');
    const content = await fs.readFile(providersPath, 'utf8');
    const providers = JSON.parse(content);

    for (const provider of providers) {
      expect(provider).toHaveProperty('id');
      expect(provider).toHaveProperty('name');
      expect(provider).toHaveProperty('description');
      expect(provider).toHaveProperty('icon');
      expect(provider).toHaveProperty('color');
      expect(provider).toHaveProperty('keyPlaceholder');
      expect(provider).toHaveProperty('family');
      expect(typeof provider.id).toBe('string');
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.family).toBe('string');

      // If referral exists, validate its structure
      if (provider.referral) {
        expect(provider.referral).toHaveProperty('code');
        expect(provider.referral).toHaveProperty('reward');
        expect(provider.referral).toHaveProperty('url');
        expect(typeof provider.referral.code).toBe('string');
        expect(typeof provider.referral.reward).toBe('string');
        expect(typeof provider.referral.url).toBe('string');
      }
    }
  });
});
