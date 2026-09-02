/**
 * commit-message-validator plugin — PreToolUse hook that validates
 * conventional-commit format on `git_autocommit` and `bash` (git commit)
 * before the commit is created.
 *
 * Tools registered:
 * - commit_validator_status : Show config + per-session counters.
 *
 * Hooks registered:
 * - PreToolUse with matcher `bash|git_autocommit`. Inspects the
 *   commit message (from toolInput.message for git_autocommit, or
 *   parsed from `-m` flag for bash git commit). If the message does
 *   not match the conventional-commit format, the call is blocked.
 *
 * Config (`config.extensions['commit-validator']`):
 *
 * ```jsonc
 * {
 *   "mode": "block",        // "block" | "warn"
 *   "requireScope": false,  // require a scope in parentheses
 *   "allowedTypes": [],     // empty = all types allowed; or ["feat","fix","docs",...]
 *   "maxSubjectLength": 72  // subject line character limit
 * }
 * ```
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

const state = {
  invocationCount: 0,
  validCount: 0,
  invalidCount: 0,
  /** Times the LLM successfully produced a subject suggestion. */
  suggestFixCount: 0,
  /** Times the LLM call failed or was skipped (api.llm absent, etc.). */
  suggestFixErrors: 0,
  hookUnregister: null as null | (() => void),
  lastValidation: null as null | {
    tool: string;
    valid: boolean;
    type: string;
    scope: string;
    subject: string;
    errors: string[];
    when: string;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface CommitValidatorConfig {
  mode: 'block' | 'warn';
  requireScope: boolean;
  allowedTypes: string[];
  maxSubjectLength: number;
  /** Require a non-empty body after the subject line. */
  bodyRequired: boolean;
  /** Minimum body length in characters (when bodyRequired). */
  minBodyLength: number;
  /**
   * When true and `mode === 'warn'`, the plugin asks the host LLM
   * (`api.llm`) for a one-line corrected conventional-commit subject
   * and includes it in the warn-context. Strictly opt-in because LLM
   * calls aren't free. The LLM is never consulted in `block` mode
   * (the model already has the block reason to act on).
   */
  suggestFix: boolean;
}

const DEFAULTS: CommitValidatorConfig = {
  mode: 'block',
  requireScope: false,
  allowedTypes: [],
  maxSubjectLength: 72,
  bodyRequired: false,
  minBodyLength: 10,
  suggestFix: false,
};

function readConfig(raw: unknown): CommitValidatorConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawMode =
    typeof (r['mode'] ?? r['action'] ?? r['behavior']) === 'string'
      ? String(r['mode'] ?? r['action'] ?? r['behavior'])
          .trim()
          .toLowerCase()
      : undefined;
  const mode = rawMode === 'warn' ? 'warn' : 'block';
  const rawTypes = r['allowedTypes'] ?? r['allowed_types'] ?? r['types'];
  const rawMaxSubj =
    r['maxSubjectLength'] ?? r['max_subject_length'] ?? r['maxLength'] ?? r['max_length'];
  const rawMinBody =
    r['minBodyLength'] ?? r['min_body_length'] ?? r['minLength'] ?? r['min_length'];

  return {
    mode,
    requireScope: (r['requireScope'] ?? r['require_scope']) === true,
    allowedTypes: Array.isArray(rawTypes)
      ? (rawTypes as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    maxSubjectLength:
      typeof rawMaxSubj === 'number' && rawMaxSubj > 0 ? rawMaxSubj : DEFAULTS.maxSubjectLength,
    bodyRequired:
      (r['bodyRequired'] ?? r['body_required'] ?? r['requireBody'] ?? r['require_body']) === true,
    minBodyLength:
      typeof rawMinBody === 'number' && rawMinBody > 0 ? rawMinBody : DEFAULTS.minBodyLength,
    suggestFix: (r['suggestFix'] ?? r['suggest_fix']) === true,
  };
}

// ---------------------------------------------------------------------------
// Conventional commit parser
// ---------------------------------------------------------------------------

interface ParsedCommit {
  valid: boolean;
  type: string;
  scope: string;
  subject: string;
  /** True if the commit has a breaking-change marker (`!`). */
  breaking: boolean;
  errors: string[];
}

// Standard conventional-commit types.
const STANDARD_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'i18n',
  'a11y',
];

/**
 * Parse and validate a conventional-commit message.
 *
 * Format: `<type>[optional scope][!]: <description>`
 * Examples:
 *   feat: add new feature
 *   fix(auth): correct login redirect
 *   feat!: breaking change to API
 *   docs(readme): update installation steps
 */
