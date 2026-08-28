import {
  isUnresolvedPathScope,
  isDirectoryAmbiguousPath,
  normalizePath,
  resolveTargetPath,
} from './glob.js';

export const VALUE_TAKING_GIT_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
  '--config-env',
  '--attr-source',
]);

export interface ShellToken {
  value: string;
  start: number;
  end: number;
}

export const MAX_LAUNCHER_TOKENS = 256;
export const MAX_LAUNCHER_LENGTH = 64 * 1024;

export function boundedShellTokens(raw: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let token = '';
  let tokenStart = -1;
  let quote: "'" | '"' | null = null;
  const limit = Math.min(raw.length, MAX_LAUNCHER_LENGTH);
  for (let index = 0; index < limit && tokens.length < MAX_LAUNCHER_TOKENS; index += 1) {
    const char = raw[index] ?? '';
    if (tokenStart < 0 && !/\s/.test(char)) tokenStart = index;
    if (char === '\\' && quote !== "'" && index + 1 < limit) {
      const escaped = raw[index + 1] ?? '';
      const shellEscaped =
        quote === '"' ? /[$\x60"\\\r\n]/.test(escaped) : /[\s'"\\;&|()`]/.test(escaped);
      token += shellEscaped ? escaped : `\\${escaped}`;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      if (quote === char) quote = null;
      else if (quote === null) quote = char;
      else token += char;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (tokenStart >= 0) tokens.push({ value: token, start: tokenStart, end: index });
      token = '';
      tokenStart = -1;
      continue;
    }
    token += char;
  }
  if (tokenStart >= 0 && tokens.length < MAX_LAUNCHER_TOKENS) {
    tokens.push({ value: token, start: tokenStart, end: limit });
  }
  return tokens;
}

export function shellTokens(raw: string): string[] {
  return boundedShellTokens(raw).map((token) => token.value);
}

export function gitInvocationArguments(command: string): string[] {
  const argumentsList: string[] = [];
  const quotedIndexes = new Uint8Array(command.length);
  let activeQuote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (isQuoteBoundary(command, index, activeQuote)) {
      quotedIndexes[index] = 1;
      activeQuote = activeQuote === char ? null : char === "'" ? "'" : '"';
    } else if (activeQuote !== null) {
      quotedIndexes[index] = 1;
    }
  }

  const gitStart = /(?:^|[;&|\r\n]\s*|\(\s*|`\s*)git\b/gi;
  let match: RegExpExecArray | null = gitStart.exec(command);
  while (match !== null) {
    const gitOffset = match[0].toLowerCase().lastIndexOf('git');
    if (gitOffset < 0 || quotedIndexes[match.index + gitOffset] === 1) {
      match = gitStart.exec(command);
      continue;
    }
    const start = gitStart.lastIndex;
    let quote: "'" | '"' | null = null;
    let end = start;
    for (; end < command.length; end += 1) {
      const char = command[end] ?? '';
      if (char === '\\' && quote !== "'") {
        end += 1;
        continue;
      }
      if (char === "'" || char === '"') {
        if (quote === char) quote = null;
        else if (quote === null) quote = char;
        continue;
      }
      if (quote === null && /[;&|)`\r\n]/.test(char)) break;
    }
    argumentsList.push(command.slice(start, end));
    gitStart.lastIndex = Math.max(end, start);
    match = gitStart.exec(command);
  }
  return argumentsList;
}

export function gitSubcommandIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--') return index + 1 < tokens.length ? index + 1 : -1;
    if (!token.startsWith('-')) return index;
    const optionName =
      token.startsWith('-C') && token !== '-C' ? '-C' : (token.split('=', 1)[0] ?? token);
    const hasAttachedValue = token.includes('=') || (token.startsWith('-C') && token !== '-C');
    if (VALUE_TAKING_GIT_OPTIONS.has(optionName) && !hasAttachedValue) index += 1;
  }
  return -1;
}

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

export function normalizeEnvSplitPayload(payload: string): string {
  const removeUnbalanced = (value: string, quote: "'" | '"'): string => {
    let boundaries = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === quote && !quoteIsEscaped(value, index)) boundaries += 1;
    }
    return boundaries % 2 === 0 ? value : value.replaceAll(quote, '');
  };
  return removeUnbalanced(removeUnbalanced(payload, "'"), '"');
}

export function unwrapEnvSplitStringAtBoundary(command: string): string {
  const pattern = /(^|[;&|\r\n]\s*|\(\s*|`\s*)(?:[^\s;&|(){}]+[\\/])?env\b/gi;
  const match = pattern.exec(command);
  if (!match) return command;

  const boundary = match[1] ?? '';
  const afterStart = match.index + match[0].length;
  const after = command.slice(afterStart);
  const tokens = boundedShellTokens(after);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const separator = firstUnquotedShellSeparator(after, token.start, token.end);
    const tokenEnd = separator ?? token.end;
    const tokenValue = boundedShellTokens(after.slice(token.start, tokenEnd))[0]?.value ?? '';

    const attachedShort = /^-[i0v]*S(.+)$/.exec(tokenValue)?.[1];
    const attachedLong = tokenValue.startsWith('--split-string=')
      ? tokenValue.slice('--split-string='.length)
      : undefined;
    const attachedPayload = attachedShort ?? attachedLong;
    if (attachedPayload !== undefined) {
      return `${command.slice(0, match.index)}${boundary}${normalizeEnvSplitPayload(attachedPayload)}${after.slice(tokenEnd)}`;
    }

    if (!/^-[i0v]*S$/.test(tokenValue) && tokenValue !== '--split-string') {
      if (separator !== undefined) return command;
      continue;
    }
    const payload = tokens[index + 1];
    if (!payload) return command;
    const payloadSeparator = firstUnquotedShellSeparator(after, payload.start, payload.end);
    const payloadEnd = payloadSeparator ?? payload.end;
    const payloadValue = boundedShellTokens(after.slice(payload.start, payloadEnd))[0]?.value ?? '';
    return `${command.slice(0, match.index)}${boundary}${normalizeEnvSplitPayload(payloadValue)}${after.slice(payloadEnd)}`;
  }
  return command;
}

export const SUDO_VALUE_TAKING = new Set([
  '-u',
  '-g',
  '-h',
  '-p',
  '-C',
  '-R',
  '-D',
  '-r',
  '-t',
  '--user',
  '--group',
  '--host',
  '--prompt',
  '--close-from',
  '--chroot',
  '--chdir',
  '--role',
  '--type',
  '--command-timeout',
]);

export const ENV_VALUE_TAKING = new Set([
  '-u',
  '-C',
  '-P',
  '-a',
  '--argv0',
  '--unset',
  '--chdir',
  '--split-string',
]);

export const ENV_FLAG_OPTIONS = new Set([
  '-i',
  '-0',
  '-v',
  '--ignore-environment',
  '--null',
  '--debug',
  '--help',
  '--version',
]);

export function stripTransparentLaunchers(command: string): string {
  let stripped = command;
  let previous: string;
  do {
    previous = stripped;
    let beforeUnwrap: string;
    do {
      beforeUnwrap = stripped;
      stripped = unwrapEnvSplitStringAtBoundary(stripped);
    } while (stripped !== beforeUnwrap);
    stripped = stripLauncherAtBoundary(stripped, 'env', ENV_VALUE_TAKING);
    stripped = stripLauncherAtBoundary(stripped, 'sudo', SUDO_VALUE_TAKING);
  } while (stripped !== previous);
  return stripped;
}

export function firstUnquotedShellSeparator(
  raw: string,
  start: number,
  end: number,
): number | undefined {
  let quote: "'" | '"' | null = null;
  for (let index = start; index < end; index += 1) {
    const char = raw[index];
    if (isQuoteBoundary(raw, index, quote)) {
      quote = quote === char ? null : char === "'" ? "'" : '"';
      continue;
    }
    if (quote === null && !quoteIsEscaped(raw, index) && /[;&|]/.test(char ?? '')) return index;
  }
  return undefined;
}

export function launcherPrefixLength(
  after: string,
  valueTaking: Set<string>,
  flagOptions?: Set<string>,
): number | undefined {
  const tokens = boundedShellTokens(after);
  let consumed = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i] ?? { value: '', start: 0, end: 0 };
    const token = tok.value;
    const separator = firstUnquotedShellSeparator(after, tok.start, tok.end);
    if (separator !== undefined) return consumed || separator;
    if (token === '--') return tok.end;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      consumed = tok.end;
      continue;
    }
    if (token === '-' || !token.startsWith('-')) break;
    const optionName = token.split('=', 1)[0] ?? token;
    const combinedValueOption = [...valueTaking].find(
      (option) => option.length === 2 && token.startsWith(option) && token !== option,
    );
    const combinedShortValueOption =
      token.startsWith('-') && !token.startsWith('--')
        ? [...valueTaking].find(
            (option) => option.length === 2 && token.includes(option[1] ?? '', 2),
          )
        : undefined;
    const hasAttachedValue = token.includes('=') || combinedValueOption !== undefined;
    if (
      !hasAttachedValue &&
      (valueTaking.has(optionName) || combinedShortValueOption !== undefined)
    ) {
      if (i + 1 >= tokens.length) return flagOptions ? undefined : tok.end;
      const valueToken = tokens[i + 1] ?? tok;
      const valueSeparator = firstUnquotedShellSeparator(after, valueToken.start, valueToken.end);
      if (valueSeparator !== undefined) return consumed || valueSeparator;
      consumed = valueToken.end;
      i += 1;
    } else {
      const knownFlag =
        flagOptions?.has(optionName) || (flagOptions !== undefined && /^-[i0v]+$/.test(token));
      const knownAttachedValue =
        hasAttachedValue && (valueTaking.has(optionName) || combinedValueOption !== undefined);
      if (flagOptions && !knownFlag && !knownAttachedValue) return undefined;
      consumed = tok.end;
    }
  }
  return consumed;
}

