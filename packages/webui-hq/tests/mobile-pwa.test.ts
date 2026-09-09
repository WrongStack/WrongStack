import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const publicDir = path.resolve(import.meta.dirname, '../public');

describe('HQ mobile PWA', () => {
  it('starts in the password-only mobile route', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'),
    ) as { start_url?: string; scope?: string; display?: string };

    expect(manifest.start_url).toBe('/mobile');
    expect(manifest.scope).toBe('/mobile');
    expect(manifest.display).toBe('standalone');
  });

  it('never caches API, WebSocket or authenticated data responses', () => {
    const worker = readFileSync(path.join(publicDir, 'mobile-sw.js'), 'utf8');
    expect(worker).toContain("url.pathname.startsWith('/api/')");
    expect(worker).toContain("url.pathname.startsWith('/ws/')");
    expect(worker).not.toMatch(/cache\.put\([^)]*(?:api|transcript|auth)/i);
    expect(worker).toContain("url.pathname.startsWith('/assets/')");
    expect(worker).toContain("self.addEventListener('notificationclick'");
    expect(worker).toContain("self.clients.openWindow('/mobile')");
  });
});
