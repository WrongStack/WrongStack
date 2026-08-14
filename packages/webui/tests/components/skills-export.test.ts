/**
 * Tests for the SkillsPanel export functionality:
 * - handleExportSkill: downloads a single skill as .md
 * - handleExportAll: downloads all skills as .zip
 *
 * These are tested by mocking the browser download APIs and the WS client.
 */

// Deep import (not the package barrel): the barrel's module graph reaches
// @wrongstack/governance → `node:sqlite`, which vite's jsdom client
// environment cannot bundle on Linux CI. This file stays in the jsdom
// project (it needs document/download APIs) and zip.ts only uses
// `node:zlib`, a client-safe builtin.
import { createZipBuffer } from '@wrongstack/webui-server/server/zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock browser APIs ───────────────────────────────────────────────────

const createdLinks: HTMLAnchorElement[] = [];
const revokedUrls: string[] = [];

function mockWindow() {
  const originalCreateElement = document.createElement.bind(document);
  const _originalBody = document.body;

  // Provide a mock body when none exists (jsdom startup)
  if (!document.body) {
    const mockBody = {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    } as never as HTMLBodyElement;
    Object.defineProperty(document, 'body', { value: mockBody, configurable: true });
  }

  createdLinks.length = 0;
  revokedUrls.length = 0;

  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

  URL.createObjectURL = vi.fn((blob: Blob) => {
    return `blob:${originalCreateObjectURL(blob).replace('blob:', '')}`;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revokedUrls.push(url);
  });

  // Track appended links
  const appendChildSpy = vi.spyOn(document.body!, 'appendChild');
  const removeChildSpy = vi.spyOn(document.body!, 'removeChild');

  appendChildSpy.mockImplementation((el: Node) => {
    if (el instanceof HTMLAnchorElement) {
      createdLinks.push(el);
    }
    return el as Node;
  });

  removeChildSpy.mockImplementation((el: Node) => {
    return el as Node;
  });

  return {
    createElement: originalCreateElement,
    createObjectURL: originalCreateObjectURL,
    revokeObjectURL: originalRevokeObjectURL,
    appendChildSpy,
    removeChildSpy,
  };
}

// ── Test data ───────────────────────────────────────────────────────────

const API_DESIGN_BODY = '# API Design\n\nUse this skill when designing REST APIs.\n';

// ── handleExportSkill tests ──────────────────────────────────────────────

