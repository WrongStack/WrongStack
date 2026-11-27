import {
  type EvidenceFinding,
  gitRead,
  isTestPath,
  type ProjectCollectContext,
  type ProjectCollection,
  readText,
  SOURCE_EXTENSIONS,
  walkFiles,
} from '../evidence-analyzer/project.js';

const TEMPLATES = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  'example.env',
  '.env.defaults',
];
const COMMITTED_SECRETS = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.prod',
];

/** Variables every runtime/CI provides; never part of an application's env contract. */
const AMBIENT = new Set([
  'NODE_ENV',
  'PATH',
  'HOME',
  'PWD',
  'USER',
  'USERNAME',
  'SHELL',
  'TERM',
  'LANG',
  'TZ',
  'CI',
  'DEBUG',
  'TMPDIR',
  'TEMP',
  'TMP',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'COMSPEC',
  'SYSTEMROOT',
  'PATHEXT',
  'HOSTNAME',
  'FORCE_COLOR',
  'NO_COLOR',
  'COLORTERM',
  'EDITOR',
  'VISUAL',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'BASE_URL',
  'VITEST',
  'JEST_WORKER_ID',
  'NODE_OPTIONS',
  'NODE_DEBUG',
  'TERM_PROGRAM',
  'WT_SESSION',
  'PROGRAMFILES',
  'WINDIR',
  'SystemRoot',
  'ProgramFiles',
]);
const AMBIENT_PREFIX =
  /^(?:GITHUB_|RUNNER_|npm_|VITEST_|BUN_|CODESPACE|VSCODE_|ACTIONS_|PNPM_|YARN_|LC_)/;

const REFERENCE_PATTERNS: readonly RegExp[] = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]\s*\]/g,
  /import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bBun\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bDeno\.env\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /\bos\.(?:environ(?:\.get)?\(?\s*\[?|getenv\(\s*)['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
  /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
  /\benv::var(?:_os)?\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
];

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE)/i;
const PLACEHOLDER =
  /^(?:|changeme|change[-_]?me|replace[-_.]?me|todo|xxx+|\*+|your[-_].*|<.*>|\$\{.*\}|example.*|dummy.*|test.*|placeholder.*|none|null|false|true|0|1)$/i;

function isAmbient(name: string): boolean {
  return AMBIENT.has(name) || AMBIENT_PREFIX.test(name);
}

interface TemplateEntry {
  name: string;
  value: string;
  line: number;
}

function parseTemplate(text: string): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  text.split('\n').forEach((raw, index) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(
      raw.replace(/\r$/, ''),
    );
    if (!match) return;
    const value = match[2]!.replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
    entries.push({ name: match[1]!, value, line: index + 1 });
  });
  return entries;
}

/** Compare the env template with variables the source reads, and catch committed secrets. */
export async function collectEnvContract(
  context: ProjectCollectContext,
): Promise<ProjectCollection> {
  const { root, signal, options } = context;
  const maxFiles =
    typeof options['maxFiles'] === 'number' && options['maxFiles'] > 0
      ? Math.min(options['maxFiles'], 20000)
      : 5000;
  const findings: EvidenceFinding[] = [];
  const inspected: string[] = [];

  let template: { file: string; entries: TemplateEntry[] } | null = null;
  for (const file of TEMPLATES) {
    const text = await readText(root, file);
    if (text !== null) {
      template = { file, entries: parseTemplate(text) };
      inspected.push(file);
      break;
    }
  }

  const tracked = await gitRead(root, ['ls-files', '--', ...COMMITTED_SECRETS], signal);
  for (const file of (tracked ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    findings.push({
      rule: 'environment file committed',
      severity: 'error',
      file,
      line: 0,
      excerpt: `${file} is tracked by git`,
      advice:
        'Remove it from git (git rm --cached), add it to .gitignore, and rotate any values it held.',
    });
  }

  if (template) {
    for (const entry of template.entries) {
      if (
        SECRET_NAME.test(entry.name) &&
        entry.value.length >= 16 &&
        !PLACEHOLDER.test(entry.value)
      ) {
        findings.push({
          rule: 'environment value exposed',
          severity: 'error',
          file: template.file,
          line: entry.line,
          excerpt: `${entry.name}=[REDACTED] (${entry.value.length} chars)`,
          advice:
            'Treat the value as compromised, rotate it, and leave a placeholder in the template.',
        });
      }
    }
  }

  const { files, truncated } = await walkFiles(root, {
    extensions: SOURCE_EXTENSIONS,
    maxFiles,
    signal,
  });
  const references = new Map<string, { file: string; line: number; count: number }>();
  for (const file of files) {
    signal.throwIfAborted();
    if (isTestPath(file)) continue;
    const text = await readText(root, file, 1024 * 1024);
    if (!text || !/env/.test(text)) continue;
    for (const pattern of REFERENCE_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1]!;
        if (isAmbient(name)) continue;
        const known = references.get(name);
        if (known) known.count += 1;
        else
          references.set(name, {
            file,
            line: text.slice(0, match.index).split('\n').length,
            count: 1,
          });
      }
    }
  }

  if (template) {
    const declared = new Set(template.entries.map((e) => e.name));
    // Most-read first: the variables the code leans on hardest lead the list.
    const byUse = [...references].sort((a, b) => b[1].count - a[1].count);
    for (const [name, ref] of byUse) {
      if (declared.has(name)) continue;
      findings.push({
        rule: 'variable read but not in template',
        severity: 'warning',
        file: ref.file,
        line: ref.line,
        excerpt: `${name} (read ${ref.count}×) is missing from ${template.file}`,
        advice: `Declare ${name} in ${template.file} with a placeholder so deployments know to provide it.`,
      });
    }
    if (!truncated) {
      for (const entry of template.entries) {
        if (references.has(entry.name) || isAmbient(entry.name)) continue;
        findings.push({
          rule: 'template variable never read',
          severity: 'info',
          file: template.file,
          line: entry.line,
          excerpt: `${entry.name} is declared but no scanned source reads it`,
          advice:
            'Remove it from the template if obsolete, or confirm a framework reads it implicitly.',
        });
      }
    }
  } else if (references.size > 0) {
    findings.push({
      rule: 'no environment template',
      severity: 'info',
      file: '.',
      line: 0,
      excerpt: `${references.size} variable(s) read by source, e.g. ${[...references.keys()].slice(0, 8).join(', ')}`,
      advice: 'Add a .env.example listing required variables with placeholders.',
    });
  }

  return {
    findings,
    inspected: [
      ...inspected,
      `${files.length} source file(s)${truncated ? ' (truncated)' : ''}`,
      'git ls-files',
    ],
    facts: {
      template: template?.file ?? null,
      declared: template?.entries.length ?? 0,
      referenced: references.size,
      ...(truncated ? { truncatedAt: maxFiles } : {}),
    },
    limitation:
      'Literal env references only (process.env.X, import.meta.env.X, os.getenv("X"), …); computed names and framework-implicit variables are not seen. Values are never echoed.',
  };
}
