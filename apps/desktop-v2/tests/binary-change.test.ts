// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { BinaryChange } from '../src/DiffPreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const png = (marker: string) => `data:image/png;base64,${marker}`;

function mount(diff: Record<string, unknown>) {
  const host = document.createElement('div');
  act(() => createRoot(host).render(createElement(BinaryChange, { diff, path: 'logo.png' })));
  return host;
}

describe('binary changes in the Changes view', () => {
  it('shows both versions of a changed image with their sizes, and an onion skin', () => {
    const host = mount({
      binary: true,
      image: { old: png('b2xk'), new: png('bmV3'), oldBytes: 2048, newBytes: 512 },
    });
    expect(host.textContent).toContain('Changed image');
    const sources = [...host.querySelectorAll('img')].map((img) => img.getAttribute('src'));
    expect(sources).toEqual([png('b2xk'), png('bmV3')]);
    expect(host.textContent).toContain('2.0 KB');
    expect(host.textContent).toContain('512 B');
    const onion = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Onion skin',
    );
    act(() => onion?.click());
    const slider = host.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider.getAttribute('aria-label')).toBe('Working tree opacity');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(slider, '20');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('img')[1]?.getAttribute('style')).toContain('opacity: 0.2');
  });

  it('shows the one side of an added image, without modes', () => {
    const host = mount({ binary: true, image: { new: png('bmV3'), newBytes: 10 } });
    expect(host.textContent).toContain('New image');
    expect(host.querySelectorAll('img')).toHaveLength(1);
    expect(host.querySelector('[aria-pressed]')).toBeNull();
  });

  it('keeps the old notices when there is nothing safe to show', () => {
    expect(mount({ binary: true }).textContent).toBe('Binary file — text review is unavailable.');
    expect(mount({ tooLarge: true }).textContent).toBe('File exceeds the text review limit.');
    expect(
      mount({ binary: true, image: { new: 'javascript:alert(1)' } }).querySelector('img'),
    ).toBeNull();
  });
});