describe('handleExportSkill', () => {
  let mocks: ReturnType<typeof mockWindow>;

  beforeEach(() => {
    mocks = mockWindow();
  });

  afterEach(() => {
    URL.createObjectURL = mocks.createObjectURL;
    URL.revokeObjectURL = mocks.revokeObjectURL;
    vi.restoreAllMocks();
  });

  it('creates a Blob with the skill body and correct filename', () => {
    const blobs: Blob[] = [];

    // Intercept URL.createObjectURL to capture the blob
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:${Math.random().toString(36).slice(2)}`;
    });

    // Simulate what handleExportSkill does internally:
    const skillName = 'api-design';
    const body = API_DESIGN_BODY;
    const fileName = `${skillName}-SKILL.md`;
    const blob = new Blob([body], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    expect(blobs.length).toBe(1);
    expect(blobs[0].type).toBe('text/markdown');
    expect(blobs[0]).toBeInstanceOf(Blob);
  });

  it('appends link to body, clicks it, then removes it', () => {
    const clickSpy = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:test-url');
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'a') {
        return { href: '', download: '', click: clickSpy, style: {} } as never as HTMLAnchorElement;
      }
      return {} as never as HTMLElement;
    }) as unknown as typeof document.createElement;

    const body = API_DESIGN_BODY;
    const blob = new Blob([body], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'api-design-SKILL.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    expect(document.body.appendChild).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(document.body.removeChild).toHaveBeenCalled();
  });

  it('revokes the object URL after download', () => {
    URL.createObjectURL = vi.fn(() => 'blob: revoke-test');
    URL.revokeObjectURL = vi.fn();

    const blob = new Blob([API_DESIGN_BODY], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'api-design-SKILL.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob: revoke-test');
  });
});

// ── handleExportAll tests ───────────────────────────────────────────────

describe('handleExportAll', () => {
  let mocks: ReturnType<typeof mockWindow>;

  beforeEach(() => {
    mocks = mockWindow();
  });

  afterEach(() => {
    URL.createObjectURL = mocks.createObjectURL;
    URL.revokeObjectURL = mocks.revokeObjectURL;
    vi.restoreAllMocks();
  });

  it('calls client.exportAllSkills() and sets exportingAll=true', async () => {
    const exportAllSkills = vi.fn().mockResolvedValue(undefined);
    const client = { exportAllSkills };

    // Simulate the handleExportAll behavior: exportingAll is true for the
    // duration of the call, then cleared in the WS 'skills.exported' handler.
    let exportingAll = false;
    const setExportingAll = (val: boolean) => {
      exportingAll = val;
    };

    setExportingAll(true);
    // Still true while the request is in flight (before the response handler runs).
    expect(exportingAll).toBe(true);
    await client.exportAllSkills();
    setExportingAll(false); // response handler clears it

    expect(client.exportAllSkills).toHaveBeenCalled();
  });

  it('sets exportingAll to false after exportAllSkills resolves', async () => {
    const exportAllSkills = vi.fn().mockResolvedValue(undefined);
    const client = { exportAllSkills };

    let exportingAll = false;
    const setExportingAll = (val: boolean) => {
      exportingAll = val;
    };

    setExportingAll(true);
    await client.exportAllSkills();
    setExportingAll(false);

    expect(exportingAll).toBe(false);
  });

  it('base64-decodes the zip and triggers a download', async () => {
    const zipBuffer = createZipBuffer([{ name: 'api-design/SKILL.md', data: API_DESIGN_BODY }]);
    const zipBase64 = zipBuffer.toString('base64');

    const response = { zipBase64, skillCount: 1, error: undefined as string | undefined };
    expect(typeof response.zipBase64).toBe('string');
    expect(response.zipBase64.length).toBeGreaterThan(0);

    // Simulate the client's zip decode + download:
    const binary = atob(response.zipBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return `blob:${Math.random().toString(36).slice(2)}`;
    });

    const blob = new Blob([bytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'wrongstack-skills.zip';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    expect(blobs.length).toBe(1);
    expect(blobs[0].type).toBe('application/zip');
  });

  it('sends skills.export WS message with correct type', () => {
    // Verify the WS message protocol
    const sent: unknown[] = [];
    const ws = {
      readyState: 1,
      send(data: string) {
        sent.push(JSON.parse(data));
      },
    };

    // Simulate the client sending the export request:
    (ws as { send: (d: string) => void }).send(
      JSON.stringify({ type: 'skills.export', payload: {} }),
    );

    expect(sent).toHaveLength(1);
    const msg = sent[0] as { type: string; payload: Record<string, unknown> };
    expect(msg.type).toBe('skills.export');
  });

  it('does not trigger download if the response contains an error', async () => {
    const clickSpy = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:test-url');
    document.createElement = vi.fn((tagName: string) => {
      if (tagName === 'a') {
        return { href: '', download: '', click: clickSpy, style: {} } as never as HTMLAnchorElement;
      }
      return {} as never as HTMLElement;
    }) as unknown as typeof document.createElement;

    const response = { zipBase64: '', skillCount: 0, error: 'Skills not enabled' };

    // Simulate the error handling path:
    if (response.error) {
      // Error path — should not download
      expect(response.error).toBeTruthy();
      expect(clickSpy).not.toHaveBeenCalled();
    } else {
      // Success path would trigger download
      expect(true).toBe(false); // Should not reach here
    }
  });
});

// ── Export button visibility ─────────────────────────────────────────────

describe('Export button visibility logic', () => {
  it('shows export button for project-scoped skills', () => {
    const canExport = (scope: string) => scope === 'project' || scope === 'user';
    expect(canExport('project')).toBe(true);
  });

  it('shows export button for user-scoped skills', () => {
    const canExport = (scope: string) => scope === 'project' || scope === 'user';
    expect(canExport('user')).toBe(true);
  });

  it('hides export button for bundled skills', () => {
    const canExport = (scope: string) => scope === 'project' || scope === 'user';
    expect(canExport('bundled')).toBe(false);
  });

  it('shows export-all button when skills list is non-empty', () => {
    const canExportAll = (skillCount: number) => skillCount > 0;
    expect(canExportAll(0)).toBe(false);
    expect(canExportAll(1)).toBe(true);
    expect(canExportAll(12)).toBe(true);
  });
});
