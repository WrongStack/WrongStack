import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type {
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
} from '@wrongstack/contracts/types';
import { sanitizeTerminalText } from '@wrongstack/core/utils';
import {
  type ElicitationField,
  type ElicitationForm,
  type ElicitationRequester,
  type MCPElicitationRequest,
  type MCPElicitationResult,
  parseElicitationParams,
  type UrlElicitation,
  validateElicitationContent,
} from './elicitation.js';

/** Re-asks after an answer the schema rejects, before giving up. */
const MAX_ATTEMPTS = 3;
const CONFIRM_QUESTION = 'confirm';
const URL_QUESTION = 'url';

/** Opens a page in the user's browser; given by a host that can. */
export type OpenUrl = (url: string) => void;

export interface ElicitViaUserInputOptions {
  /**
   * Opens a URL-mode page once the user agrees. Without it the user is only
   * shown the URL to open themselves (the right thing when the browser is on
   * another machine than this process).
   */
  openUrl?: OpenUrl | undefined;
}

function questionId(index: number): string {
  return `f${index}`;
}

function optionId(index: number): string {
  return `o${index}`;
}

function bounds(min: number | undefined, max: number | undefined, unit = ''): string | undefined {
  if (min !== undefined && max !== undefined) return `Between ${min} and ${max}${unit}.`;
  if (min !== undefined) return `At least ${min}${unit}.`;
  if (max !== undefined) return `At most ${max}${unit}.`;
  return undefined;
}

function describe(field: ElicitationField): string | undefined {
  const notes: (string | undefined)[] = [field.description];
  if (field.kind === 'string') {
    notes.push(field.format ? `Format: ${field.format}.` : undefined);
    notes.push(bounds(field.minLength, field.maxLength, ' characters'));
  } else if (field.kind === 'number' || field.kind === 'integer') {
    notes.push(field.kind === 'integer' ? 'A whole number.' : 'A number.');
    notes.push(bounds(field.minimum, field.maximum));
  } else if (field.kind === 'multi-enum') {
    notes.push(bounds(field.minItems, field.maxItems, ' choices'));
  }
  const text = notes.filter(Boolean).join(' ');
  return text || undefined;
}

function toQuestion(field: ElicitationField, index: number): UserInputQuestion {
  const base = {
    id: questionId(index),
    // Titles arrive sanitized from the parser; a bare field name does not.
    prompt: field.title ?? sanitizeTerminalText(field.name),
    description: describe(field),
    required: field.required,
  };
  switch (field.kind) {
    case 'string':
      return { ...base, kind: 'text', recommendedText: field.default, placeholder: field.format };
    case 'number':
    case 'integer':
      return {
        ...base,
        kind: 'text',
        recommendedText: field.default === undefined ? undefined : String(field.default),
      };
    case 'boolean':
      return {
        ...base,
        kind: 'single_select',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
        recommendedOptionIds:
          field.default === undefined ? undefined : [field.default ? 'yes' : 'no'],
      };
    case 'enum':
    case 'multi-enum': {
      const defaults = field.kind === 'enum' ? [field.default] : (field.default ?? []);
      const recommended = field.options
        .map((option, i) => (defaults.includes(option.value) ? optionId(i) : undefined))
        .filter((id): id is string => id !== undefined);
      return {
        ...base,
        kind: field.kind === 'enum' ? 'single_select' : 'multi_select',
        options: field.options.map((option, i) => ({ id: optionId(i), label: option.label })),
        recommendedOptionIds: recommended.length > 0 ? recommended : undefined,
      };
    }
  }
}

type FormRequest = ElicitationForm & { server: string };
type PageRequest = UrlElicitation & { server: string };

/** What the user must see before agreeing to open a page (spec: the full URL, the host highlighted). */
function pageWarnings(url: URL): string[] {
  const warnings: string[] = [];
  if (url.hostname.split('.').some((label) => label.startsWith('xn--'))) {
    warnings.push(
      'The address uses international characters (punycode); it may imitate another site.',
    );
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && !local) {
    warnings.push('The page is not served over HTTPS.');
  }
  if (url.username || url.password) warnings.push('The address carries a user name or password.');
  return warnings;
}

