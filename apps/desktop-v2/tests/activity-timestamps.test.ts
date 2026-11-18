// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { SessionActivity } from '../src/SessionActivity';
import { activityRows } from '../src/session-activity-model';
import { surfaceI18n } from '../src/surface-i18n';
import { TranscriptTimestamp } from '../src/TranscriptTimestamp';
import { renderOpen } from './helpers/render-open';

const at = Date.parse('2026-11-18T10:11:12Z');
afterEach(async () => {
  await surfaceI18n.changeLanguage('en');
});

describe('recorded transcript and activity timestamps', () => {
  it('retains the first frame time when thinking and progress merge during replay', () => {
    let state = { ...emptyEngineState, sessionId: 's' };
    for (const event of [
      { type: 'iteration.started', payload: { index: 0 }, at },
      { type: 'provider.thinking_delta', payload: { text: 'First ' }, at: at + 1000 },
      { type: 'provider.thinking_delta', payload: { text: 'second' }, at: at + 2000 },
      {
        type: 'tool.progress',
        payload: { id: 'read', name: 'read', event: { text: 'First progress' } },
        at: at + 3000,
      },
      {
        type: 'tool.progress',
        payload: { id: 'read', name: 'read', event: { text: 'Second progress' } },
        at: at + 4000,
      },
      { type: 'tool.executed', payload: { id: 'read', name: 'read', ok: true }, at: at + 5000 },
      { type: 'provider.retry', payload: { providerId: 'fixture', attempt: 1 }, at: at + 6000 },
      { type: 'run.result', payload: { status: 'done' }, at: at + 7000 },
    ])
      state = reduceEngine(state, event);
    const rows = activityRows(state.activity);
    expect(rows.map((row) => row.at)).toEqual([at, at + 1000, at + 3000, at + 6000, at + 7000]);
    expect(rows.find((row) => row.kind === 'tool')?.finishedAt).toBe(at + 5000);
    const html = renderOpen(
      createElement(SessionActivity, {
        events: state.activity,
        compact: true,
        onOpenFile: () => {},
      }),
    );
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect([...document.querySelectorAll('time')].map((time) => time.dateTime)).toEqual(
      rows.map((row) => new Date(row.at ?? 0).toISOString()),
    );
    expect(document.querySelector('.activity-iteration > summary time')).not.toBeNull();
  });

  it('prefers a tool start to later progress and completion timestamps', () => {
    const [row] = activityRows([
      { type: 'tool.started', payload: { id: 'one', name: 'read' }, at },
      { type: 'tool.progress', payload: { id: 'one', event: { text: 'progress' } }, at: at + 1000 },
      { type: 'tool.executed', payload: { id: 'one', ok: false }, at: at + 2000 },
    ]);
    expect(row).toMatchObject({ at, finishedAt: at + 2000 });
  });

  it('omits missing/invalid timestamps, supports epoch zero, and localizes valid times to seconds', async () => {
    for (const value of [undefined, null, '', 'not-a-date', NaN, Infinity, 9e20])
      expect(renderToStaticMarkup(createElement(TranscriptTimestamp, { value }))).toBe('');
    expect(renderToStaticMarkup(createElement(TranscriptTimestamp, { value: 0 }))).toContain(
      'dateTime="1970-01-01T00:00:00.000Z"',
    );
    for (const language of ['en', 'tr']) {
      await surfaceI18n.changeLanguage(language);
      const html = renderToStaticMarkup(createElement(TranscriptTimestamp, { value: at }));
      expect(html).toContain(new Date(at).toLocaleString(language, { timeStyle: 'medium' }));
      expect(html).toContain(`dateTime="${new Date(at).toISOString()}"`);
      expect(html).toContain('title=');
    }
    const rows = activityRows([{ type: 'tool.started', payload: { id: 'one' }, at: NaN }]);
    expect(rows[0]?.at).toBeUndefined();
  });
});
