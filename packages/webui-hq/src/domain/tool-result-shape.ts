/**
 * Tool-output shape detection, mirroring the main WebUI's `ToolResult` so both
 * surfaces classify the same output identically:
 *   - Read output with leading `N→` line numbers  -> numbered, no-wrap block
 *   - bash/shell output                           -> stdout + exit-code footer
 *   - valid JSON                                  -> pretty-printed, collapsible
 *   - anything else                                -> wrapped monospace
 */
export interface ToolResultShape {
  kind: 'numbered' | 'json' | 'bash' | 'plain';
  value?: unknown;
  stdout?: string | undefined;
  exitCode?: number | undefined;
  duration?: string | undefined;
}

export function detectShape(toolName: string | undefined, result: string): ToolResultShape {
  const trimmed = result.trim();
  if (/^\s*\d+→/m.test(result.slice(0, 200))) return { kind: 'numbered' };

  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null) return { kind: 'json', value: parsed };
    } catch {
      // Not JSON after all — fall through to the other shapes.
    }
  }

  const isBashTool = toolName !== undefined && /^(bash|shell|exec|run|powershell)/i.test(toolName);
  const exitMatch = result.match(/(?:^|\n)\s*(?:\[?exit(?:\s*code)?\]?\s*[:=]?\s*)(\d+)\s*$/i);
  const durationMatch = result.match(/(?:^|\s)(\d+\s*ms|\d+\.\d+s)\s*$/i);

  if (isBashTool || exitMatch) {
    const stdout = exitMatch ? result.slice(0, exitMatch.index).trimEnd() : result;
    return {
      kind: 'bash',
      stdout,
      exitCode: exitMatch ? Number(exitMatch[1]) : undefined,
      duration: durationMatch?.[1],
    };
  }

  return { kind: 'plain' };
}