function toPageRequest(request: PageRequest, canOpen: boolean): UserInputRequest {
  const url = new URL(request.url);
  const description = [
    request.message,
    `Page: ${request.url}`,
    `Site: ${url.host}`,
    ...pageWarnings(url).map((warning) => `Warning: ${warning}`),
    'What you do on that page goes to the server directly, not through WrongStack.',
  ].join('\n\n');
  return {
    id: `mcp-elicitation-${randomUUID()}`,
    title: `MCP server "${request.server}" asks you to open ${url.host}`,
    description,
    submitLabel: 'Continue',
    tabs: [
      {
        id: 'page',
        label: request.server,
        questions: [
          {
            id: URL_QUESTION,
            prompt: `Open ${url.host}?`,
            kind: 'single_select',
            required: true,
            options: [
              // Named: with `wstack remote` this process runs on another machine.
              ...(canOpen
                ? [{ id: 'open', label: `Open it in the browser on ${hostname()}` }]
                : []),
              { id: 'self', label: 'I will open it myself' },
              { id: 'decline', label: 'Decline' },
            ],
          },
        ],
      },
    ],
  };
}

function toUserInputRequest(
  request: FormRequest,
  problem: string | undefined,
  origin: 'mcp' | 'acp',
): UserInputRequest {
  const questions: UserInputQuestion[] =
    request.fields.length > 0
      ? request.fields.map(toQuestion)
      : [
          {
            id: CONFIRM_QUESTION,
            prompt: 'Go ahead?',
            kind: 'single_select',
            required: true,
            options: [
              { id: 'yes', label: 'Yes' },
              { id: 'no', label: 'No' },
            ],
          },
        ];
  const description = [
    request.message,
    origin === 'acp'
      ? 'Share project information only. Use the agent’s sign-in flow for credentials.'
      : `Only share what you are comfortable sending to "${request.server}".`,
    problem ? `The last answer was not accepted: ${problem}.` : undefined,
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    id: `${origin}-elicitation-${randomUUID()}`,
    title: `${origin === 'acp' ? 'ACP agent' : 'MCP server'} "${request.server}" is asking for input`,
    description,
    submitLabel: `Send to ${request.server}`,
    ...(origin === 'acp' ? { declineLabel: 'Decline' } : {}),
    tabs: [{ id: 'form', label: request.server, questions }],
  };
}

/** The value one answer carries, or undefined when the user left it empty or delegated it. */
function answerValue(field: ElicitationField, answer: UserInputAnswer | undefined): unknown {
  if (!answer || answer.delegated) return undefined;
  switch (field.kind) {
    case 'string': {
      const text = answer.text;
      if (text === undefined) return undefined;
      // A blank box answered for a REQUIRED field is a real answer, not a
      // skipped one: the field's own bounds decide whether '' is acceptable
      // (no `minLength`, or `minLength: 0`, admits it) and only `checkValue`
      // can say so. Folding it into `undefined` invented an omission the user
      // never made, and the validator could then only answer "X is required" —
      // the form was re-asked until it cancelled even when '' was valid, and
      // every re-ask named the wrong reason. An OPTIONAL field the user skipped
      // is a genuine omission, so that path is unchanged.
      if (!text.trim() && !field.required) return undefined;
      return text;
    }
    case 'number':
    case 'integer':
      return answer.text?.trim() || undefined;
    case 'boolean': {
      const picked = answer.selectedOptionIds[0];
      return picked === 'yes' ? true : picked === 'no' ? false : undefined;
    }
    case 'enum':
    case 'multi-enum': {
      const values = answer.selectedOptionIds
        .map((id) => field.options[Number(id.slice(1))]?.value)
        .filter((v): v is string => v !== undefined);
      if (field.kind === 'enum') return values[0];
      if (values.length === 0 && !field.required) return undefined;
      return values;
    }
  }
}

/**
 * Put a server's elicitation in front of the user as a `clarify`-style form on
 * the run that made the call (or `fallback` when the server asks outside a
 * call), and turn the answers back into schema-checked content.
 *
 * No surface to show it on answers `cancel`; the user dismissing the form is an
 * explicit `decline`. An answer the schema rejects is asked again with the
 * reason, a few times, before giving up.
 *
 * A URL-mode request asks for consent to open a page instead. Nothing is
 * fetched or opened before the user agrees, and `accept` then only means they
 * agreed: the page's outcome reaches the server, not this client.
 */
