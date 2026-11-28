import { normalizePath } from './glob.js';
import { boundedShellTokens, shellTokens, stripTransparentLaunchers } from './shell-launchers.js';
import {
  executableCommandSubstitutions,
  isQuoteBoundary,
  quoteIsEscaped,
} from './shell-quoting.js';

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
    const redirectedFileMatch = /^(?:>>|>\||>)\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)([^\s;&|<>]*)/.exec(
      suffix,
    );
    // The shell concatenates a quoted segment with the text glued after it:
    // `> "dir"/x.sh` writes dir/x.sh, so the guard must see the whole operand.
    const redirectedFile = redirectedFileMatch
      ? `${redirectedFileMatch[1]}${redirectedFileMatch[2] ?? ''}`.replace(/['"]/g, '')
      : undefined;
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