export function stripLauncherAtBoundary(
  command: string,
  launcher: 'env' | 'sudo',
  valueTaking: Set<string>,
): string {
  const pattern = new RegExp(
    `(^|[;&|\\r\\n]\\s*|\\(\\s*|\u0060\\s*)(?:[^\\s;&|(){}]+[\\\\/])?${launcher}\\b`,
    'i',
  );
  const match = pattern.exec(command);
  if (!match) return command;
  const boundary = match[1] ?? '';
  const afterStart = match.index + match[0].length;
  const after = command.slice(afterStart);
  const consumed = launcherPrefixLength(
    after,
    valueTaking,
    launcher === 'env' ? ENV_FLAG_OPTIONS : undefined,
  );
  if (consumed === undefined) {
    return `${command.slice(0, match.index)}${boundary}rm -rf **`;
  }
  return `${command.slice(0, match.index)}${boundary}${after.slice(consumed).replace(/^\s+/, '')}`;
}

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
 */
const XARGS_OPTIONS = String.raw`(?:\s+(?:(?:-[InLsPjeE]|--(?:arg-file|replace|max-args|max-lines|max-chars|max-procs))\s+[^\s-][^\s]*|-[^\s]+))*`;

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

export function commandRecursivelyDeletes(command: string): boolean {
  const stripped = stripTransparentLaunchers(maskNonExecutingHeredocBodies(command));
  if (
    /(?:^|[;&|\r\n]\s*|\{\s*|\$\(\s*|\(\s*|`\s*)find\b[^;&|)`]*(?:-delete\b|-exec(?:dir)?\s+(?:[^\s;&|]+[\\/])?(?:rm|rmdir)\b)/i.test(
      stripped,
    )
  ) {
    return true;
  }
  const destructive = new RegExp(
    String.raw`${COMMAND_BOUNDARY}(rm|rmdir|del|rd|Remove-Item)\s+((?:"[^"]*"|'[^']*'|\\.|\{[^}]*\}|\([^()]*\)|[^;&|\r\n}])+)`,
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
        if (token === '--recursive' || /^-[^-]*[rR]/.test(token)) recursive = true;
      } else if (tool === 'remove-item') {
        if (/^-Recurse$/i.test(token) || /^-r$/i.test(token)) recursive = true;
      } else if (/^\/[a-z]*s[a-z]*$/i.test(token)) {
        recursive = true;
      }
    }
    if (recursive) return true;
    match = destructive.exec(stripped);
  }
  return false;
}

export function quoteIsEscaped(command: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && command[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

export function isQuoteBoundary(
  command: string,
  index: number,
  activeQuote: "'" | '"' | null,
): boolean {
  const char = command[index];
  if (char !== "'" && char !== '"') return false;
  if (activeQuote === "'") return char === "'";
  if (activeQuote !== null && char !== activeQuote) return false;
  return !quoteIsEscaped(command, index);
}

export function executableCommandSubstitutions(command: string): string[] {
  const bodies: string[] = [];
  let outerQuote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (isQuoteBoundary(command, index, outerQuote)) {
      outerQuote = outerQuote === char ? null : char === "'" ? "'" : '"';
      continue;
    }
    if (outerQuote === "'" || quoteIsEscaped(command, index)) continue;

    if (char === '\x60') {
      let end = index + 1;
      while (end < command.length && (command[end] !== '\x60' || quoteIsEscaped(command, end))) {
        end += 1;
      }
      if (end < command.length) {
        bodies.push(command.slice(index + 1, end));
        index = end;
      }
      continue;
    }

    const commandSubstitution = char === '\x24' && command[index + 1] === '(';
    const processSubstitution = (char === '>' || char === '<') && command[index + 1] === '(';
    if (
      (!commandSubstitution && !processSubstitution) ||
      (commandSubstitution && command[index + 2] === '(')
    )
      continue;
    let depth = 1;
    let innerQuote: "'" | '"' | null = null;
    let end = index + 2;
    for (; end < command.length; end += 1) {
      const innerChar = command[end];
      if (isQuoteBoundary(command, end, innerQuote)) {
        innerQuote = innerQuote === innerChar ? null : innerChar === "'" ? "'" : '"';
        continue;
      }
      if (innerQuote !== null) continue;
      if ((innerChar === '(' || innerChar === ')') && quoteIsEscaped(command, end)) continue;
      if (innerChar === '(') depth += 1;
      else if (innerChar === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) {
      bodies.push(command.slice(index + 2, end));
      index = end;
    } else {
      break;
    }
  }
  return bodies;
}

export const MAX_DESTRUCTIVE_TARGET_DEPTH = 64;

export interface HeredocDelimiter {
  delimiter: string;
  start: number;
  end: number;
  quoted: boolean;
  stripTabs: boolean;
}

export function heredocDelimiterOnLine(line: string): HeredocDelimiter | null {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length - 1; index += 1) {
    const char = line[index];
    if (isQuoteBoundary(line, index, quote)) {
      quote = quote === char ? null : char === "'" ? "'" : '"';
      continue;
    }
    if (
      quote !== null ||
      quoteIsEscaped(line, index) ||
      char !== '<' ||
      line[index - 1] === '<' ||
      line[index + 1] !== '<' ||
      line[index + 2] === '<'
    )
      continue;

    let cursor = index + 2;
    const stripTabs = line[cursor] === '-';
    if (stripTabs) cursor += 1;
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;

    let delimiter = '';
    let delimiterQuote: "'" | '"' | null = null;
    let quoted = false;
    for (; cursor < line.length; cursor += 1) {
      const delimiterChar = line[cursor] ?? '';
      if (delimiterQuote !== null) {
        if (delimiterChar === delimiterQuote && !quoteIsEscaped(line, cursor)) {
          delimiterQuote = null;
          quoted = true;
        } else if (delimiterChar === '\\' && delimiterQuote === '"' && cursor + 1 < line.length) {
          quoted = true;
          cursor += 1;
          delimiter += line[cursor] ?? '';
        } else {
          delimiter += delimiterChar;
        }
        continue;
      }
      if (delimiterChar === "'" || delimiterChar === '"') {
        delimiterQuote = delimiterChar;
        quoted = true;
        continue;
      }
      if (delimiterChar === '\\' && cursor + 1 < line.length) {
        quoted = true;
        cursor += 1;
        delimiter += line[cursor] ?? '';
        continue;
      }
      if (/\s|[;&|<>]/.test(delimiterChar)) break;
      delimiter += delimiterChar;
    }
    return delimiter.length > 0
      ? { delimiter, start: index, end: cursor, quoted, stripTabs }
      : null;
  }
  return null;
}

export function commandSegmentBeforeHeredoc(prefix: string): string {
  let segmentStart = 0;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < prefix.length; index += 1) {
    const char = prefix[index];
    if (isQuoteBoundary(prefix, index, quote)) {
      quote = quote === char ? null : char === "'" ? "'" : '"';
      continue;
    }
    if (quote === null && !quoteIsEscaped(prefix, index) && /[;&|\r\n]/.test(char ?? '')) {
      segmentStart = index + 1;
    }
  }
  return prefix.slice(segmentStart).trim();
}

export function maskNonExecutingHeredocBodies(command: string): string {
  const lines = command.split(/(?<=\n)/);
  let heredoc: (HeredocDelimiter & { bodyStart: number }) | null = null;
  const maskBody = (start: number, end: number, quoted: boolean): void => {
    const body = lines.slice(start, end).join('');
    const substitutions = quoted ? [] : executableCommandSubstitutions(body);
    for (let index = start; index < end; index += 1) {
      const line = lines[index] ?? '';
      lines[index] = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '';
    }
    if (substitutions.length > 0 && start < end)
      lines[start] = `${substitutions.join(';')}${lines[start] ?? ''}`;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (heredoc !== null) {
      const content = line.replace(/\r?\n$/, '');
      const terminator = heredoc.stripTabs ? content.replace(/^\t+/, '') : content;
      if (terminator === heredoc.delimiter) {
        maskBody(heredoc.bodyStart, index, heredoc.quoted);
        heredoc = null;
      }
      continue;
    }
    const marker = heredocDelimiterOnLine(line);
    if (!marker) continue;
    const prefix = line.slice(0, marker.start).trim();
    const suffix = line.slice(marker.end).trim();
    const owner = stripTransparentLaunchers(commandSegmentBeforeHeredoc(prefix));
    const commandBeforeMarker = `${lines.slice(0, index).join('')}${prefix}`;
    const whileReadLoopOwnsHeredoc =
      /^done$/i.test(owner) &&
      /(?:^|[;&|\r\n])\s*while\s+read(?:\s|$)[\s\S]*\bdone\s*$/i.test(commandBeforeMarker);
    const receivesDataWithoutExecuting =
      /^(?:[^\s;&|]+[\\/])?(?:cat|tee)(?:\s|$)/i.test(owner) ||
      /^(?:while\s+)?read(?:\s|$)/i.test(owner) ||
      whileReadLoopOwnsHeredoc;
    const redirectedFileMatch = /^(?:>>|>\||>)\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/.exec(suffix);
    const redirectedFile = redirectedFileMatch?.[1]?.replace(/^['"]|['"]$/g, '');
    const remainingCommand = lines.slice(index + 1).join('');
    const executionSearch = `${suffix}\n${remainingCommand}`;
    const normalizedRedirectedFile = redirectedFile ? normalizePath(redirectedFile) : undefined;
    const executesRedirectedFile =
      normalizedRedirectedFile !== undefined &&
      boundedShellTokens(executionSearch).some((token) => {
        if (normalizePath(token.value) !== normalizedRedirectedFile) return false;
        const segmentStart = Math.max(
          executionSearch.lastIndexOf(';', token.start - 1),
          executionSearch.lastIndexOf('&', token.start - 1),
          executionSearch.lastIndexOf('|', token.start - 1),
          executionSearch.lastIndexOf('\n', token.start - 1),
          executionSearch.lastIndexOf('\r', token.start - 1),
        );
        const segmentTokens = shellTokens(executionSearch.slice(segmentStart + 1, token.start));
        const previous = segmentTokens.at(-1)?.toLowerCase();
        return previous === undefined || /^(?:(?:ba|z|k)?sh|source|\.)$/.test(previous);
      });
    const processSubstitution = /^(?:>>|>\||>)\s*>\s*\(\s*([^)]*)/.exec(suffix);
    const processCommand = boundedShellTokens(
      stripTransparentLaunchers(processSubstitution?.[1]?.trim() ?? ''),
    )[0]
      ?.value.replace(/^.*[\\/]/, '')
      .toLowerCase();
    const executesBody =
      /^(?:\||;|&|\(|\{)/.test(suffix) ||
      /^(?:(?:ba|z|k)?sh|source|\.)$/.test(processCommand ?? '') ||
      executesRedirectedFile;
    if (!receivesDataWithoutExecuting || executesBody) continue;
    heredoc = { ...marker, bodyStart: index + 1 };
  }
  if (heredoc !== null) maskBody(heredoc.bodyStart, lines.length, heredoc.quoted);
  return lines.join('');
}

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
    const offset = match[0].toLowerCase().indexOf(token.toLowerCase());
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
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?(rm|rmdir|del|rd|Remove-Item|unlink|truncate|shred|mv)\s+((?:"[^"]*"|'[^']*'|\\.|\{[^}]*\}|\([^()]*\)|[^;&|\r\n}])+)`,
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

  const copy = new RegExp(
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?(cp|install)\s+([^;&|\r\n]+)`,
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

  const tee = new RegExp(String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?(tee)\s+([^;&|\r\n]+)`, 'gi');
  let t: RegExpExecArray | null = tee.exec(normalizedCommand);
  while (t !== null) {
    if (!tokenIsQuoted(t, t[1] ?? '')) targets.push(...shellArgs(t[2] ?? ''));
    t = tee.exec(normalizedCommand);
  }

  const dd = new RegExp(String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?(dd)\s+([^;&|\r\n]+)`, 'gi');
  let d: RegExpExecArray | null = dd.exec(normalizedCommand);
  while (d !== null) {
    if (!tokenIsQuoted(d, d[1] ?? '')) {
      const outputMatch = /(?:^|\s)of=("[^"]*"|'[^']*'|[^\s]+)/i.exec(d[2] ?? '');
      // stripSubshellClosers runs before quote-stripping so a quoted operand
      // ending in `)` (`of="notes(2)"`) is not mistaken for subshell punctuation.
      const output = outputMatch?.[1]
        ? stripSubshellClosers(outputMatch[1]).replace(/^['"]|['"]$/g, '')
        : undefined;
      if (output) targets.push(output);
    }
    d = dd.exec(normalizedCommand);
  }

  const overwrite = new RegExp(
    String.raw`${COMMAND_BOUNDARY}(?:sudo\s+)?(sed|ln)\s+([^;&|\r\n]+)`,
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
    if (tool === 'sed' && /(?:^|\s)-i(?:[^\s]*)?(?:\s|$)/.test(rawArgs)) {
      const args = shellArgs(rawArgs);
      targets.push(...args.slice(1));
    } else if (tool === 'ln' && /(?:^|\s)-[^\s]*f[^\s]*(?:\s|$)/.test(rawArgs)) {
      const destination = shellArgs(rawArgs).at(-1);
      if (destination) targets.push(destination);
    }
    o = overwrite.exec(normalizedCommand);
  }

  const xargsPipeline = new RegExp(
    String.raw`\b(?:echo|printf)\s+([^|]+)\|\s*xargs${XARGS_OPTIONS}\s+(?:sudo\s+)?(?:rm|rmdir|del|unlink|truncate|shred)\b`,
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
          const recursive = tokens.some((t) => t === '--recursive' || /^-[^-]*r/.test(t));
          const operands = tokens.filter((t) => t !== '--' && !t.startsWith('-'));
          targets.push(...operands.map((o) => gitTarget(recursive ? `${o}/**` : o)));
          const unresolvedFileScope = fileSourcedPathspecScope(tokens);
          if (unresolvedFileScope) targets.push(unresolvedFileScope);
        }
      } else if (subcommand === 'restore') {
        const staged = tokens.includes('--staged') || tokens.some((t) => /^-[^-]*S/.test(t));
        const worktree = tokens.includes('--worktree') || tokens.some((t) => /^-[^-]*W/.test(t));
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
        tokens.some((t) => t === '--hard' || t === '--merge' || t === '--keep')
      )
        targets.push(gitTarget('.'));
    }
  }

  const findDelete =
    /(?:^|[;&|\r\n]\s*|\{\s*|\$\(\s*|\(\s*|`\s*)find\b([^;&|)`]*(?:\s-delete(?:[\s;})]|$)|\s-exec(?:dir)?\s+(?:[^\s;&|]+[\\/])?(?:rm|rmdir)\b)[^;&|)`]*)/gi;
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

  const shellWrapper = /\b(?:(?:ba|z|k)?sh|pwsh|powershell)\s+(?:-c|-Command)\s+(['"])(.*?)\1/gi;
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
      end = normalizedCommand.indexOf(targetQuote, index + 2);
      if (end === -1) continue;
      target = normalizedCommand.slice(index + 2, end);
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
