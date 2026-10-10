/**
 * Code Assist prompt construction.
 *
 * Kept apart from `code-assist-routes.ts` so the prompt text (which is really
 * the product spec for what each button means) is reviewable on its own and
 * unit-testable without a WebSocket.
 *
 * Two invariants this file exists to hold:
 *
 *  1. Every run is told to ground itself in the CODEBASE INDEX and to name the
 *     index tools it used. Without that instruction the model answers from the
 *     handful of lines we name and invents a plausible-sounding system. The
 *     requirement is "explain what is happening AND what the index triggered
 *     and why" - the second half is only answerable if the agent is required
 *     to report its tool calls.
 *
 *  2. A read-only run is told, in the same breath, that it must NOT edit and
 *     must RECOMMEND instead. Otherwise a model that spot-fixes something
 *     helpful breaks the promise the panel makes ("applied edits" is only ever
 *     reported for mutating runs).
 *
 * Style note: the prompt bodies below are built from single-quoted strings and
 * concatenation rather than template literals. They are full of literal
 * backticks (the file paths the agent is expected to cite), and a backtick
 * inside a template literal needs escaping that is easy to get wrong in a file
 * this size.
 */
import type { CodeAssistPreset, CodeAssistRunRequest } from '@wrongstack/webui-protocol';

interface PromptContext {
  projectRoot: string;
  allowEdits: boolean;
}

/** A short, human-readable description of the focus of the run. */
function symbolHint(request: CodeAssistRunRequest): string {
  if (request.symbol) return '`' + request.symbol + '`';
  if (request.line !== undefined) return 'the code at line ' + String(request.line);
  return 'this file';
}

function inFile(request: CodeAssistRunRequest): string {
  return ' in `' + request.filePath + '`';
}

/** The shared preamble: role, grounding rule, and the reporting contract. */
function preamble(ctx: PromptContext): string {
  return [
    'You are the Code Assist reviewer for this project - a focused, read-mostly',
    'analyst invoked from a small side panel, not a chat session. You have one job:',
    'assess the code the user is looking at right now.',
    '',
    'GROUND YOUR ANSWER IN THE CODEBASE INDEX. This project maintains a symbol',
    'index; use the codebase index tools available to you (context retrieval,',
    'impact analysis, incoming-calls, outgoing-calls, search). Do NOT answer from',
    'the target file alone. Before concluding anything, find the symbol real',
    'callers and callees, and check for the tests that already cover it.',
    '',
    'REPORT YOUR TOOL USE. Your answer must state which index lookups you ran and',
    'what each one established. A claim like "nothing else calls this" is only',
    'acceptable if you actually checked callers. If an index lookup returned',
    'nothing, say so explicitly rather than asserting the negative from memory.',
    '',
    'PROJECT ROOT: ' + ctx.projectRoot,
  ].join('\n');
}

