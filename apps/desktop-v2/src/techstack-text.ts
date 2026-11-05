import type { useDesktopText } from './desktop-i18n';
import { sentenceStart } from './engine-values';
import { techLabel } from './techstack-model';

type Translate = ReturnType<typeof useDesktopText>['t'];

/**
 * An engine TechStack value (dependency status, scope, coverage, job phase, depth, severity) in
 * the display language; a value added later keeps the engine's words.
 */
export const techWord = (value: unknown, t: Translate) =>
  typeof value === 'string' && value
    ? t(`techStack.value.${value}`, { defaultValue: techLabel(value) })
    : t('techStack.notReported');

/** A TechStack value that stands alone as a label (a status chip or heading). */
export const techTitle = (value: unknown, t: Translate, language: string) =>
  sentenceStart(techWord(value, t), language);
