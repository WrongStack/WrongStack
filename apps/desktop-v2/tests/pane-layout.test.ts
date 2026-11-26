import { describe, expect, it } from 'vitest';
import {
  decodePaneLayout,
  defaultPaneLayout,
  panePresets,
  paneStorageKey,
} from '../src/pane-layout';

describe('saved pane layouts', () => {
  it.each([null, '', '{', '[]', '{"version":2}'])(
    'uses defaults for unsupported data %s',
    (raw) => {
      expect(decodePaneLayout(raw)).toEqual(defaultPaneLayout);
    },
  );

  it('retains valid fields and clamps widths without trusting malformed fields', () => {
    expect(
      decodePaneLayout(
        '{"version":1,"panes":{"explorer":{"width":999,"open":false},"fileTree":{"width":"270","open":"false"},"inspector":{"width":200}}}',
      ),
    ).toEqual({
      explorer: { width: 400, open: false },
      fileTree: defaultPaneLayout.fileTree,
      inspector: { width: 240, open: true },
    });
  });

  it.each(Object.values(panePresets))('round-trips a preset', (panes) => {
    expect(decodePaneLayout(JSON.stringify({ version: 1, panes }))).toEqual(panes);
  });

  it('keeps window scopes separate from each other and from navigation state', () => {
    expect(paneStorageKey('layout')).not.toBe(paneStorageKey('layout:p1'));
    expect(paneStorageKey('layout:p1')).not.toBe(paneStorageKey('layout:p2'));
  });
});
