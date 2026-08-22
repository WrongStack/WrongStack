export interface FileDiffEntry {
  path: string;
  operation: 'create' | 'modify' | 'delete';
  linesAdded: number;
  linesRemoved: number;
}

export interface TestResult {
  testPattern: string;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  /** Truncated failure output when tests fail. */
  failureOutput?: string | undefined;
}

/** Parse `git diff --name-status` into file-operation evidence. */
export function parseGitNameStatus(output: string): Map<string, FileDiffEntry['operation']> {
  const operations = new Map<string, FileDiffEntry['operation']>();
  for (const line of output.split('\n').filter(Boolean)) {
    const [status = '', ...pathParts] = line.split('\t');
    const filePath = pathParts.at(-1);
    if (!filePath) continue;
    operations.set(
      filePath,
      status.startsWith('A') ? 'create' : status.startsWith('D') ? 'delete' : 'modify',
    );
  }
  return operations;
}

/** Parse `git diff --numstat` output into structured entries. */
export function parseGitNumstat(
  output: string,
  operations: ReadonlyMap<string, FileDiffEntry['operation']> = new Map(),
): FileDiffEntry[] {
  return output
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length < 3) return null;
      const added = parseInt(parts[0]!, 10) || 0;
      const removed = parseInt(parts[1]!, 10) || 0;
      const filePath = parts[2] ?? '';
      return {
        path: filePath,
        operation: operations.get(filePath) ?? 'modify',
        linesAdded: added,
        linesRemoved: removed,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

export function isTestCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isTestJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate['testResults']) ||
    (isTestCount(candidate['numPassedTests']) && isTestCount(candidate['numFailedTests']))
  );
}

export function parseTestJsonObject(output: string): Record<string, unknown> | null {
  try {
    const complete = JSON.parse(output.trim()) as unknown;
    if (isTestJsonObject(complete)) return complete;
  } catch {
    // Surrounding runner output requires balanced-object extraction below.
  }

  for (let start = output.indexOf('{'); start >= 0; start = output.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(output.slice(start, index + 1)) as unknown;
            if (isTestJsonObject(parsed)) return parsed;
          } catch {
            // Keep scanning: runner output can contain unrelated brace-delimited text.
          }
          break;
        }
      }
    }
  }
  return null;
}

/** Try to parse JSON test runner output. */
export function tryParseTestJson(
  output: string,
  pattern: string,
): Omit<TestResult, 'durationMs'> | null {
  try {
    const parsed = parseTestJsonObject(output);
    if (parsed) {
      const numPassedTestsValue = parsed['numPassedTests'];
      const numFailedTestsValue = parsed['numFailedTests'];
      const numSkippedTestsValue = parsed['numSkippedTests'];
      const successValue = parsed['success'];
      const numPassed =
        typeof numPassedTestsValue === 'number'
          ? numPassedTestsValue
          : typeof successValue === 'boolean'
            ? successValue
              ? 1
              : 0
            : 0;
      const numFailed =
        typeof numFailedTestsValue === 'number'
          ? numFailedTestsValue
          : typeof successValue === 'boolean'
            ? successValue
              ? 0
              : 1
            : 0;
      const numSkipped = typeof numSkippedTestsValue === 'number' ? numSkippedTestsValue : 0;
      return {
        testPattern: pattern,
        passed: numPassed,
        failed: numFailed,
        skipped: numSkipped,
      };
    }
  } catch {
    // Not JSON output — fall through
  }
  return null;
}
