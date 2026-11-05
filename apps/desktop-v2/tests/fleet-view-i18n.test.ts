// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';
import { FleetPanel } from '../src/FleetPanel';
import { surfaceI18n } from '../src/surface-i18n';

const session = (id: string, status: string, kind: 'agent' | 'terminal') => ({
  id,
  projectId: 'p1',
  title: `Session ${id}`,
  kind,
  workdir: `/repo/${id}`,
  status,
  createdAt: 1,
  updatedAt: Date.now() - 5 * 60_000,
  exitCode: null,
  error: null,
});
const sessions = [session('a', 'running', 'agent'), session('b', 'stopped', 'terminal')];
const vm = (list: typeof sessions, search = '') => ({
  snapshot: {
    projects: [{ id: 'p1', name: 'Alpha', root: '/repo', createdAt: 1 }],
    sessions: list,
    hostPid: 1,
    layout: null,
  },
  project: null,
  selected: null,
  filter: 'all',
  setFilter: () => {},
  search,
  setSearch: () => {},
  pending: false,
  run: async () => {},
  newSession: () => {},
  active: list.filter((item) => item.status === 'running'),
  attention: [],
  sessions: list,
  jumpToSession: () => {},
});
const render = (list = sessions, search = '') =>
  renderToStaticMarkup(createElement(FleetPanel, { vm: vm(list, search) as never })).replaceAll(
    '<!-- -->',
    '',
  );

describe('Mission control in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps its English and shows Turkish and German', async () => {
    await surfaceI18n.changeLanguage('en');
    const english = render();
    for (const text of [
      'active session',
      'All sessions',
      'placeholder="Find a session…"',
      'aria-label="Alpha sessions"',
      '2 sessions',
      'New session',
      'Active',
      'Stopped',
      '5m ago',
      'Open workspace',
      'View transcript',
      'Pin',
    ])
      expect(english).toContain(text);
    expect(render([], 'zzz')).toContain('No matching sessions.');

    await surfaceI18n.changeLanguage('tr');
    const turkish = render();
    for (const text of ['etkin oturum', 'Tüm oturumlar', 'Yeni oturum', 'Durduruldu', '5 dk önce'])
      expect(turkish).toContain(text);

    await surfaceI18n.changeLanguage('de');
    const german = render();
    for (const text of [
      'aktive Sitzung',
      'Alle Sitzungen',
      'placeholder="Sitzung finden…"',
      'aria-label="Sitzungen von Alpha"',
      '2 Sitzungen',
      'Neue Sitzung',
      'Aktiv',
      'Gestoppt',
      'vor 5 Min.',
      'Arbeitsbereich öffnen',
      'Protokoll ansehen',
      'Anheften',
    ])
      expect(german).toContain(text);
    expect(render([], 'zzz')).toContain('Keine passenden Sitzungen.');
    for (const text of ['All sessions', 'New session', 'View transcript', 'ago'])
      expect(german).not.toContain(text);
  });
});
