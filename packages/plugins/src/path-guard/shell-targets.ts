import { isDirectoryAmbiguousPath, isUnresolvedPathScope, resolveTargetPath } from './glob.js';
import { maskNonExecutingHeredocBodies } from './shell-heredocs.js';
import {
  COMMAND_PATH_PREFIX,
  gitInvocationArguments,
  gitSubcommandIndex,
  shellTokens,
  stripTransparentLaunchers,
  VALUE_TAKING_GIT_OPTIONS,
} from './shell-launchers.js';
import {
  executableCommandSubstitutions,
  isQuoteBoundary,
  quoteIsEscaped,
} from './shell-quoting.js';

/**
 * xargs option run: bridges any mix of flag tokens and VALUE-taking options
 * (`-n 1`, `-I {}`, `--replace={}`) between `xargs` and the writer it
 * launches. A flags-only run (`(?:\s+-[^\s]+)*`) cannot span a value-taking
 * option, so `xargs -n 1 tee .env` reached the writer boundary unmatched and
 * the writer was never inspected (probe-verified 2026-08-17, chimera
 * review). Value-consuming options are enumerated explicitly so a flag-only
 * `-0` never swallows the writer command as its value.
 *
 * The value is `[^\s-][^\s]*` — NOT `[^\s]+` — and that single character is
 * load-bearing for availability, not just correctness. With `[^\s]+` both
 * alternatives match a token like `-I`: the first consumes it as an option
 * plus the FOLLOWING token as that option's value, while the second consumes
 * it alone as a flag. Every token then forks the parse, so an input of
 * repeated `-I ` costs exponential time in a regex that runs synchronously on
 * the main thread over a model-supplied command (measured before this fix:
 * 731 ms at 110 characters, 19.7 s at 128, 52 s at 134). Requiring the value
 * not to begin with `-` makes the branches mutually exclusive and collapses
 * the search: 0.2 ms at the same 128-character input, 0.6 ms at 20,000.
 *
 * Refusing a `-`-leading value is also the safe direction semantically — such
 * a token is treated as another flag, so scanning continues toward the writer
 * rather than swallowing it as an option value.
 *
 * The value-taking set is GNU's `-a -d -E -I -L -n -P -s` plus BSD's
 * `-J -R -S`. A missing one (`-d @`, `-a list`) left its value standing where
 * the writer was expected, so `xargs -d @ rm .env` named no target at all.
 * GNU's `-e`/`-i`/`-l` take only an attached value and must stay flags, or
 * `xargs -e rm .env` would swallow `rm` the same way.
 */
const XARGS_OPTIONS = String.raw`(?:\s+(?:(?:-[adEIJLnPRSs]|--(?:arg-file|delimiter|replace|max-args|max-lines|max-chars|max-procs|process-slot-var))\s+[^\s-][^\s]*|-[^\s]+))*`;

/**
 * Command-start boundary shared by every destructive-writer rule. All writer
 * rules (rm-family, cp|install, tee, dd, sed|ln, find) MUST use this same
 * class: a rule that only knows `[;&|\r\n]` is blind to `{ group; }`,
 * `( subshell )` and `xargs` continuations, which silently exempts that
 * writer from the guard — probe-verified 2026-08-17, where `{ cp src .env; }`
 * and `( dd if=src of=.env )` returned zero targets. The `(?<![$(])`
 * lookbehind keeps `$(` / `((` substitution opens off this path; substitution
 * bodies are inspected by the recursive destructiveTargetsAtDepth pass.
 */
const COMMAND_BOUNDARY = String.raw`(?:^|[;&|\r\n]\s*|\{\s*|(?<![$(])\(\s*|\bxargs${XARGS_OPTIONS}\s+)`;

/**
 * F16: git's parse-options and PowerShell accept any UNAMBIGUOUS long-option
 * (parameter) prefix — `git reset --har` ≡ `--hard`, `rm --rec` ≡
 * `--recursive`, `Remove-Item -rec` ≡ `-Recurse` (verified empirically in the
 * core F6/F8 rounds). Exact-equality matching let the abbreviated spellings
 * evade the recursive-delete / reset / restore scope classification: a
 * deletion-scope downgraded to a file target (or dropped entirely), so a
 * recursive delete of protected descendants drew no verdict. `minLen` is the
 * shortest unambiguous prefix for THAT command's option set (e.g. reset's
 * --merge needs "me": "m" collides with --mixed); over-matching only makes
 * the guard stricter (fail-safe). An attached `=value` is ignored for the
 * name match.
 */
