import type { ProtocolEnvelope } from '@wrongstack/webui-protocol';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  fillPrompt,
  promptSlug,
  promptVariables,
  resourceDetails,
  resourceMatches,
} from '../src/lib/resource-model';
import { initialState } from '../src/lib/session';
import { acceptsPanelReply, usePanelRequests } from '../src/lib/use-panel-requests';
import type { SessionController } from '../src/lib/use-session';

describe('shared resource workflows', () => {
  it('previews and inserts the selected original prompt detail level with a legacy fallback', () => {
    const payload = {
      content: 'Detailed {{target}}',
      variants: {
        simple: 'Simple {{target}}',
        detailed: 'Detailed {{target}}',
        advanced: 'Advanced {{target}}',
      },
    };
    expect(resourceDetails('prompts', payload)).toBe('Detailed {{target}}');
    expect(fillPrompt(resourceDetails('prompts', payload, 'advanced'), { target: 'design' })).toBe(
      'Advanced design',
    );
    expect(resourceDetails('prompts', { content: 'Legacy' }, 'simple')).toBe('Legacy');
    expect(
      resourceDetails('prompts', { content: 'Legacy', variants: { advanced: 42 } }, 'advanced'),
    ).toBe('Legacy');
  });
  it('fills named prompt variables literally while retaining unknown placeholders', () => {
    expect(
      fillPrompt('Review {{ target }} and {{missing}}; {{target}}', {
        target: '$testing $& src/app.tsx',
      }),
    ).toBe('Review $testing $& src/app.tsx and {{missing}}; $testing $& src/app.tsx');
  });
  it('detects prompt identifier collisions using the backend title rules', () => {
    expect(promptSlug(' Review a target! ')).toBe('review-a-target');
    expect(promptSlug('Review / a target')).toBe(promptSlug('Review a target'));
    expect(promptSlug('????')).toBe('prompt');
    expect(promptSlug(`${'a'.repeat(63)} extra words`)).toBe('a'.repeat(63));
  });
  it('accepts only well-formed variable metadata and searches labels, tags and owners', () => {
    expect(
      promptVariables([
        { name: 'target', required: true, default: 'src', enum: ['src', 42] },
        { name: 42 },
      ]),
    ).toEqual([
      { name: 'target', required: true, defaultValue: 'src', description: '', options: ['src'] },
    ]);
    expect(
      resourceMatches({ title: 'Review', tags: ['quality'], owner: 'Core' }, ' QUALITY '),
    ).toBe(true);
    expect(resourceMatches({ name: 'read_file', description: {} }, 'missing')).toBe(false);
  });
  it('rejects stale correlated replies and unrelated named resource responses', () => {
    const accept = (p: Record<string, unknown>) => p.name === 'testing';
    expect(
      acceptsPanelReply(
        { type: 'skills.content', payload: { requestId: 'old', name: 'testing' } },
        'skills.content',
        'new',
        accept,
      ),
    ).toBe(false);
    expect(
      acceptsPanelReply(
        { type: 'skills.content', payload: { name: 'wrong' } },
        'skills.content',
        'new',
        accept,
      ),
    ).toBe(false);
    expect(
      acceptsPanelReply(
        { type: 'skills.content', payload: { name: 'testing' } },
        'skills.content',
        'new',
        accept,
      ),
    ).toBe(true);
    expect(acceptsPanelReply({ type: 'error', payload: {} }, 'skills.content', 'new', accept)).toBe(
      false,
    );
  });
  it('supersedes an in-flight panel request for the same expected frame type instead of dropping the newer request', async () => {
    const listeners = new Set<(frame: ProtocolEnvelope) => void>();
    const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    const controller = {
      state: { ...initialState(), id: 'sess-1' },
      connection: 'connected',
      send(type: string, payload?: Record<string, unknown>) {
        sent.push({ type, payload });
        return true;
      },
      subscribe(listener: (frame: ProtocolEnvelope) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as unknown as SessionController;

    let api: ReturnType<typeof usePanelRequests> | null = null;
    function Harness() {
      api = usePanelRequests(controller);
      return null;
    }
    renderToString(React.createElement(Harness));

    const first = api!.request('prompts.content', { slug: 'first' }, 'prompts.content');
    const second = api!.request('prompts.content', { slug: 'second' }, 'prompts.content');

    await expect(first).resolves.toBeNull();
    const secondFrame = sent.find((f) => f.payload?.slug === 'second');
    for (const listener of [...listeners]) {
      listener({
        type: 'prompts.content',
        payload: { requestId: secondFrame?.payload?.requestId, slug: 'second', content: 'ok' },
      });
    }
    await expect(second).resolves.toMatchObject({ slug: 'second', content: 'ok' });
  });
});
