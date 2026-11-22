/** Versioned, bounded execution evidence. Completion alone is never a test verdict. */
export interface AutomationResult {
  version: 1;
  agentStatus: string | null;
  sessionId: string | null;
  finalText: string | null;
  durationMs: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    iterations: number | null;
    costUsd: number | null;
    costSource: 'catalog-estimate' | 'unknown';
  };
  changedFiles: string[];
  changedFilesTruncated: boolean;
  validation: import('@wrongstack/webui-protocol').AutomationValidation;
}

export function buildAutomationResult(
  output: string,
  patch: string | null,
  durationMs: number,
): AutomationResult {
  let payload: Record<string, unknown> = {};
  for (const line of output.split('\n').reverse()) {
    const recordLine = line.trim();
    if (!recordLine.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(recordLine);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (
        ['done', 'completed', 'failed', 'aborted', 'max_iterations'].includes(
          String(record['status']),
        )
      ) {
        payload = record;
        break;
      }
    } catch {
      // Incomplete objects and malformed quoted JSON may be the final result.
      // Complete braced diagnostics such as {stderr message} are ordinary logs.
      if (!recordLine.endsWith('}') || /^\{\s*"/.test(recordLine)) break;
    }
  }
  const usage =
    payload['usage'] && typeof payload['usage'] === 'object'
      ? (payload['usage'] as Record<string, unknown>)
      : {};
  const number = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const files = new Set<string>();
  let oldLines = 0;
  let newLines = 0;
  // A file section names its paths in `---`/`+++` headers only when it has a
  // text hunk. Binary files (`GIT binary patch`), empty new files, pure
  // renames/copies and mode-only changes carry none, so they fall back to the
  // `rename from|to` / `copy to` lines and, failing that, to the `diff --git`
  // header.
  let sectionNamed = true;
  let headerPath: string | undefined;
  const add = (raw: string, prefixed: boolean): void => {
    let decoded = decodeGitPath(raw);
    if (prefixed) {
      if (!decoded.startsWith('a/') && !decoded.startsWith('b/')) return;
      decoded = decoded.slice(2);
    }
    if (decoded && decoded.length <= 4096 && !/[\x00-\x1f\x7f]/.test(decoded)) {
      files.add(decoded);
      sectionNamed = true;
    }
  };
  const flushSection = (): void => {
    if (!sectionNamed && headerPath !== undefined) add(headerPath, true);
  };
  for (const line of (patch ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      flushSection();
      oldLines = newLines = 0;
      sectionNamed = false;
      headerPath = diffGitHeaderPath(line.slice('diff --git '.length));
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLines = Number(hunk[1] ?? 1);
      newLines = Number(hunk[2] ?? 1);
      continue;
    }
    // Hunk text can itself start with +++/---; only file headers name paths.
    if (oldLines > 0 || newLines > 0) {
      if (line.startsWith('-') || line.startsWith(' ')) oldLines--;
      if (line.startsWith('+') || line.startsWith(' ')) newLines--;
      continue;
    }
    // A copy leaves its source untouched; a rename changes both paths.
    const moved = /^(?:rename (?:from|to)|copy to) (.+)$/.exec(line);
    if (moved) {
      add(moved[1]!, false);
      continue;
    }
    if (!line.startsWith('+++ ') && !line.startsWith('--- ')) continue;
    // Git ends the header with a TAB when the name contains a space (GNU diff
    // convention); left in place, the control-character filter dropped every
    // such file from changedFiles.
    add(line.slice(4).replace(/\t$/, ''), true);
  }
  flushSection();
  const costSource = usage['costSource'] === 'catalog-estimate' ? 'catalog-estimate' : 'unknown';
  return {
    version: 1,
    agentStatus: typeof payload['status'] === 'string' ? payload['status'] : null,
    sessionId: typeof payload['sessionId'] === 'string' ? payload['sessionId'].slice(0, 256) : null,
    finalText:
      typeof payload['finalText'] === 'string' ? payload['finalText'].slice(0, 16_384) : null,
    durationMs: Math.max(0, Math.round(durationMs)),
    usage: {
      inputTokens: number(usage['input']),
      outputTokens: number(usage['output']),
      iterations: number(usage['iterations']),
      costUsd: costSource === 'catalog-estimate' ? number(usage['cost']) : null,
      costSource,
    },
    changedFiles: [...files].slice(0, 200),
    changedFilesTruncated: files.size > 200,
    validation: {
      status: 'not-verified',
      evidence: patch === null ? ['output.log'] : ['output.log', 'changes.patch'],
    },
  };
}

/** Decode a Git C-quoted path (`"src/\303\247.ts"`); unquoted paths pass through. */
function decodeGitPath(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const bytes: Buffer[] = [];
  for (let i = 1; i < raw.length - 1; i++) {
    if (raw[i] === '\\' && /[0-7]{3}/.test(raw.slice(i + 1, i + 4))) {
      bytes.push(Buffer.from([Number.parseInt(raw.slice(i + 1, i + 4), 8)]));
      i += 3;
    } else if (raw[i] === '\\' && i + 1 < raw.length - 1) {
      const escaped = raw[++i]!;
      bytes.push(
        Buffer.from(
          // Every escape Git's quote_c_style writes, including \a \b \v \f.
          (
            {
              a: '\x07',
              b: '\b',
              t: '\t',
              n: '\n',
              v: '\v',
              f: '\f',
              r: '\r',
              '\\': '\\',
              '"': '"',
            } as Record<string, string>
          )[escaped] ?? escaped,
        ),
      );
    } else {
      const point = raw.codePointAt(i)!;
      bytes.push(Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) i++;
    }
  }
  return Buffer.concat(bytes).toString('utf8');
}

/** End index (exclusive) of the C-quoted token that starts at `start`. */
function quotedTokenEnd(value: string, start: number): number {
  for (let i = start + 1; i < value.length; i++) {
    if (value[i] === '\\') i++;
    else if (value[i] === '"') return i + 1;
  }
  return -1;
}

/**
 * The `b/` side of a `diff --git a/<old> b/<new>` header, still in its
 * (possibly quoted) wire form. Only used for sections without `---`/`+++`
 * or rename lines, where both sides name the same file — which is what makes
 * an unquoted name containing spaces splittable at its midpoint.
 */
function diffGitHeaderPath(header: string): string | undefined {
  if (header.startsWith('"')) {
    const end = quotedTokenEnd(header, 0);
    return end > 0 && header[end] === ' ' ? header.slice(end + 1) : undefined;
  }
  if (header.endsWith('"')) {
    const start = header.lastIndexOf(' "b/');
    return start >= 0 ? header.slice(start + 1) : undefined;
  }
  if (header.length % 2 === 0) return undefined;
  const mid = (header.length - 1) / 2;
  const left = header.slice(0, mid);
  const right = header.slice(mid + 1);
  return header[mid] === ' ' &&
    left.startsWith('a/') &&
    right.startsWith('b/') &&
    left.slice(2) === right.slice(2)
    ? right
    : undefined;
}