function parseCommitMessage(message: string, cfg: CommitValidatorConfig): ParsedCommit {
  const errors: string[] = [];
  const firstLine = message.trim().split('\n')[0] ?? '';

  if (!firstLine) {
    return {
      valid: false,
      type: '',
      scope: '',
      subject: '',
      breaking: false,
      errors: ['empty commit message'],
    };
  }

  // Regex: type(scope)!: subject  or  type: subject  or  type!: subject
  // Groups: 1=type, 2=scope (optional), 3=breaking marker, 4=subject
  const match = firstLine.match(/^([a-zA-Z][a-zA-Z0-9_-]*)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);

  if (!match) {
    errors.push(
      `Message does not match conventional-commit format: "<type>[(scope)][!]: <description>". ` +
        `Got: "${firstLine.slice(0, 60)}"`,
    );
    return { valid: false, type: '', scope: '', subject: firstLine, breaking: false, errors };
  }

  const [, typeRaw, scopeRaw, breakingRaw, subjectRaw] = match;
  const type = (typeRaw ?? '').toLowerCase();
  const scope = scopeRaw ?? '';
  const breaking = breakingRaw === '!';
  const subject = subjectRaw ?? '';

  // Validate type.
  if (!type) {
    errors.push('Missing commit type (e.g. feat, fix, docs).');
  } else if (cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) {
    errors.push(
      `Type "${type}" is not in allowedTypes: ${cfg.allowedTypes.join(', ')}. ` +
        `Standard types: ${STANDARD_TYPES.join(', ')}.`,
    );
  } else if (cfg.allowedTypes.length === 0 && !STANDARD_TYPES.includes(type)) {
    // Warn about non-standard types but don't block (allowedTypes is empty = allow all).
    // We still accept it — some projects use custom types like "wip", "deps".
  }

  // Validate scope.
  if (cfg.requireScope && !scope) {
    errors.push('A scope is required (e.g. feat(auth): ...).');
  }

  // Validate subject.
  if (!subject) {
    errors.push('Missing subject description after the colon.');
  }
  if (subject.length > cfg.maxSubjectLength) {
    errors.push(
      `Subject is ${subject.length} characters — exceeds maxSubjectLength of ${cfg.maxSubjectLength}. ` +
        `Move details to the body.`,
    );
  }
  // Subject should NOT end with a period.
  if (subject.endsWith('.')) {
    errors.push('Subject should not end with a period.');
  }

  // Validate body (if required).
  // The body is everything after the first line (conventional-commit
  // format requires a blank line between subject and body).
  if (cfg.bodyRequired) {
    const lines = message.trim().split('\n');
    // Subject is lines[0]. A properly formatted body has a blank line
    // after the subject, then the body content.
    const bodyStart = lines.findIndex((line, i) => i > 0 && line.trim() === '');
    const body =
      bodyStart >= 0
        ? lines
            .slice(bodyStart + 1)
            .join('\n')
            .trim()
        : '';
    if (!body) {
      errors.push(
        'A commit body is required. Add a blank line after the subject, then the description.',
      );
    } else if (body.length < cfg.minBodyLength) {
      errors.push(
        `Body is ${body.length} characters — minimum is ${cfg.minBodyLength}. ` +
          `Add more context about what changed and why.`,
      );
    }
  }

  return {
    valid: errors.length === 0,
    type,
    scope,
    subject,
    breaking,
    errors,
  };
}

/**
 * Extract the commit message from a bash `git commit -m "..."` command.
 * Returns the message string, or null if no commit message was found.
 */
/**
 * Every spelling of git's message flag, in one alternation so `matchAll`
 * yields them in command-line order.
 *
 * Ordering matters: git joins repeated `-m` values with a blank line, and
 * the FIRST one is the subject that this validator checks. Scanning
 * double-quoted values and then single-quoted ones (the previous
 * approach) reordered a mixed-quoting command — `-m 'feat: x' -m "body"`
 * produced `body\nfeat: x`, so the body was validated as the subject and
 * a perfectly good commit was rejected.
 *
 * The bare (unquoted) and `--message=` forms are matched too. Leaving
 * them out meant `git commit -m chore:x` and `git commit --message="…"`
 * produced no message at all, and the hook let them through unchecked —
 * a silent hole in the gate.
 */
const GIT_MESSAGE_FLAG_RE = new RegExp(
  [
    // -m "…" | -m '…' | -m=… ; --message "…" | --message='…' | --message=…
    String.raw`(?:^|\s)(?:-m|--message)(?:\s+|=)"([^"]*)"`,
    String.raw`(?:^|\s)(?:-m|--message)(?:\s+|=)'([^']*)'`,
    // Bare value: stops at whitespace or a shell separator.
    String.raw`(?:^|\s)(?:-m|--message)(?:\s+|=)([^\s;&|"']+)`,
  ].join('|'),
  'g',
);

