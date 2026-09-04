import {
  indexInsideCodeFence,
  type ParsedNextStep,
  parseNextSteps,
  stripNextStepsBlock,
} from '@wrongstack/tools/next-steps';

export interface AssistantMessageProjection {
  text: string;
  nextSteps: ParsedNextStep[];
}

const NEXT_STEPS_OPEN_RE = /<next_?steps\b[^>]*>/i;
const NEXT_STEPS_CLOSE_RE = /<\/next_?steps>/i;

/**
 * Normalize persisted/legacy spellings before handing content to WrongStack's
 * canonical browser-safe parser. This keeps parsing rules in one package while
 * preventing XML control tags from leaking into the minimal chat surface.
 */
function normalizeNextStepsTags(text: string): string {
  return text
    .replace(/<next_?steps\b[^>]*>\s*/gi, '<nextsteps>\n')
    .replace(/\s*<\/next_?steps>/gi, '\n</nextsteps>');
}

export function projectAssistantMessage(text: string): AssistantMessageProjection {
  const normalized = normalizeNextStepsTags(text);
  const parsed = parseNextSteps(normalized);

  if (parsed.steps.length > 0) {
    return { text: stripNextStepsBlock(parsed.stripped), nextSteps: parsed.steps };
  }

  const openingTag = NEXT_STEPS_OPEN_RE.exec(text);
  if (!openingTag) return { text, nextSteps: [] };

  // A tag inside a fenced code block is example documentation — during
  // streaming it must neither truncate the message nor count as metadata.
  if (indexInsideCodeFence(text, openingTag.index)) return { text, nextSteps: [] };

  // During streaming, hide machine-readable metadata from the moment its
  // opening tag arrives. A balanced but malformed block is stripped too:
  // suggestions are optional UI metadata, never user-facing answer prose.
  const visibleText = NEXT_STEPS_CLOSE_RE.test(text)
    ? stripNextStepsBlock(text)
    : text.slice(0, openingTag.index).trimEnd();
  return { text: visibleText, nextSteps: [] };
}
