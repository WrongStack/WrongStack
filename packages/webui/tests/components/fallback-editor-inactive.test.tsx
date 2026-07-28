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
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FallbackEditor } from '../../src/components/FallbackEditor';

afterEach(() => {
  cleanup();
});

describe('FallbackEditor — inactive badge parity with /fallback', () => {
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

  it('flags only the rows whose (provider, model) is missing from the known set', () => {
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

    // The active rows must NOT carry the inactive badge.
    expect(
      within(screen.getByTestId('fallback-row-0')).queryByTestId('fallback-row-0-inactive-badge'),
    ).toBeNull();
    expect(
      within(screen.getByTestId('fallback-row-2')).queryByTestId('fallback-row-2-inactive-badge'),
    ).toBeNull();

    // The inactive rows must carry it, with the same wording the slash command uses.
    expect(screen.getByTestId('fallback-row-1-inactive-badge')).toBeTruthy();
    expect(screen.getByTestId('fallback-row-3-inactive-badge')).toBeTruthy();
    const row1 = screen.getByTestId('fallback-row-1');
    const row3 = screen.getByTestId('fallback-row-3');
    expect(row1.getAttribute('data-active')).toBe('false');
    expect(row3.getAttribute('data-active')).toBe('false');

    // Tooltip attribute carries the reason — same wording the slash command renders.
    expect(screen.getByTestId('fallback-row-1').getAttribute('data-inactive-reason')).toBe(
      '"gpt-99-not-real" not in openai model list',
    );
    expect(screen.getByTestId('fallback-row-3').getAttribute('data-inactive-reason')).toBe(
      '"some-model" not in ghost model list',
    );
  });

  it('flags a leading-slash ref as inactive (no provider)', () => {
    render(
      <FallbackEditor
        value={['/gpt-4o-mini']}
        candidates={[]}
        knownModels={new Set(['openai/gpt-4o-mini'])}
        onChange={() => {}}
      />,
    );
    const row = screen.getByTestId('fallback-row-0');
    expect(row.getAttribute('data-active')).toBe('false');
    expect(row.getAttribute('data-inactive-reason')).toBe('no provider in reference');
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
