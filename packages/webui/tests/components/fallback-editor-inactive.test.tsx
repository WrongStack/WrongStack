/**
 * Tests for packages/webui/src/components/FallbackEditor.tsx — the inline
 * fallback chain editor used by the WebUI's settings panel, the run-config
 * wizard, and the board header.
 *
 * Focus: the inactive-badge parity with the `/fallback` slash command's
 * `refInactiveReason` warning. Each row is classified against
 * `knownModels`; rows whose (provider, model) is missing from the set
 * render with an amber alert icon and the translated "inactive" label.
 *
 * The empty/loading `knownModels` path is the most important regression
 * check: it must NOT flash inactive badges on cold start.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FallbackEditor } from '../../src/components/FallbackEditor';

afterEach(() => {
  cleanup();
});

import { i18n } from '../../src/i18n';

describe('FallbackEditor — inactive badge parity with /fallback', () => {
  // Pin the language before rendering: the component renders t()-derived
  // labels, and an unpinned translator can race initialization into raw keys.
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });
  it('renders no inactive badges when knownModels is undefined (still loading)', () => {
    render(
      <FallbackEditor
        value={['anthropic/claude-opus-4', 'openai/gpt-99']}
        candidates={[]}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId(/^fallback-row-\d+-inactive-badge$/)).toBeNull();
  });

  it('renders no inactive badges when knownModels is empty (no provider allow-list)', () => {
    render(
      <FallbackEditor
        value={['anthropic/claude-opus-4', 'openai/gpt-99']}
        candidates={[]}
        knownModels={new Set()}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId(/^fallback-row-\d+-inactive-badge$/)).toBeNull();
  });

  it('keeps unlisted rows active with the CLI advisory — the runtime still tries them', () => {
    render(
      <FallbackEditor
        value={[
          'openai/gpt-4o',
          'openai/gpt-99-not-real',
          'anthropic/claude-opus-4',
          'ghost/some-model',
        ]}
        candidates={[]}
        knownModels={new Set(['openai/gpt-4o', 'openai/gpt-4o-mini', 'anthropic/claude-opus-4'])}
        onChange={() => {}}
      />,
    );

    expect(screen.queryByTestId(/^fallback-row-\d+-inactive-badge$/)).toBeNull();
    for (const i of [0, 1, 2, 3]) {
      expect(screen.getByTestId(`fallback-row-${i}`).getAttribute('data-active')).toBe('true');
    }
    expect(screen.getByTestId('fallback-row-0').getAttribute('data-advisory')).toBeNull();
    expect(screen.getByTestId('fallback-row-1').getAttribute('data-advisory')).toBe(
      'not in openai saved model list — will still be tried',
    );
    expect(screen.getByTestId('fallback-row-3').getAttribute('data-advisory')).toBe(
      'not in ghost saved model list — will still be tried',
    );
    expect(screen.getByTestId('fallback-row-1').getAttribute('title')).toBe(
      'not in openai saved model list — will still be tried',
    );
  });

  it('keeps a leading-slash ref active with a "uses the active provider" advisory', () => {
    render(
      <FallbackEditor
        value={['/gpt-4o-mini']}
        candidates={[]}
        knownModels={new Set(['openai/gpt-4o-mini'])}
        onChange={() => {}}
      />,
    );
    const row = screen.getByTestId('fallback-row-0');
    expect(row.getAttribute('data-active')).toBe('true');
    expect(row.getAttribute('data-advisory')).toBe(
      'no provider in reference — uses the active provider',
    );
  });

  it('flags an empty ref as inactive (no model)', () => {
    render(
      <FallbackEditor
        value={['']}
        candidates={[]}
        knownModels={new Set(['openai/gpt-4o'])}
        onChange={() => {}}
      />,
    );
    const row = screen.getByTestId('fallback-row-0');
    expect(row.getAttribute('data-active')).toBe('false');
    expect(row.getAttribute('data-inactive-reason')).toBe('"" has no model');
  });

  it('does not flag the active row when every ref is in the known set', () => {
    render(
      <FallbackEditor
        value={['openai/gpt-4o', 'openai/gpt-4o-mini']}
        candidates={[]}
        knownModels={new Set(['openai/gpt-4o', 'openai/gpt-4o-mini'])}
        onChange={() => {}}
      />,
    );
    expect(screen.queryByTestId(/^fallback-row-\d+-inactive-badge$/)).toBeNull();
    expect(screen.getByTestId('fallback-row-0').getAttribute('data-active')).toBe('true');
    expect(screen.getByTestId('fallback-row-1').getAttribute('data-active')).toBe('true');
  });
});
