// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  requestSettingsSection,
  useReportSettingsSection,
  useRequestedSettingsSection,
  useShownSettingsSection,
} from '../src/settings-section-request';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A stand-in for the settings page: starts on providers and follows requests. */
function Settings() {
  const [section, setSection] = useState('providers');
  useRequestedSettingsSection(setSection);
  useReportSettingsSection(section);
  return createElement('p', { id: 'settings' }, section);
}

/** A stand-in for the rail: marks the quota shortcut while settings show quota. */
function Rail() {
  return createElement('p', { id: 'rail' }, useShownSettingsSection() ?? 'closed');
}

const roots: Root[] = [];
async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(element));
  return root;
}
const text = (id: string) => document.getElementById(id)?.textContent;

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe('opening a settings section from outside the page', () => {
  it('takes a request made before the page opens, once', async () => {
    await mount(createElement(Rail));
    expect(text('rail')).toBe('closed');
    await act(async () => requestSettingsSection('quota'));
    // 2026-11-13: the settings page waits for its engine before it mounts; meanwhile the rail
    // and the title already name the requested section, not the settings home.
    expect(text('rail')).toBe('quota');
    const settings = await mount(createElement(Settings));
    expect(text('settings')).toBe('quota');
    expect(text('rail')).toBe('quota');
    await act(async () => settings.unmount());
    roots.splice(roots.indexOf(settings), 1);
    expect(text('rail')).toBe('closed');
    // The request was used up: opening settings again starts where it normally does.
    await mount(createElement(Settings));
    expect(text('settings')).toBe('providers');
  });

  it('switches a page that is already open', async () => {
    await mount(createElement(Rail));
    await mount(createElement(Settings));
    expect(text('rail')).toBe('providers');
    await act(async () => requestSettingsSection('quota'));
    expect(text('settings')).toBe('quota');
    expect(text('rail')).toBe('quota');
    await act(async () => requestSettingsSection('health'));
    expect(text('rail')).toBe('health');
  });
});
