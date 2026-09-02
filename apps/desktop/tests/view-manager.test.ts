/**
 * Unit tests for the navigation policy used by the production WebUI controller.
 */
import { describe, it, expect } from 'vitest';
import { allowedExternalProtocol, sameOrigin } from '../src/main/webui/navigation.js';
import { OPEN_EXTERNAL_ALLOWED_PROTOCOLS } from '../src/main/state/constants.js';

// ============================================================================
// safeOpenExternal Tests
// ============================================================================

describe('allowedExternalProtocol', () => {
  it('should return early for invalid URLs', () => {
    // Should not throw for invalid URLs
    expect(allowedExternalProtocol('not-a-url')).toBeUndefined();
  });

  it('should return early for empty string', () => {
    expect(allowedExternalProtocol('')).toBeUndefined();
  });

  it('should handle protocol validation without error', () => {
    // These are valid protocols - function checks and conditionally opens
    expect(allowedExternalProtocol('https://example.com')).toBe('https:');
    expect(allowedExternalProtocol('http://example.com')).toBe('http:');
    expect(allowedExternalProtocol('mailto:test@example.com')).toBe('mailto:');
  });

  it('should handle disallowed protocols without error', () => {
    expect(allowedExternalProtocol('file:///etc/passwd')).toBeUndefined();
    expect(allowedExternalProtocol('javascript:alert(1)')).toBeUndefined();
    expect(allowedExternalProtocol('ftp://example.com')).toBeUndefined();
  });

  it('should handle special characters in URL', () => {
    expect(allowedExternalProtocol('https://example.com/path?q=a b&c=d')).toBe('https:');
    expect(allowedExternalProtocol('https://例子.测试')).toBe('https:');
  });
});

// ============================================================================
// sameOrigin Tests
// ============================================================================

describe('sameOrigin', () => {
  it('should return true for identical origins', () => {
    expect(sameOrigin('https://example.com/page1', 'https://example.com/page2')).toBe(true);
  });

  it('should return false for different origins', () => {
    expect(sameOrigin('https://example.com', 'https://other.com')).toBe(false);
  });

  it('should return false for different schemes', () => {
    expect(sameOrigin('http://example.com', 'https://example.com')).toBe(false);
  });

  it('should return false for different ports', () => {
    expect(sameOrigin('https://example.com:8080', 'https://example.com:9090')).toBe(false);
  });

  it('should return true for same origin default port', () => {
    expect(sameOrigin('https://example.com:443/path', 'https://example.com/other')).toBe(true);
  });

  it('should return false when base URL is null', () => {
    expect(sameOrigin('https://example.com', null)).toBe(false);
  });

  it('should return false for invalid candidate URL', () => {
    expect(sameOrigin('not-a-url', 'https://example.com')).toBe(false);
  });

  it('should return false for invalid base URL', () => {
    expect(sameOrigin('https://example.com', 'not-a-url')).toBe(false);
  });

  it('should handle localhost URLs', () => {
    expect(sameOrigin('http://localhost:3000/page1', 'http://localhost:3000/page2')).toBe(true);
    expect(sameOrigin('http://localhost:3000', 'http://localhost:4000')).toBe(false);
  });

  it('should handle IP address URLs', () => {
    expect(sameOrigin('http://127.0.0.1:8080/test', 'http://127.0.0.1:8080/other')).toBe(true);
    expect(sameOrigin('http://127.0.0.1:8080', 'http://127.0.0.2:8080')).toBe(false);
  });
});

// ============================================================================
// OPEN_EXTERNAL_ALLOWED_PROTOCOLS Tests
// ============================================================================

describe('OPEN_EXTERNAL_ALLOWED_PROTOCOLS', () => {
  it('should allow http protocol', () => {
    expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('http:')).toBe(true);
  });

  it('should allow https protocol', () => {
    expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('https:')).toBe(true);
  });

  it('should allow mailto protocol', () => {
    expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('mailto:')).toBe(true);
  });

  it('should not allow file protocol', () => {
    expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('file:')).toBe(false);
  });

  it('should not allow javascript protocol', () => {
    expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('javascript:')).toBe(false);
  });

  it('should not allow ftp protocol', () => {
    expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.has('ftp:')).toBe(false);
  });

  it('should have exactly 3 allowed protocols', () => {
    expect(OPEN_EXTERNAL_ALLOWED_PROTOCOLS.size).toBe(3);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('URL handling edge cases', () => {
  describe('allowedExternalProtocol', () => {
    it('should handle URLs with credentials', () => {
      expect(allowedExternalProtocol('https://user:pass@example.com')).toBe('https:');
    });

    it('should handle URLs with fragments', () => {
      expect(allowedExternalProtocol('https://example.com/page#section')).toBe('https:');
    });

    it('should handle URLs with query parameters', () => {
      expect(allowedExternalProtocol('https://example.com?key=value&foo=bar')).toBe('https:');
    });
  });

  describe('sameOrigin', () => {
    it('should handle case-insensitive hostnames', () => {
      expect(sameOrigin('https://EXAMPLE.com', 'https://example.com')).toBe(true);
    });

    it('should handle empty candidate URL', () => {
      expect(sameOrigin('', 'https://example.com')).toBe(false);
    });

    it('should handle very long URLs', () => {
      const longPath = '/'.repeat(1000);
      expect(sameOrigin(`https://example.com${longPath}`, 'https://example.com')).toBe(true);
    });

    it('should handle data URLs as base', () => {
      expect(sameOrigin('https://example.com', 'data:text/html,hello')).toBe(false);
    });

    it('should handle blob URLs', () => {
      // blob: URLs have origin of their creator
      expect(sameOrigin('blob:https://example.com/uuid', 'https://example.com')).toBe(true);
    });
  });
});
