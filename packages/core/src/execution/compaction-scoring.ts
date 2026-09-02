import type { ToolResultBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';

const FAILURE_PATTERN =
  /(error|fail|exception|timeout|enonet|eacces|eperm|enoent|abort|hata|başarısız|basarisiz)/i;
const CORRECTION_PATTERN =
  /\b(wrong|no\b|stop\b|don'?t\b|actually|fix that|undo|revert|forget|ignore|skip)\b/i;
const ERROR_LANG_PATTERN =
  /\b(error|exception|fatal|critical|crash|panic|abort|segfault|core dump|undefined is not|null pointer|typeerror|referenceerror|syntaxerror)\b/i;
const SECURITY_PATTERN =
  /\b(security|vulnerability|injection|xss|csrf|secret|apikey|api.key|hardcoded|leak|exploit|cve)\b/i;
const ARCHITECTURE_PATTERN =
  /\b(architecture|design|approach|strategy|pattern|refactor|migrate|restructure|decision|trade.?off)\b/i;
const CORRECTION_PATTERN_TR =
  /(hayır|hayir|yanlış|yanlis|durdur|dur\b|yapma\b|geri al|düzelt|duzelt|boş ?ver|bosver|iptal|olmadı|olmadi|bozdun|yapmadın|yapmadin|değil|degil|vazgeç|vazgec)/i;
const ERROR_LANG_PATTERN_TR =
  /(hata\b|hatası|hatasi|başarısız|basarisiz|çöktü|coktu|kritik|çakıldı|cakildi|takıldı|takildi|patladı|patladi)/i;
const ARCHITECTURE_PATTERN_TR =
  /(mimari|tasarım|tasarim|yaklaşım|yaklasim|strateji|karar\b|yeniden yapıland|yeniden yapiland|refaktör|refaktor|göç et|goc et|geçiş|gecis)/i;
const BOILERPLATE_PATTERN =
  /\b(files_with_matches|count|found \d+ match|directory tree|\.\.\. and \d+ more)\b/i;

export type ContentScore = 0 | 1 | 2 | 3 | 4 | 5;

export function extractText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .filter(isTextBlock)
    .map((b) => b.text)
    .join('\n');
}

export function hasToolUse(m: Message): boolean {
  if (typeof m.content === 'string') return false;
  return m.content.some((b) => b.type === 'tool_use');
}

export function hasLargeToolResult(m: Message, threshold = 3000): boolean {
  if (typeof m.content === 'string') return false;
  return m.content.some(
    (b) =>
      b.type === 'tool_result' &&
      (b as ToolResultBlock).content &&
      (typeof (b as ToolResultBlock).content === 'string'
        ? (b as ToolResultBlock).content.length
        : JSON.stringify((b as ToolResultBlock).content).length) > threshold,
  );
}

export function scoreMessage(
  m: Message,
  context?: { failureCounts?: Map<string, number> },
): ContentScore {
  const text = extractText(m).toLowerCase();

  if (text.trim().length === 0 && (hasToolUse(m) || typeof m.content !== 'string')) {
    const hasResult =
      typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result');
    if (hasToolUse(m) || hasResult) return 0;
  }

  if (context?.failureCounts && m.role === 'user' && hasToolUse(m) === false) {
    const failureMatch = FAILURE_PATTERN.exec(text);
    if (failureMatch) {
      const errKey = failureMatch[0]?.toLowerCase() ?? 'error';
      const count = (context.failureCounts.get(errKey) ?? 0) + 1;
      context.failureCounts.set(errKey, count);
      if (count >= 5) return 0;
      if (count >= 3) return 1;
    }
  }

  if (m.role === 'user') {
    if (CORRECTION_PATTERN.test(text) || CORRECTION_PATTERN_TR.test(text)) {
      return 5;
    }
  }
  if (ERROR_LANG_PATTERN.test(text) || ERROR_LANG_PATTERN_TR.test(text)) return 5;
  if (SECURITY_PATTERN.test(text)) return 5;
  if (
    m.role === 'assistant' &&
    (ARCHITECTURE_PATTERN.test(text) || ARCHITECTURE_PATTERN_TR.test(text))
  ) {
    return 5;
  }
  if (hasLargeToolResult(m)) return 1;
  if (m.role === 'user' && !hasToolUse(m) && BOILERPLATE_PATTERN.test(text)) return 1;
  return 3;
}

export function buildSmartDigest(messages: readonly Message[]): string {
  const lines: string[] = [];
  const failureCounts = new Map<string, number>();
  let noiseCount = 0;

  for (const m of messages) {
    const isPureToolIO =
      Array.isArray(m.content) &&
      m.content.length > 0 &&
      !hasToolUse(m) &&
      m.content.every((b) => b.type === 'tool_result');
    if (isPureToolIO) {
      noiseCount++;
      continue;
    }

    const score = scoreMessage(m, { failureCounts });
    const text = extractText(m);
    const toolCount = countToolBlocks(m);

    if (score === 0) {
      noiseCount++;
      continue;
    }

    const marker = toolCount > 0 ? ` [${toolCount} tool call(s)]` : '';
    let display: string;
    switch (score) {
      case 5:
        display = text.trim();
        break;
      case 3:
        display = firstSentence(text);
        break;
      case 1:
        display = oneLineSummary(m, text);
        break;
      default:
        display = firstSentence(text);
    }

    if (display.length === 0 && toolCount === 0) continue;
    lines.push(`[${m.role}]: ${display}${marker}`);
  }

  if (noiseCount > 0) {
    lines.push(
      `[system]: ${noiseCount} low-importance turn(s) collapsed (repeated failures / pure tool I/O)`,
    );
  }

  return lines.join('\n');
}

function countToolBlocks(m: Message): number {
  if (typeof m.content === 'string') return 0;
  return m.content.filter((b) => b.type === 'tool_use' || b.type === 'tool_result').length;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const dot = trimmed.indexOf('. ');
  if (dot === -1) return trimmed.length > 150 ? `${trimmed.slice(0, 147)}…` : trimmed;
  const sentence = trimmed.slice(0, dot + 1);
  return sentence.length > 150 ? `${sentence.slice(0, 147)}…` : sentence;
}

function oneLineSummary(m: Message, text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    if (typeof m.content !== 'string') {
      const results = m.content.filter((b) => b.type === 'tool_result');
      if (results.length > 0) {
        return `[${results.length} tool result(s) — see session log]`;
      }
    }
    return '[no text content]';
  }
  const firstLine = trimmed.split('\n')[0] ?? '';
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}…` : firstLine;
}