function longOptionPrefix(token: string, name: string, minLen: number): boolean {
  if (!token.startsWith('--')) return false;
  const opt = token.slice(2).split('=', 1)[0]!;
  return opt.length >= minLen && name.startsWith(opt);
}

export function commandRecursivelyDeletes(command: string): boolean {
  const stripped = stripTransparentLaunchers(maskNonExecutingHeredocBodies(command));
  if (
    new RegExp(
      String.raw`(?:^|[;&|\r\n]\s*|\{\s*|\$\(\s*|\(\s*|\u0060\s*)${COMMAND_PATH_PREFIX}find\b[^;&|)\u0060]*(?:-delete\b|-exec(?:dir)?\s+(?:[^\s;&|]+[\\/])?(?:rm|rmdir)\b)`,
      'i',
    ).test(stripped)
  ) {
    return true;
  }
  const destructive = new RegExp(
    String.raw`${COMMAND_BOUNDARY}${COMMAND_PATH_PREFIX}(rm|rmdir|del|erase|rd|Remove-Item|ri)\s+((?:"[^"]*"|'[^']*'|\\.|\{[^}]*\}|\([^()]*\)|[^;&|\r\n}])+)`,
    'gi',
  );
  let match: RegExpExecArray | null = destructive.exec(stripped);
  while (match !== null) {
    const tool = match[1]?.toLowerCase();
    if (tool === 'rmdir') return true;

    const tokens = (match[2]?.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? []).map((arg) =>
      arg.replace(/^["']|["']$/g, ''),
    );
    let recursive = false;
    for (const token of tokens) {
      if (token === '--') break;
      if (tool === 'rm') {
        // F16: rm's only r-option is --recursive (--r… unambiguous).
        if (longOptionPrefix(token, 'recursive', 1) || /^-[^-]*[rR]/.test(token)) recursive = true;
      } else if (tool === 'remove-item' || tool === 'ri') {
        // F16: PowerShell binds any unambiguous parameter-name prefix
        // (-rec, -recu … are -Recurse), case-insensitive, incl. :$true.
        if (/^-(?:r|re(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)(?::\$true)?$/i.test(token)) recursive = true;
      } else if (/^\/[a-z]*s[a-z]*$/i.test(token)) {
        recursive = true;
      }
    }
    if (recursive) return true;
    match = destructive.exec(stripped);
  }
  return false;
}

export const MAX_DESTRUCTIVE_TARGET_DEPTH = 64;

/**
 * Strip trailing `)` characters that close an enclosing subshell rather than
 * belonging to the operand text. In the compact form `(cp src .env)` the
 * closer glues onto the capture (`src .env)`) and the destination tokenizes
 * as `.env)` — which matches no protect glob, silently defeating the guard
 * (chimera review 2026-08-17). A `)` that balances an earlier `(` inside the
 * text is filename punctuation (`notes(2)`) and is preserved; parens inside
 * quotes are ignored, so quoted operands ending in `)` survive too.
 */
function stripSubshellClosers(raw: string): string {
  let result = raw.trimEnd();
  while (result.endsWith(')')) {
    // An escaped trailing `\)` is filename text, not a subshell closer —
    // stripping it corrupted the reported target (`protected\)` became
    // `protected\`, matching no protect glob). Same convention as
    // executableCommandSubstitutions: escaped parens do not count.
    if (quoteIsEscaped(result, result.length - 1)) break;
    let quote: "'" | '"' | null = null;
    let depth = 0;
    for (let index = 0; index < result.length - 1; index += 1) {
      const char = result[index];
      if (isQuoteBoundary(result, index, quote)) {
        quote = quote === char ? null : char === "'" ? "'" : '"';
        continue;
      }
      if (quote !== null) continue;
      if (char === '(' && !quoteIsEscaped(result, index)) depth += 1;
      else if (char === ')' && !quoteIsEscaped(result, index)) depth -= 1;
    }
    // Keep the closer only when it balances an open paren in the operand.
    if (depth > 0) break;
    result = result.slice(0, -1).trimEnd();
  }
  return result;
}

export function destructiveTargets(command: string): string[] {
  return destructiveTargetsAtDepth(command, 0);
}

export function destructiveTargetsAtDepth(command: string, depth: number): string[] {
  if (depth >= MAX_DESTRUCTIVE_TARGET_DEPTH) return ['**'];

  const normalizedCommand = stripTransparentLaunchers(maskNonExecutingHeredocBodies(command));
  const targets: string[] = [];
  const quotedIndexes = new Uint8Array(normalizedCommand.length);
  let activeQuote: "'" | '"' | null = null;
  for (let index = 0; index < normalizedCommand.length; index += 1) {
    const char = normalizedCommand[index];
    if (isQuoteBoundary(normalizedCommand, index, activeQuote)) {
      quotedIndexes[index] = 1;
      activeQuote = activeQuote === char ? null : char === "'" ? "'" : '"';
    } else if (activeQuote !== null) {
      quotedIndexes[index] = 1;
    }
  }
  const tokenIsQuoted = (match: RegExpExecArray, token: string): boolean => {
    // Located in the original text: lowercasing the whole match first moves
    // every later offset when it holds a character whose lowercase form is
    // longer (`İ` → `i̇`), which read the quote map at the wrong index.
    const needle = token.toLowerCase();
    let offset = -1;
    for (let index = 0; index + token.length <= match[0].length; index += 1) {
      if (match[0].slice(index, index + token.length).toLowerCase() === needle) {
        offset = index;
        break;
      }
    }
    return offset >= 0 && quotedIndexes[match.index + offset] === 1;
  };
  const shellOperandTokens = (raw: string): string[] => {
    const tokens = shellTokens(raw);
    const redirectIndex = tokens.findIndex((token) => /^(?:\d*(?:<>|>>?|<)|&>>?)/.test(token));
    return redirectIndex === -1 ? tokens : tokens.slice(0, redirectIndex);
  };
  const shellArgs = (raw: string): string[] => {
    const lastNonWhitespace = raw.search(/\s*$/) - 1;
    let quote: "'" | '"' | null = null;
    for (let index = 0; index < lastNonWhitespace; index += 1) {
      if (isQuoteBoundary(raw, index, quote)) {
        const char = raw[index];
        quote = quote === char ? null : char === "'" ? "'" : '"';
      }
    }
    const args =
      raw[lastNonWhitespace] === ')' && quote === null && !quoteIsEscaped(raw, lastNonWhitespace)
        ? raw.slice(0, lastNonWhitespace)
        : raw;
    return shellOperandTokens(args).filter((arg) => arg.length > 0 && !arg.startsWith('-'));
  };

  for (const body of executableCommandSubstitutions(normalizedCommand)) {
    let executableBody = body.trim();
    while (executableBody.startsWith('(') && executableBody.endsWith(')')) {
      executableBody = executableBody.slice(1, -1).trim();
    }
    targets.push(...destructiveTargetsAtDepth(executableBody, depth + 1));
  }

  const destructive = new RegExp(
    // `erase` is cmd's alias of del; `ri` is PowerShell's alias of Remove-Item.
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?${COMMAND_PATH_PREFIX}(rm|rmdir|del|erase|rd|Remove-Item|ri|unlink|truncate|shred|mv)\s+((?:"[^"]*"|'[^']*'|\\.|\{[^}]*\}|\([^()]*\)|[^;&|\r\n}])+)`,
    'gi',
  );
  let m: RegExpExecArray | null = destructive.exec(normalizedCommand);
  while (m !== null) {
    // No stripSubshellClosers needed here: shellArgs() already drops one
    // trailing subshell closer and keeps it when escaped (`.env\)` stays
    // literal filename text) — the same convention stripSubshellClosers
    // enforces for the cp/install and dd paths.
    if (!tokenIsQuoted(m, m[1] ?? '')) targets.push(...shellArgs(m[2] ?? ''));
    m = destructive.exec(normalizedCommand);
  }

  // PowerShell writers. Only Remove-Item/ri (above) and redirection were
  // known, so Set-Content, Out-File, Copy-Item… — the way the pwsh tool writes
  // a file — named no target and `.env` was writable through them. Every
  // operand counts, as for `mv`: a `-Value` that happens to name a protected
  // path only over-blocks. A colon-bound `-Path:.env` is read too; dropping
  // every `-`-token hid it, from Remove-Item as well.
  const pwshWriter = new RegExp(
    String.raw`${COMMAND_BOUNDARY}${COMMAND_PATH_PREFIX}(Set-Content|Add-Content|ac|Clear-Content|clc|Out-File|Tee-Object|New-Item|ni|Copy-Item|cpi|copy|Move-Item|mi|move|Rename-Item|rni|ren|Remove-Item|ri)\s+((?:"[^"]*"|'[^']*'|\\.|\{[^}]*\}|\([^()]*\)|[^;&|\r\n}])+)`,
    'gi',
  );
  let p: RegExpExecArray | null = pwshWriter.exec(normalizedCommand);
  while (p !== null) {
    if (!tokenIsQuoted(p, p[1] ?? '')) {
      for (const token of shellOperandTokens(stripSubshellClosers(p[2] ?? ''))) {
        const bound = /^-[A-Za-z]+:(.+)$/.exec(token);
        if (bound?.[1]) targets.push(bound[1]);
        else if (token.length > 0 && !token.startsWith('-')) targets.push(token);
      }
    }
    p = pwshWriter.exec(normalizedCommand);
  }

  const copy = new RegExp(
    // rsync takes its destination last, like cp.
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?${COMMAND_PATH_PREFIX}(cp|install|rsync)\s+([^;&|\r\n]+)`,
    'gi',
  );
  let c: RegExpExecArray | null = copy.exec(normalizedCommand);
  while (c !== null) {
    if (tokenIsQuoted(c, c[1] ?? '')) {
      c = copy.exec(normalizedCommand);
      continue;
    }
    // Strip subshell closers from the raw capture before tokenizing: in the
    // compact form `(cp src .env)` the closer glues onto the destination
    // token (`.env)`), which matches no protect glob. Done at the raw level
    // (not per token) so balanced parens in filenames (`notes(2)`) and
    // quoted operands survive.
    const tokens = shellTokens(stripSubshellClosers(c[2] ?? ''));
    let destination: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === '-t' || token === '--target-directory') {
        destination = tokens[index + 1];
        break;
      }
      if (token?.startsWith('--target-directory=')) {
        destination = token.slice('--target-directory='.length);
        break;
      }
    }
    destination ??= tokens.filter((arg) => arg.length > 0 && !arg.startsWith('-')).at(-1);
    if (destination) targets.push(destination);
    c = copy.exec(normalizedCommand);
  }

  const tee = new RegExp(
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?${COMMAND_PATH_PREFIX}(tee)\s+([^;&|\r\n]+)`,
    'gi',
  );
  let t: RegExpExecArray | null = tee.exec(normalizedCommand);
  while (t !== null) {
    if (!tokenIsQuoted(t, t[1] ?? '')) targets.push(...shellArgs(t[2] ?? ''));
    t = tee.exec(normalizedCommand);
  }

  const dd = new RegExp(
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?${COMMAND_PATH_PREFIX}(dd)\s+([^;&|\r\n]+)`,
    'gi',
  );
  let d: RegExpExecArray | null = dd.exec(normalizedCommand);
  while (d !== null) {
    if (!tokenIsQuoted(d, d[1] ?? '')) {
      const outputMatch = /(?:^|\s)of=("[^"]*"|'[^']*'|[^\s]+)/i.exec(d[2] ?? '');
      // stripSubshellClosers runs before quote-stripping so a quoted operand
      // ending in `)` (`of="notes(2)"`) is not mistaken for subshell punctuation.
      let output = outputMatch?.[1]
        ? stripSubshellClosers(outputMatch[1]).replace(/^['"]|['"]$/g, '')
        : undefined;
      if (outputMatch && output) {
        // `of="a"/.env` writes a/.env: include the suffix glued after the quote.
        const after = (d[2] ?? '').slice(outputMatch.index + outputMatch[0].length);
        const glued = /^[^;&|\s]+/.exec(after)?.[0] ?? '';
        output = stripSubshellClosers(output + glued);
      }
      if (output) targets.push(output);
    }
    d = dd.exec(normalizedCommand);
  }

  const overwrite = new RegExp(
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?${COMMAND_PATH_PREFIX}(sed|perl|ln)\s+([^;&|\r\n]+)`,
    'gi',
  );
  let o: RegExpExecArray | null = overwrite.exec(normalizedCommand);
  while (o !== null) {
    const rawArgs = o[2] ?? '';
    const tool = o[1]?.toLowerCase();
    if (tool && tokenIsQuoted(o, tool)) {
      o = overwrite.exec(normalizedCommand);
      continue;
    }
    // `perl -pi`/`-i.bak` edits in place like `sed -i`: the first operand is
    // the program (or the -e script), the rest are the files rewritten.
    if (
      (tool === 'sed' && /(?:^|\s)-i(?:[^\s]*)?(?:\s|$)/.test(rawArgs)) ||
      (tool === 'perl' && /(?:^|\s)-[aclnpstuwTUWX]*i/.test(rawArgs))
    ) {
      const args = shellArgs(rawArgs);
      targets.push(...args.slice(1));
    } else if (tool === 'ln' && /(?:^|\s)-[^\s]*f[^\s]*(?:\s|$)/.test(rawArgs)) {
      const destination = shellArgs(rawArgs).at(-1);
      if (destination) targets.push(destination);
    }
    o = overwrite.exec(normalizedCommand);
  }

  // Writers that name their output with an option: `curl -o`, `wget -O`/`-o`
  // (document / log), `sort -o`. Attached (`-o.env`, `--output=.env`) and
  // clustered (`-sSo .env`) forms included.
  const OUTPUT_OPTIONS: Record<string, { short: string; long: string[] }> = {
    curl: { short: 'o', long: ['--output'] },
    wget: { short: 'Oo', long: ['--output-document', '--output-file'] },
    sort: { short: 'o', long: ['--output'] },
  };
  const outputWriter = new RegExp(
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?${COMMAND_PATH_PREFIX}(curl|wget|sort)\s+([^;&|\r\n]+)`,
    'gi',
  );
  let ow: RegExpExecArray | null = outputWriter.exec(normalizedCommand);
  while (ow !== null) {
    const spec = OUTPUT_OPTIONS[ow[1]?.toLowerCase() ?? ''];
    if (spec && !tokenIsQuoted(ow, ow[1] ?? '')) {
      const tokens = shellOperandTokens(stripSubshellClosers(ow[2] ?? ''));
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index] ?? '';
        const long = spec.long.find((name) => token === name || token.startsWith(`${name}=`));
        if (long) {
          const value = token === long ? tokens[index + 1] : token.slice(long.length + 1);
          if (value) targets.push(value);
          continue;
        }
        if (!/^-[^-]/.test(token)) continue;
        const at = [...token.slice(1)].findIndex((flag) => spec.short.includes(flag));
        if (at < 0) continue;
        const value = token.slice(at + 2) || tokens[index + 1];
        if (value) targets.push(value);
      }
    }
    ow = outputWriter.exec(normalizedCommand);
  }

  const xargsPipeline = new RegExp(
    String.raw`\b(?:echo|printf)\s+([^|]+)\|\s*xargs${XARGS_OPTIONS}\s+(?:sudo\s+)?${COMMAND_PATH_PREFIX}(?:rm|rmdir|del|unlink|truncate|shred)\b`,
    'gi',
  );
  let x: RegExpExecArray | null = xargsPipeline.exec(normalizedCommand);
  while (x !== null) {
    if (!tokenIsQuoted(x, 'xargs')) targets.push(...shellArgs(x[1] ?? ''));
    x = xargsPipeline.exec(normalizedCommand);
  }

  for (const rawArguments of gitInvocationArguments(normalizedCommand)) {
    const invocationTokens = shellOperandTokens(rawArguments);
    const commandIndex = gitSubcommandIndex(invocationTokens);
    if (commandIndex >= 0) {
      let gitCwd = '';
      let workTree: string | undefined;
      for (let index = 0; index < commandIndex; index += 1) {
        const token = invocationTokens[index] ?? '';
        if (token === '--') continue;
        const optionName =
          token.startsWith('-C') && token !== '-C' ? '-C' : (token.split('=', 1)[0] ?? token);
        let optionValue = token.includes('=') ? token.slice(token.indexOf('=') + 1) : undefined;
        if (token.startsWith('-C') && token !== '-C') optionValue = token.slice(2);
        if (VALUE_TAKING_GIT_OPTIONS.has(optionName) && optionValue === undefined) {
          optionValue = invocationTokens[index + 1];
          index += 1;
        }
        if (optionName === '-C' && optionValue)
          gitCwd = resolveTargetPath(optionValue, gitCwd || undefined);
        if (optionName === '--work-tree' && optionValue) workTree = optionValue;
      }
      const subcommand = invocationTokens[commandIndex]?.toLowerCase();
      const tokens = invocationTokens.slice(commandIndex + 1);
      const gitTreeRoot = workTree ? resolveTargetPath(workTree, gitCwd || undefined) : gitCwd;
      const gitTarget = (target: string): string => {
        const resolved = resolveTargetPath(target, gitTreeRoot || undefined);
        return target.endsWith('/') && !resolved.endsWith('/') ? `${resolved}/` : resolved;
      };
      const gitPathspecTargets = (pathspec: string): string[] => {
        if (isUnresolvedPathScope(pathspec) || !isDirectoryAmbiguousPath(pathspec)) {
          return [gitTarget(pathspec)];
        }
        return [gitTarget(`${pathspec.replace(/\/$/, '')}/**`)];
      };
      const fileSourcedPathspecScope = (pathspecTokens: string[]): string | undefined => {
        const usesPathspecFile = pathspecTokens.some(
          (token, index) =>
            token.startsWith('--pathspec-from-file=') ||
            (token === '--pathspec-from-file' && pathspecTokens[index + 1] !== undefined),
        );
        return usesPathspecFile ? gitTarget('**') : undefined;
      };
      if (subcommand === 'clean') {
        const dryRun = tokens.some((t) => t === '--dry-run' || /^-[^-]*n/.test(t));
        if (!dryRun) {
          const operands: string[] = [];
          for (let i = 0; i < tokens.length; i += 1) {
            const t = tokens[i] ?? '';
            if (t === '-e' || t === '--exclude' || t === '--exclude-from') {
              i += 1;
              continue;
            }
            if (
              t.startsWith('--exclude=') ||
              t.startsWith('--exclude-from=') ||
              /^-e.+/.test(t) ||
              t.startsWith('-')
            )
              continue;
            operands.push(t);
          }
          targets.push(
            ...(operands.length ? operands : ['.']).map((operand) =>
              gitTarget(operand.endsWith('/') ? `${operand}**` : operand),
            ),
          );
        }
      } else if (subcommand === 'rm') {
        const writes = !tokens.includes('--cached') || tokens.includes('--worktree');
        if (writes) {
          // F16: git rm's only r-option is --recursive (--r… unambiguous).
          const recursive = tokens.some(
            (t) => longOptionPrefix(t, 'recursive', 1) || /^-[^-]*r/.test(t),
          );
          const operands = tokens.filter((t) => t !== '--' && !t.startsWith('-'));
          targets.push(...operands.map((o) => gitTarget(recursive ? `${o}/**` : o)));
          const unresolvedFileScope = fileSourcedPathspecScope(tokens);
          if (unresolvedFileScope) targets.push(unresolvedFileScope);
        }
      } else if (subcommand === 'restore') {
        // F16: --sta…--staged / --w…--worktree are unambiguous ("s"/"st"
        // collide with --source). Missing --wor let a worktree-destroying
        // restore take the unstage-only exemption (core F8 parity).
        const staged =
          tokens.some((t) => longOptionPrefix(t, 'staged', 3)) ||
          tokens.some((t) => /^-[^-]*S/.test(t));
        const worktree =
          tokens.some((t) => longOptionPrefix(t, 'worktree', 1)) ||
          tokens.some((t) => /^-[^-]*W/.test(t));
        if (!staged || worktree) {
          const operands: string[] = [];
          for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index] ?? '';
            if (token === '--source' || token === '-s') {
              index += 1;
              continue;
            }
            if (token.startsWith('--source=') || (/^-s.+/.test(token) && token !== '--staged')) {
              continue;
            }
            if (token !== '--' && !token.startsWith('-')) operands.push(token);
          }
          targets.push(...operands.flatMap(gitPathspecTargets));
          const unresolvedFileScope = fileSourcedPathspecScope(tokens);
          if (unresolvedFileScope) targets.push(unresolvedFileScope);
        }
      } else if (subcommand === 'checkout' || subcommand === 'switch') {
        const separator = tokens.indexOf('--');
        if (separator >= 0) {
          const paths = tokens.slice(separator + 1);
          targets.push(...paths.flatMap(gitPathspecTargets));
        } else {
          const createFlags =
            subcommand === 'checkout'
              ? new Set(['-b', '-B', '--branch', '--orphan'])
              : new Set(['-c', '-C', '--create', '--force-create']);
          const createIndex = tokens.findIndex((token) => createFlags.has(token));
          const branchNameIndex = createIndex >= 0 ? createIndex + 1 : -1;
          const operands = tokens.filter(
            (token, index) => !token.startsWith('-') && index !== branchNameIndex,
          );
          if (operands.length > 0) targets.push(gitTarget('.'));
        }
      } else if (subcommand === 'stash') {
        const action = tokens.find((token) => !token.startsWith('-'))?.toLowerCase();
        if (action === undefined || /^(?:push|save|pop|apply)$/.test(action)) {
          targets.push(gitTarget('.'));
        }
      } else if (
        subcommand === 'reset' &&
        // F16: reset's h/k-options are unique (--h…, --k…); --merge needs
        // "me" ("m" collides with --mixed).
        tokens.some(
          (t) =>
            longOptionPrefix(t, 'hard', 1) ||
            longOptionPrefix(t, 'merge', 2) ||
            longOptionPrefix(t, 'keep', 1),
        )
      )
        targets.push(gitTarget('.'));
    }
  }

  const findDelete = new RegExp(
    String.raw`(?:^|[;&|\r\n]\s*|\{\s*|\$\(\s*|\(\s*|\u0060\s*)${COMMAND_PATH_PREFIX}find\b([^;&|)\u0060]*(?:\s-delete(?:[\s;})]|$)|\s-exec(?:dir)?\s+(?:[^\s;&|]+[\\/])?(?:rm|rmdir)\b)[^;&|)\u0060]*)`,
    'gi',
  );
  let f: RegExpExecArray | null = findDelete.exec(normalizedCommand);
  while (f !== null) {
    const tokens = shellTokens(f[1] ?? '');
    const expressionIndex = tokens.findIndex(
      (token) => token.startsWith('-') || token === '!' || token === '(',
    );
    const roots = (expressionIndex === -1 ? tokens : tokens.slice(0, expressionIndex)).filter(
      (token) => token.length > 0,
    );
    targets.push(...(roots.length > 0 ? roots : ['.']));
    f = findDelete.exec(normalizedCommand);
  }

  /**
   * Launchers that take the command as a single quoted STRING.
   *
   * Two gaps this closes, both probe-verified (2026-09-22):
   *  - `su`, `runuser` and `script` run a command string exactly like
   *    `sh -c` does, and were not in the alternation at all.
   *  - the option had to sit immediately after the name and be exactly `-c`,
   *    so `bash -x -c "rm -rf .env"`, `su me -c "..."` and `script -qc "..."`
   *    all walked past this rule.
   *
   * The intervening-token run is bounded ({0,4} tokens of at most 64 chars,
   * each anchored by required whitespace and a class that excludes it) so it
   * cannot backtrack pathologically -- the same discipline as XARGS_OPTIONS.
   */
  const shellWrapper =
    /\b(?:(?:ba|z|k)?sh|pwsh|powershell|su|runuser|script)(?:\s+[^\s;&|"']{1,64}){0,4}?\s+(?:-[A-Za-z]{0,8}c|-Command)\s+(['"])(.*?)\1/gi;
  let w: RegExpExecArray | null = shellWrapper.exec(normalizedCommand);
  while (w !== null) {
    if (w[2] && !tokenIsQuoted(w, w[0].split(/\s/)[0] ?? '')) {
      targets.push(...destructiveTargetsAtDepth(w[2], depth + 1));
    }
    w = shellWrapper.exec(normalizedCommand);
  }

  let quote: "'" | '"' | null = null;
  for (let index = 0; index < normalizedCommand.length; index += 1) {
    const char = normalizedCommand[index];
    if (char === '\n') {
      quote = null;
      continue;
    }
    if (isQuoteBoundary(normalizedCommand, index, quote)) {
      quote = quote === char ? null : char === "'" ? "'" : '"';
      continue;
    }
    if (quote !== null || char !== '>') continue;
    const redirectsBothStreams = normalizedCommand[index + 1] === '&';
    const overridesNoclobber = normalizedCommand[index + 1] === '|';
    if (redirectsBothStreams || overridesNoclobber || normalizedCommand[index + 1] === '>') {
      index += 1;
    }
    while (normalizedCommand[index + 1] === ' ' || normalizedCommand[index + 1] === '\t') {
      index += 1;
    }
    const targetQuote = normalizedCommand[index + 1];
    let end = index + 1;
    let target: string;
    if (targetQuote === "'" || targetQuote === '"') {
      const close = normalizedCommand.indexOf(targetQuote, index + 2);
      if (close === -1) continue;
      end = close + 1;
      // A shell concatenates adjacent quoted and unquoted words: `>"a"/.env`
      // writes a/.env. Keep consuming the glued suffix so the guard inspects
      // the full destination, not the quoted prefix alone.
      while (end < normalizedCommand.length && !/[\s;&|>()]/.test(normalizedCommand[end] ?? '')) {
        end += 1;
      }
      target = normalizedCommand.slice(index + 2, end).replace(/['"]/g, '');
    } else {
      while (end < normalizedCommand.length && !/[\s;&|>()]/.test(normalizedCommand[end] ?? '')) {
        end += 1;
      }
      target = normalizedCommand.slice(index + 1, end);
    }
    if (target && !(redirectsBothStreams && (/^\d+$/.test(target) || target === '-'))) {
      targets.push(target);
    }
    index = end;
  }
  return [
    ...new Set(
      targets
        .map((target) => target.replace(/^['"]|['"]$/g, ''))
        .filter((target) => target !== '/dev/null' && target.toLowerCase() !== 'nul'),
    ),
  ];
}
export type { HeredocDelimiter } from './shell-heredocs.js';
export {
  commandSegmentBeforeHeredoc,
  heredocDelimiterOnLine,
  maskNonExecutingHeredocBodies,
} from './shell-heredocs.js';
export type { ShellToken } from './shell-launchers.js';
export {
  boundedShellTokens,
  ENV_FLAG_OPTIONS,
  ENV_VALUE_TAKING,
  firstUnquotedShellSeparator,
  gitInvocationArguments,
  gitSubcommandIndex,
  launcherPrefixLength,
  MAX_LAUNCHER_LENGTH,
  MAX_LAUNCHER_TOKENS,
  normalizeEnvSplitPayload,
  SUDO_VALUE_TAKING,
  shellTokens,
  stripLauncherAtBoundary,
  stripTransparentLaunchers,
  unwrapEnvSplitStringAtBoundary,
  VALUE_TAKING_GIT_OPTIONS,
} from './shell-launchers.js';
export {
  executableCommandSubstitutions,
  isQuoteBoundary,
  quoteIsEscaped,
} from './shell-quoting.js';

export function commandDeletesImplicitScope(command: string): boolean {
  const stripped = stripTransparentLaunchers(maskNonExecutingHeredocBodies(command));
  for (const rawArguments of gitInvocationArguments(stripped)) {
    const tokens = shellTokens(rawArguments);
    const commandIndex = gitSubcommandIndex(tokens);
    const subcommand = commandIndex >= 0 ? tokens[commandIndex]?.toLowerCase() : undefined;
    const operands = tokens.slice(commandIndex + 1);
    if (/^(?:clean|restore|reset|checkout|switch)$/.test(subcommand ?? '')) return true;
    if (subcommand === 'stash') {
      const action = operands.find((token) => !token.startsWith('-'))?.toLowerCase();
      if (action === undefined || /^(?:push|save|pop|apply)$/.test(action)) return true;
    }
  }
  return false;
}
