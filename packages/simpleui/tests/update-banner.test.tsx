// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdateBanner, type UpdateBannerProps } from '../src/update-banner.js';

/**
 * Behavior coverage for the `UpdateBanner` component (plan B1 slice 5,
 * extracted from simple-ui-session.tsx). Pins the visibility gate, the
 * version-range copy, and the dismiss contract.
 *
 * Harness mirrors the sibling component tests: jsdom + real `createRoot` +
 * `act`, no testing-library dependency.
 */

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderBanner(props: Partial<UpdateBannerProps> = {}): {
  container: HTMLDivElement;
  root: Root;
} {
  const merged: UpdateBannerProps = {
    appVersion: '0.297.1',
    latestVersion: '0.297.2',
    show: true,
    onDismiss: () => {},
    ...props,
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<UpdateBanner {...merged} />);
  });
  roots.push(root);
  return { container, root };
}

describe('UpdateBanner — visibility gate', () => {
  it('renders the banner when show is true', () => {
    const { container } = renderBanner();
    expect(container.querySelector('.update-banner')).not.toBeNull();
  });

  it('renders nothing when show is false', () => {
    const { container } = renderBanner({ show: false });
    expect(container.querySelector('.update-banner')).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('UpdateBanner — copy', () => {
  it('shows the version range and the upgrade hint', () => {
    const { container } = renderBanner();
    const banner = container.querySelector('.update-banner');
    expect(banner?.textContent).toContain('Update available: v0.297.1 → v0.297.2');
    expect(banner?.textContent).toContain('wstack update');
  });

  it('falls back to "?" when appVersion is empty', () => {
    const { container } = renderBanner({ appVersion: '' });
    expect(container.querySelector('.update-banner')?.textContent).toContain(
      'Update available: v? → v0.297.2',
    );
  });
});

describe('UpdateBanner — dismiss', () => {
  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    const { container } = renderBanner({ onDismiss });
    const button = container.querySelector<HTMLButtonElement>('.update-banner-dismiss');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-label')).toBe('Dismiss update warning');

    act(() => {
      button?.click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
