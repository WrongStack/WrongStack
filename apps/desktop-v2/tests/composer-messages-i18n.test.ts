// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { processAttachmentFile, validateAttachments } from '../src/composer-attachments';
import { refinementText } from '../src/composer-model';
import { englishText, localizedText } from '../src/desktop-text';
import english from '../src/locales/en/desktop.json';
import { surfaceI18n } from '../src/surface-i18n';

const group = english.composerMessage as Record<string, string>;
const sample = { error: 'socket closed', name: 'scan.png', size: 8 };

describe('composer messages in the display language', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('keeps the English of the model messages exactly as it was', async () => {
    expect(() => validateAttachments([{ data: 'AAAA', mediaType: 'text/plain' }])).toThrow(
      'Attach a supported image or PDF.',
    );
    expect(() =>
      validateAttachments([{ data: 'AA', mediaType: 'image/png', name: 'scan.png' }]),
    ).toThrow('“scan.png” contains invalid file data.');
    expect(() => refinementText({}, 'refined', 'draft')).toThrow(
      'The refiner did not return this version. Your original draft is kept.',
    );
    await expect(processAttachmentFile(new File([], 'empty.png'))).rejects.toThrow(
      '“empty.png” is empty.',
    );
    expect(englishText('composerMessage', 'fileLimit', { name: 'a.pdf', size: 8 })).toBe(
      '“a.pdf” exceeds the 8 MB file limit.',
    );
    expect(englishText('composerMessage', 'btwSaved')).toBe(
      'BTW saved for this session’s leader. Delivery does not mean it has been read.',
    );
  });

  it('turns every English line back into its display-language line, values included', async () => {
    for (const language of ['tr', 'de', 'fr', 'it', 'es', 'pt-BR']) {
      await surfaceI18n.changeLanguage(language);
      const t = surfaceI18n.getFixedT(language, 'desktop');
      const say = (key: string, values: Record<string, string | number>) => t(key, values);
      for (const key of Object.keys(group)) {
        const text = englishText('composerMessage', key, sample);
        const shown = localizedText(text, 'composerMessage', say);
        expect(shown, `${language} ${key}`).toBe(t(`composerMessage.${key}`, sample));
        expect(shown, `${language} ${key}`).not.toBe(text);
      }
    }
  });

  it('recognises each English line as itself only', () => {
    const keyOf = (key: string) => key;
    for (const key of Object.keys(group)) {
      const text = englishText('composerMessage', key, sample);
      expect(localizedText(text, 'composerMessage', keyOf)).toBe(`composerMessage.${key}`);
    }
  });

  it('shows other text, such as an engine message, as it came', async () => {
    await surfaceI18n.changeLanguage('tr');
    const t = surfaceI18n.getFixedT('tr', 'desktop');
    expect(localizedText('Unknown command /foo.', 'composerMessage', (k, v) => t(k, v))).toBe(
      'Unknown command /foo.',
    );
  });

  it('matches the English the composer itself still writes', () => {
    const source = readFileSync(resolve(__dirname, '../src/SessionComposer.tsx'), 'utf8');
    for (const key of [
      'refinementUnconfirmed',
      'detached',
      'notStopped',
      'submitting',
      'resolveConflict',
      'changedElsewhere',
      'draftNotCleared',
      'differentGoal',
      'topicChanged',
    ])
      expect(source, key).toContain(`'${group[key]}'`);
  });
});
