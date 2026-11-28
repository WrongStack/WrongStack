import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { engineHttpError, projectHttp } from '../src/engine-http';
import { requirementFields } from '../src/ProjectRequirements';
import { isRequirementUrl, RequirementEvidence } from '../src/RequirementResources';
import {
  emptyRequirementDraft,
  parseRequirementDraft,
  requirementSubmissionFingerprint,
} from '../src/requirement-draft';

const nativeRequest = vi.hoisted(() => vi.fn());
vi.mock('../src/platform', () => ({ request: nativeRequest }));

describe('project requirements contracts', () => {
  it('retains one submission identity when native JSON storage reorders object fields', () => {
    const original = {
      projectId: 'one',
      fields: { title: 'Request', priority: 'high' },
      attachments: [{ name: 'Design', kind: 'file', path: 'docs/design.md' }],
    };
    const restored = {
      attachments: [{ kind: 'file', path: 'docs/design.md', name: 'Design' }],
      fields: { priority: 'high', title: 'Request' },
      projectId: 'one',
    };
    expect(requirementSubmissionFingerprint(restored)).toBe(
      requirementSubmissionFingerprint(original),
    );
  });
  it('restores the complete new-request payload and its retry identity verbatim', () => {
    const draft = {
      ...emptyRequirementDraft(),
      original: '  Exact request\n',
      attachments: [{ name: 'Design', kind: 'file', path: 'docs/design.md' }],
      attempt: { fingerprint: 'same request', key: 'desktop-retry' },
    };
    expect(parseRequirementDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(parseRequirementDraft(null)).toEqual(emptyRequirementDraft());
  });
  it('refuses malformed saved drafts instead of replacing them with an empty form', () => {
    expect(() => parseRequirementDraft({ ...emptyRequirementDraft(), version: 2 })).toThrow();
    expect(() =>
      parseRequirementDraft({ ...emptyRequirementDraft(), fields: { title: 4 } }),
    ).toThrow();
    expect(() =>
      parseRequirementDraft({
        ...emptyRequirementDraft(),
        attachments: [{ name: 'Invalid', kind: 'file', path: 'one', url: 'https://example.com' }],
      }),
    ).toThrow();
  });
  it('accepts only web links for URL references', () => {
    expect(isRequirementUrl('https://example.com/design')).toBe(true);
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/plain,test',
      'not-a-url',
    ])
      expect(isRequirementUrl(url)).toBe(false);
  });
  it('renders resource references, suggestion questions and field provenance as readable content', () => {
    const html = renderToStaticMarkup(
      createElement(RequirementEvidence, {
        detail: {
          attachments: [{ name: 'Design', kind: 'file', path: 'docs/design.md' }],
          relatedResources: [{ title: 'Tracked issue', kind: 'issue', reference: '#42' }],
          llmSuggestions: [
            {
              id: 'proposal-a',
              kind: 'question',
              field: 'business_goal',
              status: 'pending',
              value: { question: 'Who needs this?', field: 'business_goal' },
            },
          ],
          fieldSources: { title: 'user', business_goal: 'llm' },
        },
      }),
    );
    for (const value of [
      'Design',
      'docs/design.md',
      'Tracked issue',
      '#42',
      'Who needs this?',
      'User input',
      'Model proposal',
    ])
      expect(html).toContain(value);
    expect(html).not.toContain('[object Object]');
  });
  it('shows nested engine errors as readable messages', () => {
    expect(
      engineHttpError(
        { error: { code: 'INTAKE_CONFLICT', message: 'Record version changed.' } },
        409,
      ),
    ).toBe('Record version changed.');
    expect(engineHttpError({ error: 'Request refused' }, 403)).toBe('Request refused');
    // Without a message of its own, the failure is said in words, never as a status code.
    expect(engineHttpError({ error: {} }, 500)).toBe(
      'The engine hit an error doing this. Try again.',
    );
    expect(engineHttpError(null, 200)).toBe('The engine gave no usable answer. Try again.');
    expect(engineHttpError(null, 404)).not.toMatch(/\d/);
  });
  it('rejects a stale-write HTTP response with the server message', async () => {
    nativeRequest.mockResolvedValueOnce({
      ok: false,
      status: 409,
      data: { error: { code: 'INTAKE_CONFLICT', message: 'Record version changed.' } },
    });
    await expect(
      projectHttp('project-a')('/api/requirement-intakes/one', 'PATCH', { expectedVersion: 1 }),
    ).rejects.toThrow('Record version changed.');
  });
  it('normalizes list metadata without emitting an original-request edit', () => {
    const payload = requirementFields({
      title: 'Test',
      requestType: 'feature',
      priority: 'high',
      businessGoal: '',
      expectedOutcome: '',
      scopeNotes: '',
      targetUsers: 'One\n\n Two ',
      constraints: 'Do not lose :: detail\n',
      providedContext: '',
    });
    expect(payload.targetUsers).toEqual(['One', 'Two']);
    expect(payload.constraints).toEqual(['Do not lose :: detail']);
    expect(payload).not.toHaveProperty('originalRequest');
  });
});
