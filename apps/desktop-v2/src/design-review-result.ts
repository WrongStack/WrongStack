import { designArtifactPath, readDesignReferenceResult } from './design-extraction-result';
import { record } from './engine-values';
import type { ActivityRow } from './session-activity-model';

const reportPatterns = {
  inspect: /^\.design\/inspect\/[a-z0-9][a-z0-9-]{0,63}\/inspect\.md$/,
  compare: /^\.design\/references\/[a-z0-9][a-z0-9-]{0,63}\/fidelity\.md$/,
};
type ReviewAction = keyof typeof reportPatterns;
interface DesignReviewResult {
  action: ReviewAction;
  target?: string | undefined;
  reference?: string | undefined;
  viewports?: string | undefined;
  path?: string | undefined;
  fails?: number | undefined;
  warns?: number | undefined;
  score?: number | undefined;
}

export function designReviewPath(
  value: string,
  action?: ReviewAction,
  projectRoot?: string | null,
): string | undefined {
  const path = designArtifactPath(value, projectRoot);
  const patterns = action ? [reportPatterns[action]] : Object.values(reportPatterns);
  return patterns.some((pattern) => pattern.test(path)) ? path : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function countValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function scoreValue(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined;
}

export function designReviewResult(
  row: ActivityRow,
  projectRoot?: string | null,
): DesignReviewResult | null {
  const input = record(row.input);
  const requested = input['action'];
  if (requested !== undefined && requested !== 'inspect' && requested !== 'compare') return null;
  const { text, output } = readDesignReferenceResult(row.output);
  const action = requested ?? output['action'];
  if (action !== 'inspect' && action !== 'compare') return null;

  const inspection = action === 'inspect';
  const heading = inspection
    ? /^# Inspect — ([^\r\n]+)$/m.exec(text)
    : /^# Fidelity — (.+) vs (.+)$/m.exec(text);
  const target =
    (!inspection ? textValue(input['against']) : undefined) ??
    textValue(input['file']) ??
    textValue(input['url']) ??
    textValue(heading?.[1]);
  const reference = inspection
    ? undefined
    : (textValue(input['reference']) ?? textValue(heading?.[2]));
  const metadata: DesignReviewResult = { action, target, reference };
  if (row.status !== 'done' || (output['action'] !== undefined && output['action'] !== action)) {
    return metadata;
  }

  const summary = /^Surface: (?:page|app) · viewports ([\d, ]+)px · (\d+) FAIL · (\d+) WARN$/m.exec(
    text,
  );
  const viewportList = inspection
    ? summary?.[1]
    : /^Viewports compared: ([\d, ]+|none shared)$/m.exec(text)?.[1];
  const viewports =
    viewportList === 'none shared'
      ? ''
      : viewportList
          ?.split(',')
          .map((part) => part.trim())
          .join(', ');
  const saved = inspection
    ? /^Saved: ([^\s{}]+)[/\\]inspect\.\{md,json\}/m.exec(text)?.[1]
    : undefined;
  const candidates = [
    textValue(output['path']),
    saved ? `${saved}/inspect.md` : undefined,
    ...row.files.filter((file) => file.operation === 'write').map((file) => file.path),
  ];
  const path = candidates.flatMap((value) =>
    value ? (designReviewPath(value, action, projectRoot) ?? []) : [],
  )[0];
  const fails = inspection
    ? (countValue(output['fails']) ?? countValue(Number(summary?.[2])))
    : undefined;
  const warns = inspection
    ? (countValue(output['warns']) ?? countValue(Number(summary?.[3])))
    : undefined;
  const overall = /^Overall (\d+(?:\.\d+)?)% \(lowest axis:/m.exec(text)?.[1];
  const score = inspection
    ? undefined
    : (scoreValue(output['score']) ?? scoreValue(Number(overall) / 100));
  return { ...metadata, viewports, path, fails, warns, score };
}
