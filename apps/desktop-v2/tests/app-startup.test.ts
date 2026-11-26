// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const shell = vi.hoisted(() => ({ section: 'fleet' }));
vi.mock('../src/useDesktop', () => ({
  useDesktop: () => ({
    section: shell.section,
    snapshot: { projects: [], sessions: [] },
    attention: [],
    active: [],
    connected: true,
  }),
}));
vi.mock('../src/platform', () => ({ native: true, layoutKey: 'layout' }));
vi.mock('../src/desktop-i18n', () => ({ useDesktopText: () => ({ t: (key: string) => key }) }));
vi.mock('../src/surface-i18n', () => ({ cachedLanguage: () => null, surfaceI18n: {} }));
vi.mock('../src/settings-section-request', () => ({ useShownSettingsSection: () => 'models' }));
vi.mock('../src/SurfaceLanguageSync', () => ({
  SurfaceLanguageSync: () => 'PROFILE_LANGUAGE_READER',
}));
vi.mock('../src/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../src/FleetPanel', () => ({ FleetPanel: () => null }));
vi.mock('../src/HostBuildNotice', () => ({ HostBuildNotice: () => null }));
vi.mock('../src/UpdateNotice', () => ({ UpdateNotice: () => null }));
vi.mock('../src/NotificationMenu', () => ({ NotificationMenu: () => null }));
vi.mock('../src/notification-feed', () => ({ useNotificationFeed: () => undefined }));
vi.mock('../src/ProjectViews', () => ({ ProjectViews: () => null }));
vi.mock('../src/WorkspaceDialogs', () => ({ WorkspaceDialogs: () => null }));
vi.mock('../src/WrongStackSettings', () => ({ WrongStackSettings: () => null }));

describe('desktop startup without a remembered language', () => {
  it.each(['fleet', 'projects', 'engine', 'project'])(
    'does not read the profile engine on %s',
    (section) => {
      shell.section = section;
      expect(renderToStaticMarkup(createElement(App))).not.toContain('PROFILE_LANGUAGE_READER');
    },
  );

  it('reads the profile language when settings are actually opened', () => {
    shell.section = 'wrongstack';
    expect(renderToStaticMarkup(createElement(App))).toContain('PROFILE_LANGUAGE_READER');
  });
});
