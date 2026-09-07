/**
 * Rendering half of the repo map: turning a ranked candidate list into
 * budgeted skeleton sections. Shared by the graph-ranked generator and the
 * filesystem fallback so the two produce the same section format.
 */

import * as fs from 'node:fs/promises';
import { extractFileSkeleton, type SkeletonOptions } from './skeleton-extractor.js';

/** Marker appended when a section had to be cut to fit the budget. */
const TRUNCATION_NOTE = '\n  // … signatures truncated to fit the token budget';

/**
 * Cut `text` to at most `limit` characters on a line boundary, so the result
 * never ends mid-signature — a half-written declaration reads as real code.
 */
function truncateAtLine(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
}

/** A line consisting only of comment syntax, in any of the indexed languages. */
const COMMENT_ONLY_LINE = /^\s*(?:\/\/|\/\*|\*\/|\*|#|--|<!--|-->)/;

/**
 * Drop comment-only lines from a skeleton.
 *
 * `SkeletonOptions.includeDocs: false` suppresses per-symbol docs but leaves
 * the file's own banner comment, which on a large module is hundreds of
 * characters of prose ahead of the first declaration. Under a per-file cap
 * that means the map keeps the paragraph and truncates away every signature —
 * the exact opposite of what a map is for.
 *
 * Falls back to the original when stripping would leave nothing, so a file
 * that really is all comments still shows something.
 */
function stripCommentLines(body: string): string {
  const kept = body.split('\n').filter((line) => !COMMENT_ONLY_LINE.test(line));
  const joined = kept.join('\n').trim();
  return joined.length > 0 ? joined : body;
}

export interface RepoMapCandidate {
  /** Absolute path, for reading. */
  absolute: string;
  /** Project-relative POSIX path, for display. */
  relative: string;
}

export interface RenderSectionsOptions {
  skeleton?: SkeletonOptions | undefined;
  /**
   * Largest a single file's section may be. Without it one 9k-token type
   * module consumes the entire budget and the "map" describes one file. The
   * point of a map is breadth, so each file gets a slice and the rest of the
   * budget goes to the next-most-central file.
   */
  maxSectionChars?: number | undefined;
  /**
   * Drop comment-only lines so the budget buys declarations, not prose.
   * On for the map body; off for callers that want the skeleton verbatim.
   */
  signaturesOnly?: boolean | undefined;
}

export interface RenderedSections {
  sections: string[];
  /** Relative paths actually included, in order. */
  files: string[];
  /** Characters consumed by `sections`, including the blank-line separators. */
  chars: number;
}

/**
 * Extract skeletons for `candidates` in order until `charBudget` is exhausted.
 *
 * Unreadable and empty files are skipped rather than ending the walk, so one
 * deleted-since-index path cannot truncate the whole map.
 */
export async function renderSkeletonSections(
  candidates: readonly RepoMapCandidate[],
  charBudget: number,
  options: RenderSectionsOptions = {},
): Promise<RenderedSections> {
  const sections: string[] = [];
  const files: string[] = [];
  const maxSectionChars = options.maxSectionChars ?? Number.POSITIVE_INFINITY;
  let chars = 0;

  for (const candidate of candidates) {
    if (chars >= charBudget) break;

    let content: string;
    try {
      content = await fs.readFile(candidate.absolute, 'utf8');
    } catch {
      continue;
    }
    if (content.length === 0) continue;

    let skeleton: Awaited<ReturnType<typeof extractFileSkeleton>>;
    try {
      skeleton = await extractFileSkeleton({
        file: candidate.absolute,
        content,
        options: {
          exportsOnly: true,
          collapseImports: true,
          includeDocs: false,
          includeLineNumbers: true,
          ...(options.skeleton ?? {}),
        },
      });
    } catch {
      continue;
    }

    const body = skeleton.skeleton.trim();
    if (!body) continue;

    const indented = (options.signaturesOnly === true ? stripCommentLines(body) : body)
      .split('\n')
      .map((line) => (line.trim() ? `  ${line}` : ''))
      .join('\n');
    const header = `${candidate.relative} (${skeleton.lang}):\n`;
    // A section may use at most its per-file cap, and never more than what is
    // left of the overall budget. Truncating rather than skipping matters for
    // the first file: the most central file in a real repo is often a large
    // type module, and returning it whole would blow the caller's budget while
    // returning nothing would make the map useless.
    const room =
      Math.min(maxSectionChars, charBudget - chars) - header.length - TRUNCATION_NOTE.length - 2;
    let section: string;
    if (indented.length <= room) {
      section = header + indented;
    } else {
      if (room <= 0) break;
      section = `${header}${truncateAtLine(indented, room)}${TRUNCATION_NOTE}`;
    }
    const sectionChars = section.length + 2;
    if (chars + sectionChars > charBudget && files.length > 0) break;

    sections.push(section);
    files.push(candidate.relative);
    chars += sectionChars;
  }

  return { sections, files, chars };
}
