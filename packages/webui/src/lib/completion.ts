export const LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  css: 'css',
  html: 'html',
  svg: 'xml',
  md: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  py: 'python',
  rs: 'rust',
  go: 'go',
  rb: 'ruby',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
  sql: 'sql',
  xml: 'xml',
};

export const COMPLETION_LANGUAGES = Array.from(new Set(Object.values(LANG_MAP))).filter(
  (lang) => lang !== 'plaintext',
);
export const COMPLETION_PREFIX_CHARS = 12_000;
export const COMPLETION_SUFFIX_CHARS = 4_000;
export const COMPLETION_TIMEOUT_MS = 5_000;
export const COMPLETION_CACHE_TTL_MS = 10_000;
export const COMPLETION_DOCUMENT_CHARS = 500_000;

interface CompletionTriggerInfo {
  triggerCharacter?: string;
  triggerKind?: number;
}

interface CompletionCacheKeyInput {
  filePath: string;
  language: string;
  lineNumber: number;
  column: number;
  versionId?: number | string | undefined;
  triggerCharacter?: string;
  linePrefix: string;
  suffix: string;
}

export function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return LANG_MAP[ext] ?? 'plaintext';
}

export function currentToken(linePrefix: string): string {
  return linePrefix.match(/([A-Za-z_$][\w$]*)$/)?.[1] ?? '';
}

export function shouldAskCompletionServer(
  trigger: CompletionTriggerInfo,
  tokenText: string,
): boolean {
  if (trigger.triggerCharacter) return true;
  return tokenText.length >= 3;
}

export function shouldAllowCompletionLlm(
  trigger: CompletionTriggerInfo,
  tokenText: string,
): boolean {
  if (trigger.triggerCharacter === '.') return true;
  if (trigger.triggerCharacter) return false;
  return /^(findBy|findAllBy|create|update|delete|remove|get[A-Z_]|set[A-Z_]|use[A-Z_])/.test(
    tokenText,
  );
}

export function buildCompletionCacheKey(input: CompletionCacheKeyInput): string {
  return [
    input.filePath,
    input.language,
    input.lineNumber,
    input.column,
    input.versionId ?? '',
    input.triggerCharacter ?? '',
    input.linePrefix.slice(-160),
    input.suffix.slice(0, 160),
  ].join('\0');
}
