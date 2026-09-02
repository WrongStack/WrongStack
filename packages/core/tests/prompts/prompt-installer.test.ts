/**
 * Tests for PromptInstaller — registry sync groundwork.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PromptInstaller } from '../../src/prompts/prompt-installer.js';

// ============================================================================
// PromptInstaller Tests
// ============================================================================

describe('PromptInstaller', () => {
  describe('constructor', () => {
    it('should create instance without options', () => {
      const installer = new PromptInstaller();
      expect(installer).toBeInstanceOf(PromptInstaller);
    });

    it('should accept custom fetcher', () => {
      const fetcher = vi.fn();
      const installer = new PromptInstaller({ fetcher });
      expect(installer).toBeInstanceOf(PromptInstaller);
    });

    it('should use default fetcher when no options provided', () => {
      const installer = new PromptInstaller();
      expect(installer).toBeInstanceOf(PromptInstaller);
    });
  });

  describe('default fetcher', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should use global fetch by default', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            version: 1,
            registryVersion: 1,
            source: 'test',
            generatedAt: '2026-01-01T00:00:00.000Z',
            prompts: [],
          }),
      });
      const installer = new PromptInstaller();
      const result = await installer.pull('https://example.com/reg.json', []);
      expect(result.manifest).toBeDefined();
      expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/reg.json');
    });

    it('should throw FetchError when fetch responds with non-ok', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });
      const installer = new PromptInstaller();
      await expect(installer.pull('https://example.com/missing.json', [])).rejects.toThrow();
    });
  });

  describe('pull', () => {
    const validManifest = {
      version: 1,
      registryVersion: 1,
      source: 'test-registry',
      generatedAt: '2026-01-01T00:00:00.000Z',
      prompts: [
        {
          id: 'test-prompt',
          slug: 'test-prompt',
          title: 'Test Prompt',
          description: 'A test prompt',
          category: 'general',
          tags: ['test'],
          checksum: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd',
        },
      ],
    };

    it('should fetch and return manifest with empty diff when up-to-date', async () => {
      const fetcher = vi.fn().mockResolvedValue(validManifest);
      const installer = new PromptInstaller({ fetcher });
      const result = await installer.pull('https://example.com/registry.json', [
        {
          slug: 'test-prompt',
          checksum: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd',
        },
      ]);
      expect(result.manifest).toBeDefined();
      expect(result.dryRun).toBe(true);
      expect(fetcher).toHaveBeenCalledWith('https://example.com/registry.json');
    });

    it('should report diffs when checksums differ', async () => {
      const fetcher = vi.fn().mockResolvedValue(validManifest);
      const installer = new PromptInstaller({ fetcher });
      const result = await installer.pull('https://example.com/registry.json', [
        {
          slug: 'test-prompt',
          checksum: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      ]);
      expect(result.diff).toBeDefined();
    });

    it('should throw ParseError for invalid manifest', async () => {
      const fetcher = vi.fn().mockResolvedValue({ invalid: true });
      const installer = new PromptInstaller({ fetcher });
      await expect(installer.pull('https://example.com/bad.json', [])).rejects.toThrow();
    });

    it('should handle empty local prompts', async () => {
      const fetcher = vi.fn().mockResolvedValue({
        ...validManifest,
        prompts: [],
      });
      const installer = new PromptInstaller({ fetcher });
      const result = await installer.pull('https://example.com/registry.json', []);
      expect(result.manifest.prompts).toHaveLength(0);
    });
  });

  describe('install', () => {
    it('should throw not-implemented error', async () => {
      const installer = new PromptInstaller();
      await expect(installer.install()).rejects.toThrow('not implemented');
    });
  });
});
