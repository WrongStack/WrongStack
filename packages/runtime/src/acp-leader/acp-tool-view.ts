/**
 * How a surface shows a tool call an ACP agent ran itself: as the WrongStack
 * tool it matches (`read`, `edit`, `bash`, `grep`, `delegate`, ...) with that tool's
 * input shape, and the result as plain text.
 *
 * The card's `name` stays the agent's own title. Listeners act on tool names
 * (LSP document sync, the file-author log, the skill companion, churn
 * steering) and must not react to edits WrongStack did not make, so the
 * canonical form travels beside it as `view`, for display only.
 *
 * Shapes come from the adapters' own renderers: Claude's (claude-agent-acp)
 * sends the Claude Code tool input as `rawInput`; Codex's (codex-acp) sends
 * `rawInput` only for a shell command and describes reads, searches and
 * file changes through `kind`, `title`, `locations` and diff content.
 */
import { isAbsolute, relative } from 'node:path';
import type { ACPCapturedDiff, ACPCapturedToolCall } from '@wrongstack/acp';
import type { EventMap } from '@wrongstack/contracts/kernel';

type Input = Record<string, unknown>;
type ToolCallView = NonNullable<EventMap['tool.started']['view']>;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function compact(input: Input): Input {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** A path inside the project as the project-relative path every WrongStack tool shows. */
export function projectPath(path: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return path;
  return rel.replaceAll('\\', '/');
}

/** A command's directory when it is not the project's own (shown as "in <dir>"). */
function workingDirectory(dir: unknown, cwd: string | undefined): string | undefined {
  const value = str(dir);
  if (!value || !cwd || !isAbsolute(value)) return value;
  const rel = relative(cwd, value);
  if (!rel) return undefined;
  return projectPath(value, cwd);
}

/** The command a shell wrapper runs: `bash -lc 'x'`, `pwsh -Command "x"`, or the argv joined. */
export function shellCommand(command: unknown): string | undefined {
  const argv = Array.isArray(command)
    ? command.filter((part): part is string => typeof part === 'string')
    : undefined;
  if (argv) {
    const flag = argv.findIndex((part) => /^-(?:l?c|Command)$/i.test(part));
    const shell = argv[0]?.replace(/^.*[\\/]/, '').toLowerCase() ?? '';
    if (
      flag >= 0 &&
      /^(?:ba|z)?sh$|^pwsh(?:\.exe)?$|^powershell(?:\.exe)?$|^cmd(?:\.exe)?$/.test(shell)
    )
      return argv.slice(flag + 1).join(' ') || undefined;
    return argv.join(' ') || undefined;
  }
  const text = str(command);
  if (!text) return undefined;
  const wrapped =
    /^(?:"[^"]*[\\/])?(?:(?:ba|z)?sh|pwsh(?:\.exe)?|powershell(?:\.exe)?)"?\s+(?:-NoProfile\s+)?(?:-l?c|-Command)\s+(['"])([\s\S]*)\1$/i.exec(
      text.trim(),
    );
  return wrapped?.[2] ?? text;
}

/** The changed lines of one diff: what is left after the lines both sides share at each end. */
export function changedLines(oldText: string, newText: string): { removed: string; added: string } {
  const before = oldText.split('\n');
  const after = newText.split('\n');
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  return {
    removed: before.slice(start, before.length - end).join('\n'),
    added: after.slice(start, after.length - end).join('\n'),
  };
}

function diffView(diffs: readonly ACPCapturedDiff[], cwd: string | undefined): ToolCallView {
  const files = [...new Set(diffs.map((diff) => projectPath(diff.path, cwd)))];
  const [first] = diffs;
  if (files.length === 1 && first) {
    if (first.oldText === null)
      return { name: 'write', input: { path: files[0], content: first.newText } };
    const merged = diffs.map((diff) => changedLines(diff.oldText ?? '', diff.newText));
    return {
      name: 'edit',
      input: {
        path: files[0],
        old_string: merged.map((part) => part.removed).join('\n'),
        new_string: merged.map((part) => part.added).join('\n'),
      },
    };
  }
  return { name: 'patch', input: { path: files[0], files } };
}

/** `Read file 'x'`, `Search for 'q' in p`, `List files in 'p'`: Codex's titles for its own reads. */
function codexTitleView(
  call: ACPCapturedToolCall,
  cwd: string | undefined,
): ToolCallView | undefined {
  const title = call.title.trim();
  const read = /^Read file '(.+)'$/.exec(title);
  if (read?.[1]) return { name: 'read', input: { path: projectPath(read[1], cwd) } };
  const search = /^Search for '(.+?)'(?: in (.+))?$/.exec(title);
  if (search?.[1])
    return {
      name: 'grep',
      input: compact({
        pattern: search[1],
        path: search[2] ? projectPath(search[2], cwd) : undefined,
      }),
    };
  const list = /^List files(?: in '(.+)')?$/.exec(title);
  if (list)
    return {
      name: 'ls',
      input: compact({ path: list[1] ? projectPath(list[1], cwd) : undefined }),
    };
  return undefined;
}

