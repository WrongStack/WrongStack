import { sanitizeTerminalText, unifiedDiff, writeOut } from '@wrongstack/core/utils';
import React from 'react';
import { langFromPath } from '../highlight.js';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, type DOMElement, measureElement, Text, useInput, useStdin } from '../ink.js';
import { parseMouseEvents, splitTrailingMousePartial } from '../mouse.js';
import { theme } from '../theme.js';
import { DiffBlock, parseUnifiedDiff } from './history/code-block.js';
import { MonitorShell, MonitorViewportProvider, PanelInputProvider } from './monitor-shell.js';

export type ConfirmDecision =
  | 'yes'
  | 'no'
  | 'always'
  | 'always-exact'
  | 'always-command'
  | 'always-tool'
  | 'deny';

interface ConfirmPromptProps {
  toolName: string;
  input: unknown;
  suggestedPattern: string;
  onDecision: (decision: ConfirmDecision) => void;
  /** Enable YOLO mode (capital Y). Destructive current calls remain pending. */
  onEnableYolo: () => void;
  maxRows?: number | undefined;
  /** Whether this call was classified destructive. */
  destructive?: boolean;
  boundaryReason?: string | undefined;
  /**
   * Real write destinations from `Tool.writeTargets` (VULN-001 Phase 2) —
   * what the call would actually touch, as opposed to the permission
   * subject (`patch`'s is just `directory: "."`).
   */
  writeTargets?: string[] | undefined;
}

/** Ink color for each button's bracketed key. */
const BUTTON_COLOR: Record<ConfirmDecision, string> = {
  yes: 'green',
  no: 'red',
  always: 'cyan',
  'always-exact': 'cyan',
  'always-command': 'cyan',
  'always-tool': 'yellow',
  deny: 'red',
};

/**
 * The button row as a list of {bracket, rest} segments. Single source of
 * truth for rendered labels and the legacy flattened `confirmButtonSegments`
 * view. Actual pointer routing measures each button so wrapped rows remain
 * accurate. `rest` carries the trailing space between buttons.
 */
function buttonLabels(
  _suggestedPattern: string,
  toolName = 'exec',
): Array<{
  decision: ConfirmDecision;
  bracket: string;
  rest: string;
}> {
  return [
    { decision: 'yes', bracket: '[y]', rest: 'es ' },
    { decision: 'no', bracket: '[n]', rest: 'o ' },
    { decision: 'always-exact', bracket: '[a]', rest: ' same args ' },
    ...(toolName === 'exec'
      ? [{ decision: 'always-command' as const, bracket: '[c]', rest: ' command ' }]
      : []),
    { decision: 'always-tool', bracket: '[t]', rest: ' tool ' },
    { decision: 'deny', bracket: '[d]', rest: 'eny' },
  ];
}

/**
 * 0-based column spans of each button WITHIN the dialog's content area (i.e.
 * relative to the first printable column inside the border + paddingX).
 * These describe an unwrapped row; the live handler uses measured DOM boxes.
 */
export function confirmButtonSegments(
  suggestedPattern: string,
  toolName = 'exec',
): Array<{ decision: ConfirmDecision; start: number; len: number }> {
  const out: Array<{ decision: ConfirmDecision; start: number; len: number }> = [];
  let col = 0;
  for (const l of buttonLabels(suggestedPattern, toolName)) {
    const len = l.bracket.length + l.rest.length;
    out.push({ decision: l.decision, start: col, len });
    col += len;
  }
  return out;
}

function stringifyInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  return (
    Object.entries(obj)
      // `content`/`new_string` are bulky payloads; `diff` is rendered as a
      // proper DiffBlock below the summary — repeating its raw text here
      // would just be noise.
      .filter(([k]) => k !== 'content' && k !== 'new_string' && k !== 'diff')
      .map(([k, v]) => `${k}: ${truncate(JSON.stringify(v), 80)}`)
      .join('  ')
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Unified-diff text for the payload a mutating tool is about to write.
 *
 * `stringifyInput` strips `content`/`new_string` to keep the summary line
 * readable, and the branch meant to compensate keyed on `input.diff`. But
 * `diff` lives on EditOutput, never on EditInput/WriteInput, and no layer
 * enriches the input before the dialog receives it — so the branch was dead
 * and this dialog asked the user to approve an edit, or an arbitrary
 * whole-file overwrite, having shown them only a path (WS-080).
 *
 * Synthesised here from the fields the tool was actually given, so it renders
 * through the same DiffBlock the committed history entries use.
 */
export function payloadDiff(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  const filePath = typeof obj['path'] === 'string' ? obj['path'] : 'file';

  // A caller that genuinely supplies a prebuilt diff keeps working.
  if (typeof obj['diff'] === 'string' && obj['diff']) return obj['diff'];

  const newString = obj['new_string'];
  if (typeof newString === 'string') {
    // `old_string` absent is treated as an insertion rather than as a reason to
    // show nothing: a malformed or partial payload is exactly when the user most
    // needs to see what will be written.
    const oldString = typeof obj['old_string'] === 'string' ? obj['old_string'] : '';
    return unifiedDiff(oldString, newString, { fromFile: filePath, toFile: filePath, context: 2 });
  }

  // `write` replaces the whole file and has no "before", so every line is an
  // addition. Rendering it as a diff keeps one preview component for both.
  const content = obj['content'];
  if (typeof content === 'string' && content) {
    return unifiedDiff('', content, { fromFile: '/dev/null', toFile: filePath, context: 0 });
  }
  return '';
}

/** Max diff lines shown inside the approval dialog before truncation. */
const CONFIRM_DIFF_MAX_LINES = 20;

function renderDiffLine(line: string): React.ReactElement {
  const prefix = line.startsWith('+')
    ? 'green'
    : line.startsWith('-')
      ? 'red'
      : line.startsWith('@@')
        ? 'cyan'
        : undefined;
  return (
    <Text key={line} {...(prefix ? { color: prefix } : {})}>
      {line}
      {'\n'}
    </Text>
  );
}

/**
 * Pending-edit preview inside the approval dialog. Rendered with the same
 * Claude-Code-style `DiffBlock` the committed tool entries use (single
 * line-number gutter, dark add/del washes, syntax highlighting from the
 * target file's extension), so the "what you approve" preview and the
 * "what happened" entry look identical. Falls back to the flat per-line
 * coloring when the string doesn't parse as a unified diff.
 */
function renderDiff(diff: string, path: string | undefined): React.ReactElement {
  const preview = parseUnifiedDiff(diff, CONFIRM_DIFF_MAX_LINES);
  if (preview.rows.length > 0) {
    return (
      <DiffBlock
        rows={preview.rows}
        hidden={preview.hidden}
        added={preview.added}
        removed={preview.removed}
        hiddenAdded={preview.hiddenAdded}
        hiddenRemoved={preview.hiddenRemoved}
        useColor={theme.supportsBackground}
        lang={langFromPath(path ?? '')}
      />
    );
  }
  const lines = diff
    .split('\n')
    .filter((l) => l.length > 0)
    .slice(0, CONFIRM_DIFF_MAX_LINES);
  return (
    <Box flexDirection="column" paddingX={2}>
      {lines.map((l) => renderDiffLine(l))}
    </Box>
  );
}

export function ConfirmPrompt({
  toolName,
  input,
  suggestedPattern,
  onDecision,
  onEnableYolo,
  destructive,
  boundaryReason,
  writeTargets,
  maxRows,
}: ConfirmPromptProps): React.ReactElement {
  const size = useTerminalSize();
  const rowBudget = maxRows ?? size.rows;
  const buttons = React.useRef(new Map<ConfirmDecision, DOMElement>());
  const partialMouse = React.useRef('');
  const decided = React.useRef(false);
  const decide = (decision: ConfirmDecision) => {
    if (decided.current) return;
    decided.current = true;
    onDecision(decision);
  };
  const { stdin } = useStdin();
  React.useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      const chunk = splitTrailingMousePartial(partialMouse.current + data.toString());
      partialMouse.current = chunk.pending;
      for (const event of parseMouseEvents(chunk.consumed)) {
        if (event.kind !== 'press' || event.button !== 'left') continue;
        for (const [decision, node] of buttons.current) {
          const rect = measureElement(node);
          if (
            event.x > rect.x &&
            event.x <= rect.x + rect.width &&
            event.y > rect.y &&
            event.y <= rect.y + rect.height
          ) {
            decide(decision);
            break;
          }
        }
      }
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [stdin, decide]);
  // Terminal bell on mount — alerts the user that action is required,
  // especially important when the agent has been running autonomously
  // and the user may not be staring at the terminal.
  React.useEffect(() => {
    writeOut('\x07');
  }, []);

  useInput((input, key) => {
    // Ctrl+C belongs to interruption, never to the plain `c` trust shortcut.
    if (key.ctrl || key.meta || decided.current) return;
    // Ignore empty input and CRLF/LF artifacts (Enter produces \r on Windows, \n on Unix)
    if (!input || input === '\r' || input === '\n') return;
    // Capital 'Y' (Shift+y) enables YOLO mode — distinct from lowercase '[y]es'.
    // Checked before toLowerCase() so the two can never collide. With a
    // boundary reason YOLO is unavailable; the capital key must not fall
    // through and approve the protected call as lowercase 'y' would.
    if (input === 'Y') {
      if (!boundaryReason) onEnableYolo();
      return;
    }
    const ch = input.toLowerCase();
    if (ch === 'y') {
      decide('yes');
    } else if (ch === 'n') {
      decide('no');
    } else if (ch === 'a') {
      decide('always-exact');
    } else if (ch === 'c' && toolName === 'exec') {
      decide('always-command');
    } else if (ch === 't') {
      decide('always-tool');
    } else if (ch === 'd') {
      decide('deny');
    }
  });

  // JSON escaping neutralises ESC but not bidi overrides or invisible text, and
  // write targets are model-supplied paths printed raw: sanitize both before
  // they reach the dialog the user approves. Core's copy is the security-owning
  // one: the TUI's layout copy keeps ZWJ/tag sequences for emoji rendering.
  const inputSummary = sanitizeTerminalText(stringifyInput(input));
  const inp = input as { path?: unknown | undefined };
  // The diff is the content being approved: same core sanitizer as the summary
  // (DiffBlock's layout sanitizer keeps bidi/invisible characters). Tabs are
  // kept so DiffBlock expands them to its tab stops, as in the history entry.
  const diff = payloadDiff(input)
    .split('\t')
    .map((part) => sanitizeTerminalText(part))
    .join('\t');
  const diffPath = typeof inp?.path === 'string' ? inp.path : undefined;

  // NOTE: no marginY here — the call site wraps this in a measured Box that
  // owns the vertical margin, so `measureElement` on the wrapper reports the
  // exact box height (top border + content + bottom border) the mouse
  // hit-test relies on to locate the button row.
  return (
    <PanelInputProvider value={true}>
      <MonitorViewportProvider value={{ columns: size.columns, rows: rowBudget }}>
        <MonitorShell
          accent="yellow"
          icon="⚠"
          title={`APPROVAL REQUIRED · ${sanitizeTerminalText(toolName)}`}
          footer={
            <Box flexDirection="row" flexWrap="wrap">
              {buttonLabels(suggestedPattern, toolName).map((label) => (
                <Box
                  key={label.decision}
                  flexShrink={0}
                  ref={(node) => {
                    if (node) buttons.current.set(label.decision, node);
                    else buttons.current.delete(label.decision);
                  }}
                >
                  <Text>
                    <Text bold color={BUTTON_COLOR[label.decision]}>
                      {label.bracket}
                    </Text>
                    <Text dimColor>{label.rest}</Text>
                  </Text>
                </Box>
              ))}
            </Box>
          }
        >
          {inputSummary ? <Text dimColor>{inputSummary}</Text> : null}
          {boundaryReason ? (
            <Text color="yellow">KANBAN BOUNDARY: {sanitizeTerminalText(boundaryReason)}</Text>
          ) : null}
          {writeTargets && writeTargets.length > 0 ? (
            <Text color="yellow">
              WRITES:{' '}
              {writeTargets
                .slice(0, 5)
                .map((target) => sanitizeTerminalText(target))
                .join(', ')}
              {writeTargets.length > 5 ? ` (+${writeTargets.length - 5} more)` : ''}
            </Text>
          ) : null}
          {diff ? (
            <Box flexDirection="column" marginY={1}>
              {renderDiff(diff, diffPath)}
            </Box>
          ) : null}
          <Text dimColor>
            Remember: [a] this input; {toolName === 'exec' ? '[c] executable, any args; ' : ''}[t]
            tool, any input. Destructive calls still prompt.
          </Text>
          {!boundaryReason ? (
            <Box marginTop={1}>
              <Text dimColor>
                {' '}
                Tip: press{' '}
                <Text bold color="yellow">
                  Y
                </Text>{' '}
                to enable YOLO mode
                {destructive
                  ? ' (this destructive approval remains)'
                  : ' (skips future routine approvals)'}
                .
              </Text>
            </Box>
          ) : null}
        </MonitorShell>
      </MonitorViewportProvider>
    </PanelInputProvider>
  );
}
