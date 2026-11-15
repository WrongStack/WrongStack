import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationGitHubAPI } from '../src/automation/pull-request-api.js';

describe('AutomationGitHubAPI empty and malformed response handling (F372)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null on HTTP 204 No Content instead of throwing missing body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204, statusText: 'No Content' }),
    );
    const api = new AutomationGitHubAPI('ghp_testtoken123');
    await expect(api.request('owner/repo/pulls/1')).resolves.toBeNull();
  });

  it('throws contextual error on invalid JSON body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 200 }),
    );
    const api = new AutomationGitHubAPI('ghp_testtoken123');
    await expect(api.request('owner/repo/pulls/1')).rejects.toThrow(
      'GitHub returned invalid JSON (200)',
    );
  });
});
