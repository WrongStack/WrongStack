import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AutomationJobRecord,
  automationRequest,
  editableAutomationJob,
} from '../src/automation.js';
import { type CodeAssistPreset, codeAssistAllowsEdits } from '../src/code-assist.js';

afterEach(() => vi.unstubAllGlobals());
describe('Code Assist edit authority', () => {
  it('keeps analysis presets read-only even when a general edit toggle is supplied', () => {
    const presets: CodeAssistPreset[] = [
      'overview',
      'explain',
      'quality',
      'bugs',
      'security',
      'tests',
      'impact',
    ];
    for (const preset of presets) {
      expect(codeAssistAllowsEdits(preset, false)).toBe(false);
      expect(codeAssistAllowsEdits(preset, true)).toBe(false);
    }
  });
  it('requires custom opt-in and recognizes the explicit fix operation', () => {
    expect(codeAssistAllowsEdits('custom', false)).toBe(false);
    expect(codeAssistAllowsEdits('custom', true)).toBe(true);
    expect(codeAssistAllowsEdits('fix', false)).toBe(true);
    expect(codeAssistAllowsEdits('fix', true)).toBe(true);
  });
});
describe('automation HTTP request contract', () => {
  it('drops generated job identity and isolates nested edit state from the stored record', () => {
    const job: AutomationJobRecord = {
      id: 'stored',
      revision: 2,
      projectRoot: '/project',
      createdAt: 1,
      nextRunAt: null,
      name: 'Review',
      image: 'trusted:1',
      prompt: 'Review work',
      envNames: ['EXPLICIT_NAME'],
      yolo: false,
      enabled: true,
      timeoutMs: 1000,
      credentials: [{ profile: 'default', provider: 'test', keyLabel: 'selected', envName: 'KEY' }],
      schedule: { type: 'cron', expression: '0 9 * * 1-5', timezone: 'Europe/Kiev' },
      github: { repository: 'owner/repo', events: ['push'], secretEnv: 'HOOK_KEY' },
    };
    const editable = editableAutomationJob(job);
    for (const generated of ['id', 'revision', 'projectRoot', 'createdAt', 'nextRunAt'])
      expect(editable).not.toHaveProperty(generated);
    editable.envNames.push('ANOTHER');
    editable.credentials![0]!.keyLabel = 'changed';
    editable.schedule!.timezone = 'UTC';
    editable.github!.events.push('issues');
    expect(job.envNames).toEqual(['EXPLICIT_NAME']);
    expect(job.credentials![0]!.keyLabel).toBe('selected');
    expect(job.schedule!.timezone).toBe('Europe/Kiev');
    expect(job.github!.events).toEqual(['push']);
  });
  const stub = (status = 200, value: object = { ok: true }) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(JSON.stringify(value), { status }));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  it('preserves session identity when the resource already has a query string', async () => {
    const fetch = stub();
    await automationRequest('state?limit=2', 'GET', undefined, undefined, 'session/with & query');
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/automation/state?limit=2&sessionId=session%2Fwith%20%26%20query',
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include', method: 'GET' });
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('body');
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });
  it('sends run idempotency, body, cancellation and an encoded session target', async () => {
    const fetch = stub();
    // Plain-HTTP (non-secure) context: no UUID helper, only getRandomValues (#415).
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab),
    });
    const signal = new AbortController().signal;
    const body = { expectedRevision: 1 };
    expect(await automationRequest('jobs/id/run', 'POST', body, signal, 'session/a')).toEqual({
      ok: true,
    });
    expect(fetch.mock.calls[0]).toEqual([
      '/api/automation/jobs/id/run?sessionId=session%2Fa',
      {
        method: 'POST',
        credentials: 'include',
        signal,
        headers: { 'content-type': 'application/json', 'idempotency-key': 'ab'.repeat(16) },
        body: JSON.stringify(body),
      },
    ]);
  });
  it('uses the default read method without inventing a session or run token', async () => {
    const fetch = stub();
    await automationRequest('state');
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/automation/state');
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ 'content-type': 'application/json' });
  });
  it('reports an API refusal and a status fallback separately from a successful response', async () => {
    stub(409, { error: 'Revision changed' });
    await expect(automationRequest('jobs')).rejects.toThrow('Revision changed');
    stub(503, {});
    await expect(automationRequest('state')).rejects.toThrow('Automation request failed (503)');
  });
  it('shows the message of an error object and falls back when it is blank or absent', async () => {
    stub(422, { error: { message: 'Schedule is invalid', code: 'bad_schedule' } });
    await expect(automationRequest('jobs')).rejects.toThrow('Schedule is invalid');
    stub(422, { error: { message: '   ' } });
    await expect(automationRequest('jobs')).rejects.toThrow('Automation request failed (422)');
    stub(500, { error: { code: 'internal' } });
    await expect(automationRequest('jobs')).rejects.toThrow('Automation request failed (500)');
    stub(500, { error: null });
    await expect(automationRequest('jobs')).rejects.toThrow('Automation request failed (500)');
  });
  it('reports the status for a non-JSON failure body instead of a JSON parse error', async () => {
    // A reverse-proxy HTML error page used to reject with a bare SyntaxError
    // from response.json(), losing both the status and the server error.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    await expect(automationRequest('state')).rejects.toThrow('Automation request failed (502)');
  });
  it('rejects a non-JSON success body with the contract error, never SyntaxError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('', { status: 200 })),
    );
    const error = await automationRequest('state').then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('non-JSON response body');
    expect(error).not.toBeInstanceOf(SyntaxError);
  });
});
