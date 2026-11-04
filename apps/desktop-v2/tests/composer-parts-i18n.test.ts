// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AutonomyControl } from '../src/AutonomyControl';
import { ComposerReferenceChips } from '../src/ComposerReferenceChips';
import { GeneratedImages } from '../src/GeneratedImages';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function mount(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(host);
    root.render(element);
  });
  const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const read = () => ({
    text: host.textContent ?? '',
    labels: [...host.querySelectorAll('[aria-label],[title]')].flatMap((node) => [
      node.getAttribute('aria-label') ?? '',
      node.getAttribute('title') ?? '',
    ]),
  });
  const done = () => {
    act(() => root?.unmount());
    host.remove();
  };
  return { host, settle, read, done };
}

/** The attached file chip, then its line range editor opened from the chip. */
async function referenceChips() {
  const view = await mount(
    createElement(ComposerReferenceChips, {
      references: [{ path: 'README.md', lines: [1, 2] }],
      disabled: false,
      command: vi.fn(async () => ({})),
      onChange: () => undefined,
    }),
  );
  const range = view.host.querySelector<HTMLButtonElement>('button[aria-pressed]');
  await act(async () => range?.click());
  const result = view.read();
  view.done();
  return result;
}

async function controls() {
  const view = await mount(
    createElement(AutonomyControl, {
      prefs: { autonomy: 'auto', yolo: true },
      command: vi.fn(async () => ({})),
      disabled: false,
    }),
  );
  const result = view.read();
  view.done();
  return result;
}

async function images() {
  const view = await mount(
    createElement(GeneratedImages, {
      output: JSON.stringify({ files: [{ path: 'out/a.png' }] }),
      command: vi.fn(async () => ({ tooLarge: true })),
    }),
  );
  await view.settle();
  await view.settle();
  const result = view.read();
  view.done();
  return result;
}

describe('composer attachments and controls in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps English and translates the chips, range editor, modes and pictures in Turkish', async () => {
    await surfaceI18n.changeLanguage('en');
    const chips = await referenceChips();
    expect(chips.labels).toEqual(
      expect.arrayContaining([
        'Attached project files',
        'Set line range for README.md:1-2',
        'Remove file reference README.md:1-2',
        'Line range for README.md',
        'First referenced line',
      ]),
    );
    expect(chips.text).toContain('Preview lines');
    expect(chips.text).toContain('Use lines 1-2');
    const control = await controls();
    expect(control.labels).toEqual(
      expect.arrayContaining([
        'Continuation mode',
        'YOLO level',
        'Calls run without asking; damaging kinds still ask.',
      ]),
    );
    expect(control.text).toContain('Continue automatically');
    expect(control.text).toContain('Approvals on');
    const pictures = await images();
    expect(pictures.labels).toContain('Generated images');
    expect(pictures.text).toContain('Too large to preview');

    await surfaceI18n.changeLanguage('tr');
    const turkishChips = await referenceChips();
    expect(turkishChips.labels).toEqual(
      expect.arrayContaining([
        'Ekli proje dosyaları',
        'README.md:1-2 için satır aralığı belirle',
        'README.md:1-2 dosya referansını kaldır',
        'README.md için satır aralığı',
        'Referans verilen ilk satır',
      ]),
    );
    expect(turkishChips.text).toContain('Satırları önizle');
    expect(turkishChips.text).toContain('Satırları kullan 1-2');
    const turkishControl = await controls();
    expect(turkishControl.labels).toEqual(
      expect.arrayContaining([
        'Devam kipi',
        'YOLO düzeyi',
        'Çağrılar sormadan çalışır; zarar verebilecek türler yine sorar.',
      ]),
    );
    expect(turkishControl.text).toContain('Otomatik devam et');
    expect(turkishControl.text).toContain('Onaylar açık');
    const turkishPictures = await images();
    expect(turkishPictures.labels).toContain('Üretilen görseller');
    expect(turkishPictures.text).toContain('Önizleme için çok büyük');
  });
});
