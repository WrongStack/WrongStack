import type {
  CouncilOption,
  CouncilPersona,
  CouncilQuestion,
  CouncilVoteResult,
  ResolvedCouncilSeat,
} from '../types/council.js';
import {
  readBundledInstructionText,
  renderInstructionTemplate,
} from '../utils/instruction-file.js';

export const COUNCIL_VOTER_PROMPT_PATH = 'llm/council-voter.md';
export const COUNCIL_JUDGE_PROMPT_PATH = 'llm/council-judge.md';

/** Build the trusted system instruction for one independent seat. */
export function buildCouncilVoterSystemPrompt(persona: CouncilPersona): string {
  const template = requiredInstruction(COUNCIL_VOTER_PROMPT_PATH);
  return renderInstructionTemplate(template, {
    personaInstruction: persona.instruction,
  });
}

/** Build the trusted system instruction for the final judge. */
export function buildCouncilJudgeSystemPrompt(): string {
  return requiredInstruction(COUNCIL_JUDGE_PROMPT_PATH);
}

/** Render the original question as delimited, untrusted user data. */
export function buildCouncilQuestionPrompt(
  question: CouncilQuestion,
  opts: { refusalOptionId?: string | undefined } = {},
): string {
  const text = question.question.trim();
  if (!text) throw new Error('buildCouncilQuestionPrompt: question must not be empty.');
  const options = normalizeOptions(question.options);
  return [
    '<council-question>',
    `Question: ${text}`,
    question.context?.trim() ? `Context:\n${question.context.trim()}` : '',
    options.length > 0 ? `Options (JSON):\n${JSON.stringify(options)}` : 'Options: none',
    opts.refusalOptionId
      ? `Refusal option id: ${opts.refusalOptionId}`
      : 'Refusal option id: not supplied',
    '</council-question>',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Build the voter user prompt. Persona instructions stay in the system prompt. */
export function buildCouncilVoterUserPrompt(
  question: CouncilQuestion,
  seat: ResolvedCouncilSeat,
  opts: { refusalOptionId?: string | undefined } = {},
): string {
  return [
    buildCouncilQuestionPrompt(question, opts),
    '<seat-metadata>',
    `Seat id: ${seat.id}`,
    `Seat label: ${seat.label}`,
    `Persona id: ${seat.persona}`,
    `Vote weight: ${seat.weight}`,
    seat.veto ? 'Veto power: yes — your refusal unilaterally denies the proposal.' : '',
    '</seat-metadata>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Build the judge user prompt with seat outputs serialized as untrusted JSON. */
export function buildCouncilJudgeUserPrompt(
  question: CouncilQuestion,
  votes: readonly CouncilVoteResult[],
  opts: {
    reason?: string | undefined;
    refusalOptionId?: string | undefined;
  } = {},
): string {
  const ballots = votes.map((vote) => ({
    seatId: vote.seatId,
    persona: vote.persona,
    status: vote.status,
    ...(vote.optionId ? { optionId: vote.optionId } : {}),
    ...(vote.stance ? { stance: vote.stance } : {}),
    ...(vote.rationale ? { rationale: vote.rationale } : {}),
  }));
  return [
    buildCouncilQuestionPrompt(question, { refusalOptionId: opts.refusalOptionId }),
    '<council-ballots>',
    opts.reason?.trim() ? `Reason judging is required: ${opts.reason.trim()}` : '',
    JSON.stringify(ballots),
    '</council-ballots>',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Validate a Council option list; returns human-readable problems (empty
 * array = valid). Single source of the id/label/duplicate rules shared by the
 * `council` tool validator (fixable errors returned to the caller) and the
 * prompt builder (which throws with every problem joined).
 *
 * Note: empty ids are added to the `seen` set, so two empty-id options also
 * report `Duplicate option id ""` next to the empty-id error — harmless noise
 * that preserves the historical tool-validator behavior exactly.
 */
export function validateCouncilOptions(options: readonly CouncilOption[] | undefined): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const option of options ?? []) {
    const id = option.id.trim();
    if (!id) errors.push('Every option must have a non-empty `id`.');
    if (!option.label.trim()) errors.push(`Option "${id || '<empty>'}" must have a label.`);
    if (seen.has(id)) errors.push(`Duplicate option id "${id}".`);
    seen.add(id);
  }
  return errors;
}

function normalizeOptions(options: readonly CouncilOption[] | undefined): CouncilOption[] {
  if (!options) return [];
  const errors = validateCouncilOptions(options);
  if (errors.length > 0) {
    throw new Error(`buildCouncilQuestionPrompt: ${errors.join('; ')}`);
  }
  return options.map((option) => ({
    id: option.id.trim(),
    label: option.label.trim(),
    ...(option.consequence?.trim() ? { consequence: option.consequence.trim() } : {}),
  }));
}

function requiredInstruction(path: string): string {
  const text = readBundledInstructionText(path);
  if (!text) throw new Error(`Council instruction file is unavailable: ${path}`);
  return text;
}
