/**
 * Edge-case tests for src/lib/favicon.ts — SSR guard (document undefined),
 * ensureLink returning null, and visibility reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('favicon — SSR guard (line 46, 62)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing when document is undefined (SSR)', async () => {
    vi.stubGlobal('document', undefined);
    const { setFaviconStatus, installFaviconVisibilityReset } = await import(
      '../../src/lib/favicon'
    );
    // ensureLink returns null → setFaviconStatus returns early
    expect(() => setFaviconStatus('running')).not.toThrow();
    // installFaviconVisibilityReset returns early (typeof document === 'undefined')
    expect(() => installFaviconVisibilityReset()).not.toThrow();
  });

  it('installFaviconVisibilityReset is idempotent', async () => {
    const { installFaviconVisibilityReset, setFaviconStatus } = await import(
      '../../src/lib/favicon'
    );
    // Call twice — second call should early-return on visibilityHookInstalled
    installFaviconVisibilityReset();
    installFaviconVisibilityReset();
    // Should still work
    setFaviconStatus('idle');
    expect(document.querySelector('link[rel="icon"]')).toBeTruthy();
  });

  it('resets from "ready" status when tab becomes visible', async () => {
    const { installFaviconVisibilityReset, setFaviconStatus } = await import(
      '../../src/lib/favicon'
    );
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    setFaviconStatus('ready');
    installFaviconVisibilityReset();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    // After reset, the badge SVG should be empty (idle) — no amber/green/red/amber
    expect(decodeURIComponent(link?.href ?? '')).not.toContain('#22c55e');
  });

  it('resets from "error" status when tab becomes visible', async () => {
    const { installFaviconVisibilityReset, setFaviconStatus } = await import(
      '../../src/lib/favicon'
    );
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    setFaviconStatus('error');
    installFaviconVisibilityReset();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(decodeURIComponent(link?.href ?? '')).not.toContain('#ef4444');
  });

  it('resets from "attention" status when tab becomes visible', async () => {
    const { installFaviconVisibilityReset, setFaviconStatus } = await import(
      '../../src/lib/favicon'
    );
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    setFaviconStatus('attention');
    installFaviconVisibilityReset();

    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(decodeURIComponent(link?.href ?? '')).not.toContain('#eab308');
  });
});