/**
 * The WrongStack tool an ACP tool call matches, with its input in that tool's
 * shape; `undefined` when nothing identifies it (the surface shows the
 * agent's title, as before).
 */
export function acpToolView(
  call: ACPCapturedToolCall,
  cwd?: string | undefined,
): ToolCallView | undefined {
  const raw: Input = call.rawInput ?? {};
  const file = str(raw['file_path']) ?? str(raw['notebook_path']);
  const path = file ? projectPath(file, cwd) : undefined;
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(call.title.trim());
  if (mcp?.[2]) return { name: mcp[2], input: raw, server: mcp[1] };
  if (path && typeof raw['old_string'] === 'string' && typeof raw['new_string'] === 'string')
    return {
      name: 'edit',
      input: compact({
        path,
        old_string: raw['old_string'],
        new_string: raw['new_string'],
        replace_all: raw['replace_all'] === true ? true : undefined,
      }),
    };
  if (path && Array.isArray(raw['edits'])) {
    const edits = raw['edits'].filter(
      (edit): edit is { old_string: string; new_string: string } =>
        typeof edit?.old_string === 'string' && typeof edit?.new_string === 'string',
    );
    return {
      name: 'edit',
      input: {
        path,
        old_string: edits.map((edit) => edit.old_string).join('\n'),
        new_string: edits.map((edit) => edit.new_string).join('\n'),
      },
    };
  }
  if (path && typeof raw['content'] === 'string')
    return { name: 'write', input: { path, content: raw['content'] } };
  if (path && (call.kind === 'read' || call.kind === undefined))
    return {
      name: 'read',
      input: compact({ path, offset: num(raw['offset']), limit: num(raw['limit']) }),
    };
  if (call.diffs?.length) return diffView(call.diffs, cwd);
  const command = shellCommand(raw['command']);
  if (command && (call.kind === 'execute' || call.kind === undefined || call.kind === 'other'))
    return {
      name: 'bash',
      input: compact({
        command,
        description: str(raw['description']),
        cwd: workingDirectory(raw['cwd'], cwd),
      }),
    };
  const pattern = str(raw['pattern']);
  if (pattern) {
    const scope = workingDirectory(raw['path'], cwd);
    if (/^grep\b/i.test(call.title.trim()) || raw['output_mode'] !== undefined)
      return {
        name: 'grep',
        input: compact({
          pattern,
          path: scope,
          glob: str(raw['glob']),
          output_mode: str(raw['output_mode']),
          case_insensitive: raw['-i'] === true ? true : undefined,
        }),
      };
    return { name: 'glob', input: compact({ pattern, path: scope }) };
  }
  const url = str(raw['url']);
  if (url) return { name: 'web_fetch', input: compact({ url, prompt: str(raw['prompt']) }) };
  if (call.kind === 'fetch' && str(raw['query']))
    return { name: 'web_search', input: { query: raw['query'] } };
  if (str(raw['subagent_type']) || (str(raw['prompt']) && str(raw['description'])))
    return {
      name: 'delegate',
      input: compact({
        task: str(raw['description']),
        agent: str(raw['subagent_type']),
        prompt: str(raw['prompt']),
      }),
    };
  if (call.kind === 'read' || call.kind === 'search') return codexTitleView(call, cwd);
  return undefined;
}

/** Claude Code's `cat -n` line prefixes: "     1→" or "     1\t" on every line. */
const LINE_NUMBER = /^ *\d+(?:→|\t)/;

/**
 * The text a tool call returned, as the tool printed it: without the Markdown
 * fence an adapter wraps it in, the `cat -n` numbers Claude's Read adds, or a
 * JSON envelope around a command's output.
 */
export function acpToolOutputText(call: ACPCapturedToolCall): string | undefined {
  let text = call.output;
  if (text === undefined) {
    const raw = call.rawOutput;
    if (!raw) return undefined;
    const printed =
      str(raw['output']) ??
      str(raw['formatted_output']) ??
      str(raw['aggregated_output']) ??
      ([str(raw['stdout']), str(raw['stderr'])].filter(Boolean).join('\n') || undefined);
    if (printed !== undefined) text = printed;
    else {
      // `{ exit_code: 0 }` alone: the output went to a terminal, nothing to show here.
      const keys = Object.keys(raw);
      if (
        keys.every((key) => ['exit_code', 'exitCode', 'success', 'stdout', 'stderr'].includes(key))
      )
        return undefined;
      return JSON.stringify(raw, null, 2);
    }
  }
  const fenced = /^```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(text.trim());
  if (fenced) text = fenced[1] ?? '';
  const lines = text.split('\n');
  const numbered = lines.filter((line) => line.length > 0);
  if (numbered.length > 0 && numbered.every((line) => LINE_NUMBER.test(line)))
    text = lines.map((line) => line.replace(LINE_NUMBER, '')).join('\n');
  return text;
}
