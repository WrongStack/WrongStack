type TerminalTone = 'blue' | 'cyan' | 'green' | 'magenta' | 'muted' | 'success' | 'yellow';

interface TerminalStyleOptions {
  readonly bold?: boolean;
  /** Capability override for deterministic tests; production derives this from env/TTY. */
  readonly enabled?: boolean;
}

const ANSI: Record<TerminalTone, string> = {
  blue: '\u001B[34m',
  cyan: '\u001B[36m',
  green: '\u001B[32m',
  magenta: '\u001B[35m',
  muted: '\u001B[90m',
  success: '\u001B[32m',
  yellow: '\u001B[33m',
};
const BOLD = '\u001B[1m';
const RESET = '\u001B[0m';

/** Match the CLI banner's NO_COLOR/FORCE_COLOR/TTY precedence. */
export function terminalFormattingEnabled(
  env: NodeJS.ProcessEnv = process.env,
  isTty = Boolean(process.stdout.isTTY),
): boolean {
  if (env['NO_COLOR'] !== undefined) return false;
  if (env['FORCE_COLOR'] !== undefined) return true;
  return isTty;
}

/** Add semantic color while preserving plain text when formatting is disabled. */
export function terminalText(
  text: string,
  tone: TerminalTone,
  options: TerminalStyleOptions = {},
): string {
  const enabled = options.enabled ?? terminalFormattingEnabled();
  if (!enabled) return text;
  return `${options.bold ? BOLD : ''}${ANSI[tone]}${text}${RESET}`;
}

/** Render a colored OSC 8 hyperlink, falling back to the visible URL unchanged. */
export function terminalLink(
  url: string,
  options: TerminalStyleOptions & { readonly tone?: TerminalTone } = {},
): string {
  const enabled = options.enabled ?? terminalFormattingEnabled();
  if (!enabled) return url;
  const visible = terminalText(url, options.tone ?? 'cyan', {
    ...(options.bold === undefined ? {} : { bold: options.bold }),
    enabled: true,
  });
  return `\u001B]8;;${url}\u001B\\${visible}\u001B]8;;\u001B\\`;
}
