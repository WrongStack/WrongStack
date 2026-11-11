import { record } from './engine-values';
import { projectRelativePath } from './file-model';
import type { ActivityRow } from './session-activity-model';

/** A conversation may boot a nested package as its own root; artifacts belong to that engine. */
export function designArtifactRoot(projectRoot: string, engineRoot: unknown): string | null {
  if (engineRoot === undefined) return projectRoot;
  if (typeof engineRoot !== 'string' || !engineRoot.trim()) return null;
  const value = engineRoot.trim();
  if (!/^(?:[a-z]:[\\/]|[\\/])/i.test(value)) return null;
  const relative = projectRelativePath(value, projectRoot);
  // An engine root outside the selected desktop project cannot be opened by its file service.
  if (/^(?:[a-z]:[\\/]|[\\/]|\.\.(?:[\\/]|$))/i.test(relative)) return null;
  return value;
}

export function designArtifactPath(value: string, projectRoot?: string | null): string {
  if (projectRoot === null) return '';
  const path = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  return projectRoot && /^(?:[a-z]:)?\//i.test(path) && !path.split('/').includes('..')
    ? projectRelativePath(path, projectRoot)
    : path;
}

export function designSpecPath(value: string, projectRoot?: string | null): string | undefined {
  const path = designArtifactPath(value, projectRoot);
  return /^\.design\/references\/[a-z0-9][a-z0-9-]{0,63}\/DESIGN\.md$/.test(path)
    ? path
    : undefined;
}

export function readDesignReferenceResult(raw: string | undefined) {
  let text = raw ?? '';
  let output: Record<string, unknown> = {};
  if (text.trimStart().startsWith('{')) {
    try {
      output = record(JSON.parse(text));
      if (typeof output['output'] === 'string') text = output['output'];
    } catch {
      // A truncated journal preview may still have a separately reported file target.
    }
  }
  return { text, output };
}

export function designExtractionResult(
  row: Pick<ActivityRow, 'input' | 'status' | 'output' | 'progress' | 'files'>,
  projectRoot?: string | null,
): { step: number; path?: string | undefined; pages?: number | undefined } | null {
  const inputAction = record(row.input)['action'];
  if (inputAction !== undefined && inputAction !== 'extract') return null;
  const { text, output } = readDesignReferenceResult(row.output);
  if ((inputAction ?? output['action']) !== 'extract') return null;
  let step = 1;
  for (const line of row.progress) {
    // The journal coalesces consecutive log frames into a single multiline entry.
    for (const match of line.matchAll(/^[ \t]*\[([1-4])\/4\]/gm))
      step = Math.max(step, Number(match[1]));
  }
  if (row.status !== 'done') return { step };

  // The result's generic `path` is normally dna.md. Only offer a spec the engine reported.
  const named = /^Full 10-section DESIGN\.md specification:\s*([^\r\n]+)$/im.exec(text)?.[1];
  const saved = /^Saved:\s*([^\s{]+)[/\\]\{[^}\r\n]*\bDESIGN\.md\b[^}\r\n]*\}/im.exec(text)?.[1];
  const paths = [
    named?.trim().replace(/\.$/, ''),
    saved ? `${saved}/DESIGN.md` : undefined,
    typeof output['path'] === 'string' ? output['path'] : undefined,
    ...row.files.map((file) => file.path),
  ];
  const path = paths.flatMap((candidate) =>
    candidate ? (designSpecPath(candidate, projectRoot) ?? []) : [],
  )[0];
  const count = /\((\d+)\s+page\(s\)\s+analyzed\b/i.exec(text)?.[1];
  const pages = count ? Number(count) : undefined;
  return { step: 4, path, pages: pages && Number.isSafeInteger(pages) ? pages : undefined };
}
