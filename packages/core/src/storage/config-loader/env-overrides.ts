import type { Config } from '../../types/config.js';

function envBool(v: string): boolean {
  return !/^(0|false|no|off)$/i.test(v.trim());
}

export function envBoolOptional(v: string | undefined): boolean {
  return v !== undefined && envBool(v);
}

const LOG_LEVELS = new Set<Config['log']['level']>(['error', 'warn', 'info', 'debug', 'trace']);

function envLogLevel(v: string): Config['log']['level'] {
  const norm = v.trim().toLowerCase() as Config['log']['level'];
  return LOG_LEVELS.has(norm) ? norm : 'info';
}

const defaultIndexing = {
  onSessionStart: true,
  onEdit: true,
  watchExternal: true,
  debounceMs: 400,
} as const;

export type PartialConfig = Partial<Config> & {
  providers?: Record<
    string,
    { apiKey?: string | undefined; baseUrl?: string | undefined; type?: string | undefined }
  >;
  /** Fields that came from environment variables - must not be persisted. */
  _envSource?: Set<string> | undefined;
};

export const ENV_MAP: Record<string, (cfg: PartialConfig, val: string) => void> = {
  WRONGSTACK_PROVIDER: (c, v) => {
    c.provider = v;
    if (c._envSource === undefined) c._envSource = new Set();
    c._envSource.add('provider');
  },
  WRONGSTACK_MODEL: (c, v) => {
    c.model = v;
    if (c._envSource === undefined) c._envSource = new Set();
    c._envSource.add('model');
  },
  WRONGSTACK_API_KEY: (c, v) => {
    c.apiKey = v;
    if (c._envSource === undefined) c._envSource = new Set();
    c._envSource.add('apiKey');
  },
  WRONGSTACK_BASE_URL: (c, v) => {
    c.baseUrl = v;
    if (c._envSource === undefined) c._envSource = new Set();
    c._envSource.add('baseUrl');
  },
  WRONGSTACK_LOG_LEVEL: (c, v) => {
    /* v8 ignore next -- defensive: config defaults always seed c.log before env handlers run */
    if (!c.log) c.log = { level: 'info' };
    c.log.level = envLogLevel(v);
  },
  WRONGSTACK_INDEX_ON_START: (c, v) => {
    c.indexing = { ...defaultIndexing, ...c.indexing, onSessionStart: envBool(v) };
  },
  WRONGSTACK_INDEX_ON_EDIT: (c, v) => {
    c.indexing = { ...defaultIndexing, ...c.indexing, onEdit: envBool(v) };
  },
  WRONGSTACK_INDEX_WATCH: (c, v) => {
    c.indexing = { ...defaultIndexing, ...c.indexing, watchExternal: envBool(v) };
  },
};