export async function elicitViaUserInput(
  request: MCPElicitationRequest,
  fallback?: ElicitationRequester | undefined,
  options: ElicitViaUserInputOptions = {},
): Promise<MCPElicitationResult> {
  const target = request.requester ?? fallback;
  if (!target) return { action: 'cancel' };
  if (request.mode === 'url') {
    if (request.signal.aborted) return { action: 'cancel' };
    const response = await target.requestUserInput(
      toPageRequest(request, options.openUrl !== undefined),
      request.signal,
    );
    if (!response || request.signal.aborted) return { action: 'cancel' };
    if (response.status !== 'submitted') return { action: 'decline' };
    const choice = response.answers.find((a) => a.questionId === URL_QUESTION)
      ?.selectedOptionIds[0];
    if (choice === 'open' && options.openUrl) {
      options.openUrl(request.url);
      return { action: 'accept', content: {} };
    }
    if (choice === 'self') return { action: 'accept', content: {} };
    return { action: 'decline' };
  }
  return askForm(request, target, 'mcp');
}

/** Reuse the restricted MCP form schema and UI for ACP's session-scoped form mode. */
export async function elicitAcpFormViaUserInput(
  agent: string,
  form: { message: string; requestedSchema: unknown },
  requester: ElicitationRequester,
  signal: AbortSignal,
): Promise<MCPElicitationResult | { invalidParams: string }> {
  const parsed = parseElicitationParams({ ...form, mode: 'form' });
  if (!parsed.ok) return { invalidParams: parsed.error };
  if (parsed.value.mode === 'url') return { invalidParams: 'Expected form elicitation.' };
  if (parsed.value.fields.some(requestsCredential)) {
    return { invalidParams: 'Credentials cannot be requested through an ACP form.' };
  }
  return askForm(
    { ...parsed.value, server: sanitizeTerminalText(agent), signal },
    requester,
    'acp',
  );
}

function requestsCredential(field: ElicitationField): boolean {
  const name = field.name.toLowerCase().replace(/[^a-z]/g, '');
  return (
    /^(?:password|passphrase|apikey|apitoken|token|authtoken|accesstoken|refreshtoken|secret|clientsecret|secretkey|privatekey|sshprivatekey|recoverycodes?|creditcardnumber|cardnumber|cvv|cvc)$/.test(
      name,
    ) ||
    /\b(?:password|passphrase|api[ -]?(?:key|token)|(?:access|refresh) token|client secret|secret key|private key|recovery code|card number|security code)\b/i.test(
      field.title ?? '',
    ) ||
    (field.kind === 'string' && field.format?.toLowerCase() === 'password')
  );
}

async function askForm(
  form: FormRequest & { signal: AbortSignal },
  target: ElicitationRequester,
  origin: 'mcp' | 'acp',
): Promise<MCPElicitationResult> {
  let problem: string | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (form.signal.aborted) return { action: 'cancel' };
    const response = await target.requestUserInput(
      toUserInputRequest(form, problem, origin),
      form.signal,
    );
    if (!response || form.signal.aborted) return { action: 'cancel' };
    if (response.status !== 'submitted') {
      return { action: origin === 'acp' && response.status === 'cancelled' ? 'cancel' : 'decline' };
    }
    const byId = new Map(response.answers.map((answer) => [answer.questionId, answer]));
    if (form.fields.length === 0) {
      return byId.get(CONFIRM_QUESTION)?.selectedOptionIds[0] === 'yes'
        ? { action: 'accept', content: {} }
        : { action: 'decline' };
    }
    const content: Record<string, unknown> = {};
    form.fields.forEach((field, i) => {
      Object.defineProperty(content, field.name, {
        value: answerValue(field, byId.get(questionId(i))),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
    const checked = validateElicitationContent(form.fields, content);
    if (checked.ok) return { action: 'accept', content: checked.value };
    problem = checked.error;
  }
  return { action: 'cancel' };
}
