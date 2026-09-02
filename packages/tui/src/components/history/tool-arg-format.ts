import { numOf, shortenPath, stringOf, truncMid } from './basic-format.js';

const ARG_BUDGET = 60;

function stringArrayOf(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((item): item is string => typeof item === 'string')
    : undefined;
}

function fileScopeSummary(files: unknown, fallback?: string | undefined): string {
  const list = stringArrayOf(files);
  if (list && list.length > 0) {
    const first = list[0] ?? '';
    const more = list.length > 1 ? ` (+${list.length - 1})` : '';
    return first ? `${shortenPath(first, 42)}${more}` : `${list.length} files`;
  }
  const scalar = typeof files === 'string' ? files : fallback;
  return scalar ? shortenPath(scalar, 44) : '';
}

/**
 * Render the most useful single-line description of a tool call's arguments.
 */
export function formatToolArgs(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'read':
    case 'view_file':
    case 'write':
    case 'write_to_file':
    case 'edit':
    case 'replace_file_content':
    case 'patch':
    case 'list_dir':
    case 'list_directory':
    case 'ls':
    case 'tree': {
      const p =
        stringOf(obj['path']) ??
        stringOf(obj['file']) ??
        stringOf(obj['AbsolutePath']) ??
        stringOf(obj['TargetFile']) ??
        stringOf(obj['DirectoryPath']);
      return p ? shortenPath(p, ARG_BUDGET) : '';
    }
    case 'document': {
      const target = stringOf(obj['target']) ?? 'all';
      const scope = fileScopeSummary(obj['files'], stringOf(obj['path']));
      const style = stringOf(obj['style']);
      return [target, scope, style].filter(Boolean).join(' · ');
    }
    case 'grep':
    case 'grep_search':
    case 'search':
    case 'replace': {
      const pat = stringOf(obj['pattern']) ?? stringOf(obj['query']) ?? stringOf(obj['Query']);
      const scope =
        stringOf(obj['path']) ??
        stringOf(obj['glob']) ??
        stringOf(obj['SearchPath']) ??
        stringOf(obj['search_path']);
      const head = pat ? `"${truncMid(pat, 36)}"` : '';
      const tail = scope ? ` in ${shortenPath(scope, 28)}` : '';
      return `${head}${tail}` || (stringOf(obj['command']) ?? '');
    }
    case 'glob':
    case 'find_by_name':
    case 'find_files': {
      const pat = stringOf(obj['pattern']) ?? stringOf(obj['glob']) ?? stringOf(obj['Pattern']);
      const dir = stringOf(obj['SearchDirectory']) ?? stringOf(obj['path']);
      const head = pat ? `"${truncMid(pat, ARG_BUDGET - (dir ? 22 : 2))}"` : '';
      const tail = dir ? ` in ${shortenPath(dir, 18)}` : '';
      return `${head}${tail}`;
    }
    case 'bash':
    case 'shell':
    case 'run_command':
    case 'install':
    case 'git': {
      const cmd = stringOf(obj['command']) ?? stringOf(obj['args']) ?? stringOf(obj['CommandLine']);
      return cmd ? truncMid(cmd, ARG_BUDGET) : '';
    }
    case 'exec': {
      const command = stringOf(obj['command']);
      const args = stringArrayOf(obj['args']) ?? [];
      const cwd = stringOf(obj['cwd']);
      const cmd = [command, ...args].filter(Boolean).join(' ');
      const head = cmd ? truncMid(cmd, cwd ? 44 : ARG_BUDGET) : '';
      return cwd ? `${head} in ${shortenPath(cwd, 14)}` : head;
    }
    case 'diff': {
      const files = Array.isArray(obj['files']) ? (obj['files'] as unknown[]) : undefined;
      if (files && files.length > 0) {
        const head = stringOf(files[0]) ?? '';
        const rest = files.length > 1 ? ` (+${files.length - 1})` : '';
        return head ? `${shortenPath(head, 50)}${rest}` : '';
      }
      const mode = stringOf(obj['mode']);
      return mode ? `mode: ${mode}` : '';
    }
    case 'fetch':
    case 'webfetch':
    case 'web_fetch':
    case 'read_url_content': {
      const u = stringOf(obj['url']) ?? stringOf(obj['Url']);
      return u ? truncMid(u, ARG_BUDGET) : '';
    }
    case 'search_web':
    case 'web_search': {
      const q = stringOf(obj['query']) ?? stringOf(obj['q']);
      return q ? `"${truncMid(q, ARG_BUDGET - 2)}"` : '';
    }
    case 'todo': {
      const list = obj['todos'];
      if (Array.isArray(list)) return `${list.length} item${list.length === 1 ? '' : 's'}`;
      return '';
    }
    case 'plan': {
      const action = stringOf(obj['action']) ?? 'show';
      const target =
        stringOf(obj['target']) ?? stringOf(obj['title']) ?? stringOf(obj['template']) ?? '';
      const scope = stringOf(obj['scope']);
      return [action, target ? truncMid(target, 34) : '', scope].filter(Boolean).join(' · ');
    }
    case 'task': {
      const action = stringOf(obj['action']) ?? 'show';
      const task =
        obj['task'] && typeof obj['task'] === 'object'
          ? (obj['task'] as Record<string, unknown>)
          : undefined;
      const target =
        stringOf(obj['target']) ??
        stringOf(obj['id']) ??
        stringOf(task?.['title']) ??
        (Array.isArray(obj['tasks']) ? `${obj['tasks'].length} tasks` : '');
      const status = stringOf(obj['status']);
      return [action, target ? truncMid(target, 32) : '', status].filter(Boolean).join(' · ');
    }
    case 'lint':
    case 'format':
    case 'typecheck':
    case 'test':
    case 'audit':
    case 'outdated': {
      const files = obj['files'];
      if (Array.isArray(files) && files.length > 0) {
        const first = stringOf(files[0]);
        const more = files.length > 1 ? ` (+${files.length - 1})` : '';
        return first ? `${shortenPath(first, 50)}${more}` : `${files.length} files`;
      }
      const filter = stringOf(obj['filter']) ?? stringOf(obj['pattern']);
      return filter ? `"${truncMid(filter, ARG_BUDGET - 2)}"` : '';
    }
    case 'json': {
      const file = stringOf(obj['file']);
      const q = stringOf(obj['query']);
      if (file) return q ? `${shortenPath(file, 40)}  ${q}` : shortenPath(file, ARG_BUDGET);
      return q ? truncMid(q, ARG_BUDGET) : '';
    }
    case 'scaffold': {
      const tmpl = stringOf(obj['template']) ?? stringOf(obj['type']);
      const name = stringOf(obj['name']);
      if (tmpl && name) return `${tmpl} → ${truncMid(name, ARG_BUDGET - tmpl.length - 4)}`;
      return name ?? tmpl ?? '';
    }
    case 'remember': {
      const scope = stringOf(obj['scope']);
      const type = stringOf(obj['type']);
      const text = stringOf(obj['text']);
      return [scope, type, text ? truncMid(text, 34) : ''].filter(Boolean).join(' · ');
    }
    case 'forget': {
      const query = stringOf(obj['query']);
      const scope = stringOf(obj['scope']);
      return [query ? `"${truncMid(query, 36)}"` : '', scope].filter(Boolean).join(' · ');
    }
    case 'search_memory':
    case 'find_related_memories': {
      const query = stringOf(obj['query']) ?? stringOf(obj['text']);
      const scope = stringOf(obj['scope']);
      return [query ? `"${truncMid(query, 36)}"` : '', scope].filter(Boolean).join(' · ');
    }
    case 'memory': {
      const key = stringOf(obj['key']) ?? stringOf(obj['name']);
      return key ? truncMid(key, ARG_BUDGET) : '';
    }
    case 'mode': {
      const action = stringOf(obj['action']);
      const m = stringOf(obj['mode']) ?? stringOf(obj['name']);
      return [action, m].filter(Boolean).join(' · ');
    }
    case 'logs': {
      const target = stringOf(obj['target']) ?? stringOf(obj['service']) ?? stringOf(obj['path']);
      const filter = stringOf(obj['filter']);
      const since = stringOf(obj['since']);
      const lines = typeof obj['lines'] === 'number' ? `${obj['lines']} lines` : '';
      return [
        target ? shortenPath(target, 34) : '',
        filter ? `/${truncMid(filter, 16)}/` : '',
        since,
        lines,
      ]
        .filter(Boolean)
        .join(' · ');
    }
    case 'tool_help': {
      const tool = stringOf(obj['tool']) ?? 'all';
      const format = stringOf(obj['format']);
      return [tool, format].filter(Boolean).join(' · ');
    }
    case 'tool_search': {
      const query = stringOf(obj['query']);
      const tags = stringArrayOf(obj['tags']);
      const filters = [
        query ? `"${truncMid(query, 28)}"` : '',
        tags && tags.length > 0 ? tags.join(',') : '',
        stringOf(obj['permission']),
        typeof obj['mutating'] === 'boolean' ? (obj['mutating'] ? 'mutating' : 'read-only') : '',
      ].filter(Boolean);
      return filters.join(' · ');
    }
    case 'tool_use': {
      const tool = stringOf(obj['tool']);
      return tool ? `call ${tool}` : '';
    }
    case 'batch_tool_use': {
      const calls = Array.isArray(obj['calls']) ? obj['calls'] : [];
      const mode = obj['parallel'] === false ? 'sequential' : 'parallel';
      return `${calls.length} call${calls.length === 1 ? '' : 's'} · ${mode}`;
    }
    case 'codebase-index': {
      const langs = stringArrayOf(obj['langs']);
      const force = obj['force'] === true ? 'force' : '';
      return [force, langs && langs.length > 0 ? langs.join(',') : 'incremental']
        .filter(Boolean)
        .join(' · ');
    }
    case 'codebase-search': {
      const query = stringOf(obj['query']);
      const filters = [
        stringOf(obj['kind']),
        stringOf(obj['lang']),
        stringOf(obj['file']) ? `in ${shortenPath(String(obj['file']), 24)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return [query ? `"${truncMid(query, 30)}"` : '', filters].filter(Boolean).join(' · ');
    }
    case 'codebase-stats':
      return 'index health';
    case 'lsp_diagnostics': {
      const path = stringOf(obj['path']);
      const severity = stringArrayOf(obj['severity']) ?? stringArrayOf(obj['severities']);
      return [path ? shortenPath(path, 40) : 'workspace', severity?.join('+')]
        .filter(Boolean)
        .join(' · ');
    }
    case 'lsp_definition':
    case 'lsp_completion':
    case 'lsp_rename': {
      const path = stringOf(obj['path']) ?? stringOf(obj['file']);
      const line = numOf(obj['line']);
      const character = numOf(obj['character']);
      const position = line !== undefined ? `L${line}:${character ?? 1}` : '';
      const rename = toolName === 'lsp_rename' ? stringOf(obj['new_name']) : undefined;
      return [path ? shortenPath(path, 38) : '', position, rename ? `→ ${rename}` : '']
        .filter(Boolean)
        .join(' · ');
    }
    case 'set_working_dir': {
      const p = stringOf(obj['path']);
      return p ? shortenPath(p, ARG_BUDGET) : 'current';
    }
  }

  for (const key of ['path', 'file', 'url', 'name', 'query', 'pattern', 'command']) {
    const v = stringOf(obj[key]);
    if (v) return truncMid(v, ARG_BUDGET);
  }
  try {
    return truncMid(JSON.stringify(obj), ARG_BUDGET);
  } catch {
    return '';
  }
}
