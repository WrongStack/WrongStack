/** A tool name or a glob such as `mcp__github__*`. */
const TOOL_NAME = /^[A-Za-z0-9_*][A-Za-z0-9_*.:@-]*$/;

/** One session permission rule as `/permissions` lists it. */
export interface SessionRuleRow {
  n: number;
  effect: 'allow' | 'deny';
  tool: string;
  /** Absent when the rule covers any input. */
  pattern?: string | undefined;
}

/** The rules in `/permissions`' listing (`  1. allow read src/*`); none for the empty listing. */
export function parseSessionRules(text: string): SessionRuleRow[] {
  const rows: SessionRuleRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\.\s+(allow|deny)\s+(\S+)(?:\s+(.*\S))?\s*$/.exec(line);
    if (!match) continue;
    const pattern = match[4];
    rows.push({
      n: Number(match[1]),
      effect: match[2] as 'allow' | 'deny',
      tool: match[3] ?? '',
      ...(pattern && pattern !== '(any input)' ? { pattern } : {}),
    });
  }
  return rows;
}

/**
 * The `/permissions` arguments that add a rule, or undefined for a tool that is not a name or
 * glob. The pattern is the rest of the line, so it may hold spaces but not a line break.
 */
export function permissionRuleArgs(
  effect: 'allow' | 'deny',
  tool: string,
  pattern: string,
): string | undefined {
  const name = tool.trim();
  if (!TOOL_NAME.test(name)) return undefined;
  const subject = pattern.trim();
  if (/[\r\n]/.test(subject)) return undefined;
  return subject ? `${effect} ${name} ${subject}` : `${effect} ${name}`;
}