function extractMessageFromBash(command: string): string | null {
  const parts: string[] = [];
  for (const m of command.matchAll(GIT_MESSAGE_FLAG_RE)) {
    // Exactly one alternative's group is defined per match.
    const value = m[1] ?? m[2] ?? m[3];
    if (value !== undefined) parts.push(value);
  }
  if (parts.length === 0) return null;
  // git separates repeated -m values with a blank line; the first is the
  // subject, which is what `parseCommitMessage` validates.
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'commit-validator',
  version: '0.1.0',
  description:
    'PreToolUse hook that validates conventional-commit format before git_autocommit or bash git commit runs',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true, llm: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['block', 'warn'],
        default: 'block',
        description:
          '"block" refuses the commit; "warn" injects errors as context but lets it through.',
      },
      requireScope: {
        type: 'boolean',
        default: false,
        description: 'Require a scope in parentheses (e.g. feat(auth): ...).',
      },
      allowedTypes: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description:
          'Restrict to these commit types. Empty = allow all standard types (feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert) plus any custom type.',
      },
      maxSubjectLength: {
        type: 'number',
        minimum: 10,
        default: 72,
        description: 'Maximum subject line length in characters.',
      },
      bodyRequired: {
        type: 'boolean',
        default: false,
        description: 'Require a non-empty commit body after the subject line.',
      },
      minBodyLength: {
        type: 'number',
        minimum: 1,
        default: 10,
        description: 'Minimum body length in characters (when bodyRequired is true).',
      },
      suggestFix: {
        type: 'boolean',
        default: false,
        description:
          "When true and mode=warn, ask the host LLM for a corrected conventional-commit subject and include it in the warn context. Off by default (LLM calls aren't free). Ignored in block mode.",
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.validCount = 0;
    state.invalidCount = 0;
    state.suggestFixCount = 0;
    state.suggestFixErrors = 0;
    state.hookUnregister = releaseHandle(state.hookUnregister);
    state.lastValidation = null;

    const cfg = readConfig(api.config.extensions?.['commit-validator']);

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
    }): Promise<{
      decision?: 'block' | 'allow' | undefined;
      reason?: string;
      additionalContext?: string;
    } | void> => {
      const toolName = input.toolName ?? '';
      const inp = (input.toolInput ?? {}) as Record<string, unknown>;

      let message: string | null = null;

      if (toolName === 'git_autocommit') {
        // The git-autocommit plugin generates the message internally —
        // we can't intercept it before the tool runs. But the `message`
        // field in toolInput is the user-provided override (if any),
        // and the `type` field hints at the conventional type.
        // If the user provided a message, validate it. If not, trust
        // the plugin's heuristic.
        message =
          (inp['message'] as string | undefined) ??
          (inp['msg'] as string | undefined) ??
          (inp['commitMessage'] as string | undefined) ??
          (inp['commit_message'] as string | undefined) ??
          (inp['description'] as string | undefined) ??
          (inp['summary'] as string | undefined) ??
          (inp['text'] as string | undefined) ??
          null;
        if (!message) {
          // No user message — validate the type field instead.
          const type = inp['type'] as string | undefined;
          if (type && cfg.allowedTypes.length > 0 && !cfg.allowedTypes.includes(type)) {
            state.invocationCount += 1;
            state.invalidCount += 1;
            state.lastValidation = {
              tool: toolName,
              valid: false,
              type,
              scope: '',
              subject: '',
              errors: [`Type "${type}" is not in allowedTypes: ${cfg.allowedTypes.join(', ')}`],
              when: new Date().toISOString(),
            };
            if (cfg.mode === 'block') {
              return {
                decision: 'block',
                reason: `commit-validator: type "${type}" is not allowed. Allowed: ${cfg.allowedTypes.join(', ')}.`,
              };
            }
            return {
              decision: 'allow',
              additionalContext: `\n⚠️ commit-validator: type "${type}" is not in allowedTypes.`,
            };
          }
          return; // No message to validate, type is ok — let it through.
        }
      } else if (toolName === 'bash') {
        const command =
          (inp['command'] as string | undefined) ??
          (inp['CommandLine'] as string | undefined) ??
          (inp['cmd'] as string | undefined) ??
          (inp['script'] as string | undefined) ??
          (inp['input'] as string | undefined);
        if (typeof command !== 'string') return;
        // Only intercept git commit commands.
        if (!/\bgit\s+commit\b/.test(command)) return;
        message = extractMessageFromBash(command);
        if (!message) return; // No -m flag found — can't validate, let it through.
      } else {
        return; // Not a commit tool.
      }

      state.invocationCount += 1;

      const parsed = parseCommitMessage(message, cfg);
      state.lastValidation = {
        tool: toolName,
        valid: parsed.valid,
        type: parsed.type,
        scope: parsed.scope,
        subject: parsed.subject,
        errors: parsed.errors,
        when: new Date().toISOString(),
      };

      if (parsed.valid) {
        state.validCount += 1;
        return; // Valid — let it through silently.
      }

      // Invalid commit message.
      state.invalidCount += 1;
      const errorList = parsed.errors.map((e) => `  • ${e}`).join('\n');
      const example = `feat: add user authentication\n  fix(api): correct response parsing\n  docs: update README`;

      if (cfg.mode === 'block') {
        return {
          decision: 'block',
          reason:
            `commit-validator: invalid conventional-commit message.\n` +
            `Errors:\n${errorList}\n\n` +
            `Expected format: <type>[(scope)][!]: <description>\n` +
            `Examples:\n  ${example}`,
        };
      }

      // mode === 'warn'
      let baseContext =
        `\n⚠️ commit-validator: commit message has ${parsed.errors.length} issue(s):\n${errorList}\n` +
        `Expected: <type>[(scope)][!]: <description>`;

      // Opt-in LLM suggestion. Strictly best-effort: a failure here
      // never blocks the warn context from being injected.
      if (cfg.suggestFix && api.llm) {
        try {
          const suggest = await api.llm.complete(
            `The user wrote a conventional-commit message that fails validation:\n` +
              `Original: ${message}\n` +
              `Errors: ${parsed.errors.join('; ')}\n` +
              `Reply with ONE corrected conventional-commit subject line (and optional body) and nothing else.`,
            {
              system:
                'You rewrite commit subjects to follow the conventional-commits format. Reply tersely, no preamble, no quotes.',
              role: 'reviewer',
              maxTokens: 120,
            },
          );
          const text = suggest.text.trim();
          if (text) {
            state.suggestFixCount += 1;
            api.metrics.counter('suggest_fix');
            baseContext += `\nSuggested rewrite (${suggest.model}):\n  ${text.split('\n').join('\n  ')}`;
          }
        } catch {
          state.suggestFixErrors += 1;
        }
      }

      return {
        decision: 'allow',
        additionalContext: baseContext,
      };
    };

    state.hookUnregister = api.registerHook('PreToolUse', 'bash|git_autocommit', hook, {
      name: 'commit-validator',
      stage: 'validate',
      failurePolicy: 'closed',
      policy: true,
    });

    // --- commit_validator_status tool ---
    api.tools.register({
      name: 'commit_validator_status',
      description:
        'Reports commit-validator state: mode, allowedTypes, maxSubjectLength, and per-session valid/invalid counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Git',
      mutating: false,
      async execute() {
        return {
          ok: true,
          mode: cfg.mode,
          requireScope: cfg.requireScope,
          allowedTypes: cfg.allowedTypes,
          maxSubjectLength: cfg.maxSubjectLength,
          bodyRequired: cfg.bodyRequired,
          minBodyLength: cfg.minBodyLength,
          standardTypes: STANDARD_TYPES,
          counters: {
            invocations: state.invocationCount,
            valid: state.validCount,
            invalid: state.invalidCount,
            suggestFix: state.suggestFixCount,
            suggestFixErrors: state.suggestFixErrors,
          },
          lastValidation: state.lastValidation,
        };
      },
    });

    api.log.info('commit-validator plugin loaded', {
      version: '0.1.0',
      mode: cfg.mode,
      requireScope: cfg.requireScope,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      valid: state.validCount,
      invalid: state.invalidCount,
      suggestFix: state.suggestFixCount,
      suggestFixErrors: state.suggestFixErrors,
    };
    state.invocationCount = 0;
    state.validCount = 0;
    state.invalidCount = 0;
    state.suggestFixCount = 0;
    state.suggestFixErrors = 0;
    state.lastValidation = null;
    api.log.info('commit-validator: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message:
        state.lastValidation === null
          ? `commit-validator: ${state.invocationCount} validation(s), ${state.validCount} valid, ${state.invalidCount} invalid`
          : state.lastValidation.valid
            ? `commit-validator: last commit "${state.lastValidation.type}: ${state.lastValidation.subject.slice(0, 40)}" was valid`
            : `commit-validator: last commit was invalid (${state.lastValidation.errors.length} error(s)) at ${state.lastValidation.when}`,
      counters: {
        invocations: state.invocationCount,
        valid: state.validCount,
        invalid: state.invalidCount,
        suggestFix: state.suggestFixCount,
        suggestFixErrors: state.suggestFixErrors,
      },
      lastValidation: state.lastValidation,
    };
  },
};

export default plugin;
