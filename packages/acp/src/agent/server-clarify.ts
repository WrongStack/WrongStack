import type {
  UserInputAnswer,
  UserInputQuestion,
  UserInputRequest,
  UserInputResponse,
} from '@wrongstack/contracts/types';
import type { RunTurnApi } from './protocol-contract.js';
import { isRecord } from './server-agent-turn-content.js';

export function clarifyInChat(request: UserInputRequest): string {
  return [
    request.title,
    request.description,
    ...request.tabs.flatMap((tab) => [
      tab.label,
      tab.description,
      ...tab.questions.map((question) =>
        [
          question.prompt,
          question.description,
          ...(question.options ?? []).map(
            (option) => `- ${option.label}${option.description ? ` — ${option.description}` : ''}`,
          ),
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ]),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function fieldSchema(question: UserInputQuestion) {
  const info = { title: question.prompt, description: question.description };
  const options = question.options?.map(({ id, label }) => ({ const: id, title: label }));
  if (!options?.length || question.kind === 'text') return { ...info, type: 'string' };
  if (question.kind === 'multi_select') {
    return { ...info, type: 'array', items: { anyOf: options } };
  }
  return { ...info, type: 'string', oneOf: options };
}

export async function clarifyViaAcp(
  request: UserInputRequest,
  requestForm: NonNullable<RunTurnApi['requestForm']>,
  signal: AbortSignal,
): Promise<UserInputResponse | undefined> {
  const fields = request.tabs
    .flatMap((tab) => tab.questions)
    .map((question, index) => ({
      key: `q${index + 1}`,
      writeIn:
        question.kind !== 'text' && question.allowCustomResponse
          ? `q${index + 1}_other`
          : undefined,
      question,
    }));
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const { key, writeIn, question } of fields) {
    properties[key] = fieldSchema(question);
    if (writeIn)
      properties[writeIn] = { type: 'string', title: `Other answer for ${question.prompt}` };
    else if (question.required) required.push(key);
  }
  const response = await requestForm(
    {
      message: clarifyInChat(request),
      requestedSchema: { type: 'object', properties, required },
    },
    signal,
  );
  const cancelled: UserInputResponse = { requestId: request.id, status: 'cancelled', answers: [] };
  if (
    signal.aborted ||
    (isRecord(response) && (response.action === 'decline' || response.action === 'cancel'))
  ) {
    return cancelled;
  }
  if (!isRecord(response) || response.action !== 'accept' || !isRecord(response.content))
    return undefined;
  const answers: UserInputAnswer[] = [];
  for (const { key, writeIn, question } of fields) {
    const value = Object.hasOwn(response.content, key) ? response.content[key] : undefined;
    const other =
      writeIn && Object.hasOwn(response.content, writeIn) ? response.content[writeIn] : undefined;
    const text = question.kind === 'text' ? value : other;
    if (text !== undefined && typeof text !== 'string') return undefined;
    const typedText = typeof text === 'string' ? text.trim() : undefined;
    const selected: unknown[] = [];
    if (value !== undefined && question.kind !== 'text') {
      if (question.kind === 'multi_select' && Array.isArray(value)) selected.push(...value);
      else if (question.kind === 'single_select' && typeof value === 'string') selected.push(value);
      else return undefined;
    }
    const validIds = new Set(question.options?.map((option) => option.id));
    const selectedOptionIds = selected.filter(
      (id): id is string => typeof id === 'string' && validIds.has(id),
    );
    if (
      selectedOptionIds.length !== selected.length ||
      (question.required && !typedText && !selected.length)
    ) {
      return undefined;
    }
    answers.push({
      questionId: question.id,
      selectedOptionIds: [...new Set(selectedOptionIds)],
      text: typedText,
      usedRecommendation: false,
    });
  }
  return { requestId: request.id, status: 'submitted', answers };
}
