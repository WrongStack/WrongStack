import { describe, expect, it } from 'vitest';
import { surfaceI18n } from '../src/surface-i18n';

describe('counted messages', () => {
  it('use the singular for one and the plain message for other counts', async () => {
    await surfaceI18n.changeLanguage('en');
    const t = surfaceI18n.getFixedT('en', 'desktop');
    expect(t('turn.toolCalls', { count: 1 })).toBe('1 tool call');
    expect(t('turn.toolCalls', { count: 3 })).toBe('3 tool calls');
    expect(t('contentSearch.lines', { count: 1 })).toBe('1 matching line');
    expect(t('contentSearch.lines', { count: 0 })).toBe('0 matching lines');
    expect(t('settings.saveBar.unsaved', { count: 1 })).toBe('1 unsaved change');
    expect(t('settings.saveBar.unsaved', { count: 2 })).toBe('2 unsaved changes');
  });
});
