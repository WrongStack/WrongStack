const GLOB_METACHARACTERS = /[*?[\]]/g;

export function escapeGlobSubject(value: string): string {
  return value.replace(GLOB_METACHARACTERS, (char) => `\\${char}`);
}

export function normalizePathSubject(value: string): string {
  return escapeGlobSubject(value.replace(/\\/g, '/'));
}

export function isPathSubjectKey(subjectKey: string): boolean {
  return subjectKey === 'path' || subjectKey === 'file' || subjectKey === 'files';
}

/**
 * Render `command` + `args` as one command line (WS-046).
 *
 * A tool like `exec` takes the program in `command` and its arguments in a
 * separate `args` array. Using `command` alone as the permission subject would
 * make `exec git status` and `exec git push --force` the same subject, so
 * trusting the first would silently authorize the second. The subject has to be
 * the whole invocation to mean anything.
 *
 * Arguments containing whitespace are quoted so the rendering is unambiguous
 * and stable: the subject doubles as the stored trust pattern, so two different
 * argument lists must never render to the same string.
 */
function renderCommandLine(command: string, args: unknown): string {
  if (!Array.isArray(args) || args.length === 0) return command;
  const rendered = args
    .filter((arg): arg is string => typeof arg === 'string')
    .map((arg) => (/\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg));
  return rendered.length > 0 ? [command, ...rendered].join(' ') : command;
}

export function subjectForToolInput(
  toolName: string,
  input: unknown,
  subjectKey?: string,
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;

  if (subjectKey) {
    const value = obj[subjectKey];
    if (typeof value === 'string') {
      if (isPathSubjectKey(subjectKey)) return normalizePathSubject(value);
      // A `command` subject renders the full invocation, not just the program.
      // `bash` is unaffected — it has no `args`, its command IS the line.
      if (subjectKey === 'command') return escapeGlobSubject(renderCommandLine(value, obj['args']));
      return escapeGlobSubject(value);
    }
  }

  if (toolName === 'bash' && typeof obj.command === 'string') {
    return escapeGlobSubject(obj.command);
  }
  if (typeof obj.path === 'string') {
    return normalizePathSubject(obj.path);
  }
  if (typeof obj.url === 'string') {
    return escapeGlobSubject(obj.url);
  }
  if (typeof obj.name === 'string') {
    return escapeGlobSubject(obj.name);
  }
  return undefined;
}
