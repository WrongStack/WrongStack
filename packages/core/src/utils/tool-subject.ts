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
  // Coerce every arg to a string so non-string args — numbers, booleans,
  // nested objects — are included rather than silently dropped (regression
  // from the WS-046 string-only filter). Whitespace-bearing args are quoted
  // so distinct argument lists never render to the same subject string.
  const rendered = args.map((arg) => {
    const str = String(arg);
    return /\s/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str;
  });
  return [command, ...rendered].join(' ');
}

/**
 * Render extra named fields for the subject, in the order the tool declared
 * them. Absent, empty and `false` values are skipped so the common invocation
 * keeps a short, readable subject and only the fields that were actually
 * supplied narrow the rule.
 */
function renderSubjectFields(obj: Record<string, unknown>, fields: readonly string[]): string {
  const parts: string[] = [];
  for (const field of fields) {
    const value = obj[field];
    if (value === undefined || value === null || value === '' || value === false) continue;
    const str = String(value);
    parts.push(`${field}=${/\s/.test(str) ? `"${str.replace(/"/g, '\\"')}"` : str}`);
  }
  return parts.join(' ');
}

export function subjectForToolInput(
  toolName: string,
  input: unknown,
  subjectKey?: string,
  subjectFields?: readonly string[],
): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const extra =
    subjectFields && subjectFields.length > 0 ? renderSubjectFields(obj, subjectFields) : '';
  const withExtra = (base: string): string => (extra ? `${base} ${extra}` : base);

  if (subjectKey) {
    const value = obj[subjectKey];
    if (Array.isArray(value)) {
      // Structured batch tools (for example `todo`) still need a stable,
      // per-invocation permission subject. JSON preserves array order and
      // object insertion order from the validated input; escaping glob
      // metacharacters keeps the stored trust rule literal.
      return escapeGlobSubject(JSON.stringify(value));
    }
    if (typeof value === 'string') {
      if (isPathSubjectKey(subjectKey)) {
        const normalized = normalizePathSubject(value);
        // A check-only format and a dry-run replace (the default) must each get
        // a distinct subject from their real invocation (over-grant). `files` is
        // shared by format and replace, but their preview flags differ (format:
        // `check`, replace: `dry_run`), so the conditions don't collide.
        if (subjectKey === 'files' && obj['check'] === true) return `${normalized}:check`;
        if (subjectKey === 'files' && obj['dry_run'] === true) return `${normalized}:dry-run`;
        return normalized;
      }
      // A `command` subject renders the full invocation, not just the program.
      // `bash` is unaffected — it has no `args`, its command IS the line.
      if (subjectKey === 'command') {
        const rendered = renderCommandLine(value, obj['args']);
        // A dry-run `git commit` must not share a subject with a real commit
        // (over-grant). `dry_run` only applies to git's commit subcommand;
        // exec/bash have no `dry_run` flag, so this only matches
        // `git commit --dry-run`.
        if (value === 'commit' && obj['dry_run'] === true) {
          return `${escapeGlobSubject(withExtra(rendered))}:dry-run`;
        }
        return escapeGlobSubject(withExtra(rendered));
      }
      // A dry-run patch must not share a subject with a real patch on the same
      // directory: trusting a preview would otherwise silently authorize the
      // actual application (over-grant). Mirror the `command` special-case.
      if (subjectKey === 'directory' && obj['dry_run'] === true) {
        return `${escapeGlobSubject(value)}:dry-run`;
      }
      // A dry-run install must not share a subject with a real install of the
      // same packages: trusting a preview would otherwise silently authorize the
      // actual install (over-grant). (format/replace preview flags are handled
      // in the path-subject branch above, since their subjectKey `files` is a
      // path key.)
      if (subjectKey === 'packages' && obj['dry_run'] === true) {
        return `${escapeGlobSubject(value)}:dry-run`;
      }
      // A dry-run scaffold must not share a subject with a real scaffold of the
      // same name (over-grant). `name` is scaffold's subjectKey; no other tool
      // uses it, so this only matches scaffold.
      if (subjectKey === 'name' && obj['dry_run'] === true) {
        return `${escapeGlobSubject(value)}:dry-run`;
      }
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