/** Per-preset instruction block. */
function presetInstruction(preset: CodeAssistPreset, request: CodeAssistRunRequest): string {
  const focus = symbolHint(request);
  const where = inFile(request);

  switch (preset) {
    case 'overview':
      return [
        'TASK - OVERVIEW',
        'Give an overall assessment of the code in `' + request.filePath + '` and the',
        'system it sits in. Cover:',
        '  1. What this module/file is responsible for.',
        '  2. The key exported symbols and how they relate to each other.',
        '  3. Which other parts of the codebase depend on it (use impact analysis).',
        '  4. A general assessment INCLUDING ITS TESTS: which test files cover it,',
        '     what they actually assert, and where the coverage is thin.',
        '  5. Your overall judgement: is this code in good shape, and why.',
      ].join('\n');

    case 'explain':
      return [
        'TASK - EXPLAIN',
        'Explain what is happening in ' + focus + where + '. Walk through it step by',
        'step: the inputs, the control flow, the outputs, and the side effects. Then',
        'explain how it fits the surrounding code - who calls it, what it calls, and',
        'why it is shaped this way.',
        '',
        'Where the codebase index changed your understanding, say so: name the',
        'lookup and what it revealed.',
      ].join('\n');

    case 'quality':
      return [
        'TASK - CODE QUALITY',
        'Assess the code quality of ' + focus + where + '. Judge: readability,',
        'naming, error handling, duplication, dead or unreachable logic,',
        'over-engineering, and consistency with the conventions you can observe',
        'elsewhere in this codebase (check neighbours via the index rather than',
        'assuming a house style).',
        '',
        'Include a TESTS assessment: are the important behaviours actually',
        'asserted, and what is untested?',
        '',
        'Rank your findings by real impact. Do not pad the list with style nits.',
      ].join('\n');

    case 'bugs':
      return [
        'TASK - BUG HUNT',
        'Hunt for real defects in ' + focus + where + '. Look for: unhandled error',
        'paths, incorrect boundary/edge handling, race or ordering assumptions,',
        'resource leaks, incorrect error propagation, broken invariants, unsafe',
        'casts, and mismatches between what the code claims and what it does.',
        '',
        'For EVERY candidate bug you must:',
        '  - trace it with the index to a real call site or input that triggers it,',
        '  - state the concrete failure (what input, what happens, what breaks),',
        '  - say whether it is CONFIRMED or SPECULATIVE, and why.',
        '',
        'A speculative finding labelled as such is useful. A speculative finding',
        'presented as a confirmed crash is not. Do not report findings you did not',
        'verify against the surrounding code.',
      ].join('\n');

    case 'security':
      return [
        'TASK - SECURITY REVIEW',
        'Review ' + focus + where + ' for security defects: injection',
        '(SQL/command/template), path traversal, unsafe deserialization, SSRF,',
        'prototype pollution, ReDoS, missing authz checks, and secrets in source',
        'or logs.',
        '',
        'Trace each data flow to a sink before reporting it. Report the concrete',
        'attack path, not the category name. State clearly if a sink is not',
        'reachable from untrusted input.',
      ].join('\n');

    case 'tests':
      return [
        'TASK - TEST ASSESSMENT',
        'Assess the test coverage of `' + request.filePath + '`. Find the existing',
        'tests via the index (they are often not co-located). Report: which test',
        'files exercise this code, what behaviours they pin down, which branches and',
        'error paths are UNCOVERED, and which tests look like they assert',
        'implementation details rather than behaviour.',
        '',
        'Then propose the specific tests that should be added, naming the exact',
        'cases. If the file has no tests at all, say so first.',
      ].join('\n');

    case 'impact':
      return [
        'TASK - IMPACT ANALYSIS',
        'Determine the blast radius of changing ' + focus + where + '. Use the index',
        'to enumerate: direct callers, transitive callers, the tests that would',
        'break, the modules that import it, and any public API surface it exposes.',
        'Then state what a safe change sequence looks like and which of those call',
        'sites are risky.',
      ].join('\n');

    case 'fix':
      return [
        'TASK - FIX',
        'Find and fix the single most valuable improvement in ' + focus + where + '.',
        '',
        'Procedure:',
        '  1. Assess first. Use the index to understand the symbol and its callers.',
        '  2. Identify the highest-value issue - a real defect, a correctness or',
        '     security risk, or a maintainability problem with a clear payoff.',
        '     Prefer fixing a real defect over a cosmetic change.',
        '  3. IMPLEMENT the fix with the edit/write tools.',
        "  4. Verify it: run the project's typecheck and the relevant tests, and",
        '     report exactly what you ran and what it returned.',
        '',
        'CONSTRAINT - do not fundamentally break the system. Keep the change',
        'minimal and surgical. Preserve the existing public behaviour unless the',
        'defect IS the behaviour. Do not refactor surrounding code, do not change',
        'signatures other code depends on unless the index proves no caller relies',
        'on them, and do not reformat unrelated code. If a safe fix is not possible,',
        'STOP and report what you found instead of forcing a change.',
        '',
        'Finish by stating: the issue, the change you made, which files you',
        'touched, and the verification output.',
      ].join('\n');

    case 'custom':
      return [
        'TASK - QUESTION',
        'The user is looking at ' + focus + where + ' and asked:',
        '',
        request.question ?? '(no question supplied)',
        '',
        'Answer it using the codebase index. Show the surrounding code that makes',
        'the answer true, and name the index lookups you used to reach it.',
      ].join('\n');
  }
}

/** Closing contract: what "done" looks like, and the read-only vs mutating rule. */
function closingInstruction(ctx: PromptContext): string {
  if (ctx.allowEdits) {
    return [
      '',
      'You MAY edit files for this run. Keep every change minimal and reversible,',
      'and report exactly which files you modified and what verification you ran.',
    ].join('\n');
  }
  return [
    '',
    'This is a READ-ONLY run. Do not edit, write, or otherwise modify any file,',
    'and do not run commands that change the working tree. If you find a problem,',
    'RECOMMEND the change precisely - name the file, the function, and the exact',
    'edit - rather than applying it. If the user wants it applied, they can run the',
    'Fix action, which is a separate, explicitly-authorised operation.',
  ].join('\n');
}

export function buildCodeAssistPrompt(request: CodeAssistRunRequest, ctx: PromptContext): string {
  return [
    preamble(ctx),
    '',
    'TARGET FILE: ' + request.filePath,
    ...(request.symbol ? ['TARGET SYMBOL: ' + request.symbol] : []),
    ...(request.line !== undefined ? ['TARGET LINE: ' + String(request.line)] : []),
    '',
    presetInstruction(request.preset, request),
    '',
    'OUTPUT FORMAT',
    'Use Markdown. Lead with a two-or-three sentence verdict, then the details.',
    'Cite evidence as path:line. Keep it tight - this renders in a narrow side',
    'panel, so favour structure (short sections, lists) over long prose.',
    closingInstruction(ctx),
  ].join('\n');
}
