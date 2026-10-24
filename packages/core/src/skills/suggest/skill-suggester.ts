/**
 * Two-pass skill suggestion over the discovered skill roster.
 *
 * The agent chooses a skill from a manifest that gives it one line per skill
 * (`buildProgressiveSkillManifestText`). At a few dozen skills that line is all
 * it has to tell `design-craft` from `design-critique`, or `code-review` from
 * `auto-review` — names that are genuinely close, whose one-liners are closer
 * still. It also has a standing instruction to load a skill when one is
 * relevant, which invites a guess on turns where nothing is.
 *
 * This module puts two cheap judgments in front of that decision, following
 * TypeSafe's published skill-suggestion recipe:
 *
 *   Pass 1 — read the whole roster cheaply. One `Choice` over every skill name
 *     (criteria = the same trigger line the agent sees) ranks them, and three
 *     `Noul` questions ask, three different ways, whether this turn wants a
 *     documented procedure at all. Their mean is the gate.
 *   Pass 2 — read the shortlist properly. A `Choice` over the top N, now with
 *     each skill's full description and the opening of its body, plus one
 *     `Noul` per candidate asking whether it does the specific thing asked for.
 *     Every one of those can come back low, which is how the whole shortlist
 *     gets rejected.
 *
 * Either pass may return nothing, and returning nothing is a normal outcome —
 * roughly a third of turns in TypeSafe's own evaluation. The result is a
 * SUGGESTION: it is rendered as one line the model is explicitly told it may
 * ignore, because a confident wrong suggestion is worse than no suggestion,
 * and the model still has the full manifest and its own judgment.
 *
 * The thresholds here are TypeSafe's published starting points, not tuned
 * against this roster. They are config-exposed for exactly that reason — see
 * `docs/skills-suggestion.md` for how to evaluate them on real turns.
 */

import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import type {
  ChoiceAnswer,
  NoulAnswer,
  TypeSafeClient,
  TypeSafeQuestion,
} from '../../typesafe/index.js';
import { stripFrontmatter } from '../frontmatter.js';
import {
  isSkillHiddenFromPrompt,
  skillPromptExclusionReasons,
  skillUseWhenText,
} from '../prompt-discovery.js';

/** Question id for the ranking Choice in both passes. */
const WHICH = 'which';
const GATE_PREFIX = 'gate::';
const FITS_PREFIX = 'fits::';

export interface SkillSuggesterOptions {
  client: TypeSafeClient;
  loader: SkillLoader;
  /** Optional host catalog for previews; live callers can override per request. */
  availableToolNames?: readonly string[] | undefined;
  /** Candidates carried from pass 1 into pass 2. Default 3. */
  shortlistSize?: number | undefined;
  /** Body characters each shortlisted skill contributes in pass 2. Default 700. */
  excerptChars?: number | undefined;
  /** Mean of the three gate Nouls below which nothing is suggested. Default 0.3. */
  gateThreshold?: number | undefined;
  /** Best per-candidate `fits` Noul below which the shortlist is dropped. Default 0.3. */
  fitsThreshold?: number | undefined;
  /** TypeSafe model id. Defaults to the client's. */
  model?: string | undefined;
}

export interface SkillSuggestion {
  /** A skill name that exists in the roster. */
  name: string;
  /** Mean of the gate Nouls that let this turn through pass 1. */
  gate: number;
  /** The winner's own `fits` Noul from pass 2. */
  fits: number;
}

/** Where a request stopped, for the preview and eval surfaces. */
export type SuggestionStop =
  | 'roster-too-small'
  | 'wide-failed'
  | 'gate'
  | 'rerank-failed'
  | 'fits'
  | 'suggested'
  | 'error';

/**
 * Everything both passes learned about one request.
 *
 * `suggest()` throws all of this away and keeps the verdict, which is right for
 * a live turn and useless for choosing thresholds: a run that returns "nothing"
 * tells you it stopped, not whether it stopped at 0.29 or 0.02. The preview and
 * eval surfaces read the numbers, and an eval can re-threshold an existing
 * trace offline instead of paying for the API again per candidate threshold.
 */
export interface SkillSuggestionTrace {
  /** Mean of the ORIENTED gate Nouls — what `gateThreshold` compares against. */
  gate: number;
  /** Raw per-question gate answers, before `prose_suffices` is flipped. */
  gateValues: Record<string, number>;
  /** Roster ranked by pass-1 probability, best first (capped). */
  ranked: Array<{ name: string; probability: number }>;
  /** The candidates pass 2 actually read. */
  shortlist: string[];
  /** Per-candidate "does this do the thing asked for" probability from pass 2. */
  fits: Record<string, number>;
  /** Pass-2 Choice winner BEFORE `fitsThreshold` is applied. */
  winner: string | undefined;
  /** The verdict `suggest()` would return. */
  suggestion: SkillSuggestion | undefined;
  stop: SuggestionStop;
  /** TypeSafe requests actually issued (0, 1 or 2). */
  requests: number;
  /**
   * Distinct model ids the service reported across this request's passes.
   *
   * `jev-latest` is an ALIAS and the version behind it moves. A threshold
   * chosen on a trace that cannot name the version it was measured against is
   * silent drift: the sweep table stays green while the thing it described
   * changes underneath it. Usually one entry; two would mean the alias moved
   * mid-run, which is itself worth seeing.
   */
  models: string[];
  /** Input tokens billed across this request's passes. Output is free. */
  inputTokens: number;
}

export interface ExplainOptions {
  /** Host catalog, including on-demand tools. Omit for inventory-only previews. */
  availableToolNames?: readonly string[] | undefined;
  /**
   * Run pass 2 even when the gate rejected the turn. Eval mode only: a
   * threshold sweep has to know what pass 2 WOULD have said at a lower gate,
   * and a trace that stopped at the gate cannot answer that. Never set on a
   * live turn — it pays for a request the gate just decided was unnecessary.
   */
  alwaysRerank?: boolean | undefined;
}

export interface SkillSuggester {
  /**
   * At most one skill name for a request, or `undefined` for "nothing here
   * applies". Never throws: a transport failure, an empty roster, or a
   * malformed answer all return `undefined`.
   */
  suggest(request: string, signal?: AbortSignal): Promise<SkillSuggestion | undefined>;
  /**
   * The same decision with its working shown. Never throws either — a failure
   * comes back as a trace with `stop: 'error'`.
   */
  explain(
    request: string,
    signal?: AbortSignal,
    options?: ExplainOptions,
  ): Promise<SkillSuggestionTrace>;
}

/** How many ranked names a trace keeps. More than any shortlist needs. */
const MAX_RANKED_KEPT = 12;

function emptyTrace(stop: SuggestionStop): SkillSuggestionTrace {
  return {
    gate: 0,
    gateValues: {},
    ranked: [],
    shortlist: [],
    fits: {},
    winner: undefined,
    suggestion: undefined,
    stop,
    requests: 0,
    models: [],
    inputTokens: 0,
  };
}

/**
 * Whether the turn wants an action taken against a documented procedure, asked
 * three ways. `proseSuffices` counts the other way round (see INVERTED).
 *
 * These deliberately ask about the SHAPE of the request, not its subject.
 * A subject-matter question ("is this about software?") cannot separate
 * "explain what a monad is" from a turn that needs a skill, because both are
 * about software — and on a coding agent, where the whole roster is technical,
 * subject matter separates almost nothing.
 */
const GATE_QUESTIONS: Readonly<Record<string, string>> = {
  acts_on_user_system:
    "Is the assistant being asked to act on the user's code, files, repository, or " +
    'running system, rather than only to explain or advise?',
  would_follow_documented_procedure:
    'Would a careful expert answering this consult a specific documented procedure, ' +
    'checklist, or set of commands, rather than answering from general understanding?',
  prose_suffices:
    'Could a knowledgeable generalist fully satisfy this request in prose, with no ' +
    "tools, no documentation, and no access to the user's files or repository?",
};

/** Gate questions whose "yes" points AWAY from needing a skill. */
const INVERTED: ReadonlySet<string> = new Set(['prose_suffices']);

const CHOICE_INSTRUCTIONS =
  "Which of these skills, if any, is the right one to load to help with the user's " +
  'latest request?';

const RERANK_INSTRUCTIONS =
  'Exactly one of these skills is the right one to load for the ' +
  "user's latest request. Which one? Read what each actually does, not just its name.";

interface RosterEntry {
  name: string;
  /** The one-line trigger, as the agent's own manifest shows it. */
  trigger: string;
  /** Full frontmatter description. */
  description: string;
}

export function createSkillSuggester(opts: SkillSuggesterOptions): SkillSuggester {
  const shortlistSize = Math.max(1, opts.shortlistSize ?? 3);
  const excerptChars = Math.max(0, opts.excerptChars ?? 700);
  const gateThreshold = opts.gateThreshold ?? 0.3;
  const fitsThreshold = opts.fitsThreshold ?? 0.3;

  const explain: SkillSuggester['explain'] = async (request, signal, options) => {
    const trimmed = request.trim();
    if (!trimmed) return emptyTrace('roster-too-small');
    try {
      const roster = await loadRoster(
        opts.loader,
        options?.availableToolNames ?? opts.availableToolNames,
      );
      // One candidate is not a choice — the agent's manifest already says
      // this skill exists, and a forced "pick one of one" would suggest it on
      // every turn that clears the gate.
      if (roster.length < 2) return emptyTrace('roster-too-small');

      const wide = await rankWide(opts, roster, trimmed, signal);
      if (!wide) return { ...emptyTrace('wide-failed'), requests: 1 };

      const trace: SkillSuggestionTrace = {
        ...emptyTrace('gate'),
        gate: wide.gate,
        gateValues: wide.values,
        ranked: wide.ranked.slice(0, MAX_RANKED_KEPT),
        requests: 1,
        models: wide.model ? [wide.model] : [],
        inputTokens: wide.inputTokens,
      };
      const gatePassed = wide.gate >= gateThreshold;
      if (!gatePassed && !options?.alwaysRerank) return trace;

      const shortlist = wide.ranked.slice(0, shortlistSize).map((entry) => entry.name);
      if (shortlist.length === 0) return trace;
      trace.shortlist = shortlist;

      const reranked = await rerank(opts, roster, shortlist, trimmed, excerptChars, signal);
      trace.requests = 2;
      if (!reranked) return { ...trace, stop: 'rerank-failed' };
      // Pass 2 is billed whether or not it changes the verdict, and the alias
      // can in principle resolve differently between the two calls.
      if (reranked.model && !trace.models.includes(reranked.model)) {
        trace.models.push(reranked.model);
      }
      trace.inputTokens += reranked.inputTokens;
      trace.fits = reranked.fits;
      trace.winner = reranked.winner;

      // With `alwaysRerank` the gate verdict still stands: the trace carries
      // pass 2's numbers so a sweep can re-decide, but this trace's OWN
      // verdict must be the one the live path would have produced.
      if (!gatePassed) return trace;

      const best = Math.max(...Object.values(reranked.fits), 0);
      if (best < fitsThreshold) return { ...trace, stop: 'fits' };

      return {
        ...trace,
        stop: 'suggested',
        suggestion: {
          name: reranked.winner,
          gate: wide.gate,
          fits: reranked.fits[reranked.winner]!,
        },
      };
    } catch {
      // A suggestion is an optimization. Nothing here is allowed to fail a
      // turn, so every failure mode collapses to "no suggestion".
      return emptyTrace('error');
    }
  };

  return {
    explain,
    async suggest(request, signal) {
      return (await explain(request, signal)).suggestion;
    },
  };
}

/**
 * Re-decide an existing trace at different thresholds, without calling the API.
 *
 * This is what makes a threshold sweep affordable: the expensive part is the
 * two requests, and their answers do not change when you move a threshold. It
 * is only honest for traces collected with `alwaysRerank`, because a trace that
 * stopped at the gate has no pass-2 answers to re-decide with — that case
 * returns `undefined` rather than guessing, so a sweep built on the wrong
 * traces reports nothing instead of something plausible and wrong.
 */
export function redecide(
  trace: SkillSuggestionTrace,
  gateThreshold: number,
  fitsThreshold: number,
): string | undefined {
  if (trace.gate < gateThreshold) return undefined;
  if (!trace.winner || !Object.hasOwn(trace.fits, trace.winner)) return undefined;
  const best = Math.max(...Object.values(trace.fits), 0);
  if (best < fitsThreshold) return undefined;
  return trace.winner;
}

/**
 * The skills the agent can actually see in its manifest, in loader priority
 * order. `roster`/`external` audiences are withheld from that manifest, so
 * suggesting one would point at an entry the model cannot read.
 */
async function loadRoster(
  loader: SkillLoader,
  availableToolNames?: readonly string[],
): Promise<RosterEntry[]> {
  const [entries, manifests] = await Promise.all([loader.listEntries(), loader.list()]);
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const roster: RosterEntry[] = [];
  for (const entry of entries) {
    if (isSkillHiddenFromPrompt(entry.audience)) continue;
    const manifest = byName.get(entry.name);
    if (manifest && skillPromptExclusionReasons(manifest, availableToolNames).length > 0) continue;
    const trigger = skillUseWhenText(manifest?.description, manifest?.trigger, entry.trigger);
    if (!trigger) continue;
    roster.push({
      name: entry.name,
      trigger,
      description: (byName.get(entry.name)?.description ?? trigger).replace(/\s+/g, ' ').trim(),
    });
  }
  return roster;
}

interface WideResult {
  /** Roster names with their probabilities, best first. */
  ranked: Array<{ name: string; probability: number }>;
  /** Mean of the oriented gate Nouls, 0..1. */
  gate: number;
  /** Raw per-question gate answers, before orientation. */
  values: Record<string, number>;
  /** What the service said answered, and what it charged for.  */
  model: string | undefined;
  inputTokens: number;
}

/** Pass 1: one Choice over the whole roster plus the three gate Nouls. */
async function rankWide(
  opts: SkillSuggesterOptions,
  roster: RosterEntry[],
  request: string,
  signal: AbortSignal | undefined,
): Promise<WideResult | undefined> {
  const criteria: Record<string, string | null> = {};
  for (const entry of roster) criteria[entry.name] = entry.trigger;

  const questions: Record<string, TypeSafeQuestion> = {
    [WHICH]: { type: 'choice', instructions: CHOICE_INSTRUCTIONS, criteria },
  };
  for (const [key, instructions] of Object.entries(GATE_QUESTIONS)) {
    questions[`${GATE_PREFIX}${key}`] = { type: 'noul', instructions };
  }

  // All of these are independent judgments over the same state, so they go in
  // ONE request: they cannot see one another's answers anyway, and batching
  // them is the difference between one round trip and four.
  const result = await opts.client.systemOne(
    { activityFeature: 'skillSuggestion', state: { request }, questions, model: opts.model },
    signal,
  );

  const which = choiceAnswer(result.answers[WHICH]);
  if (!which) return undefined;

  const oriented: number[] = [];
  const values: Record<string, number> = {};
  for (const key of Object.keys(GATE_QUESTIONS)) {
    const answer = noulAnswer(result.answers[`${GATE_PREFIX}${key}`]);
    if (answer === undefined) return undefined;
    values[key] = answer;
    oriented.push(INVERTED.has(key) ? 1 - answer : answer);
  }
  // All three calibrated judgments must survive. Averaging only the returned
  // subset changes the gate when an answer is missing or malformed.

  const known = new Set(roster.map((entry) => entry.name));
  const ranked = Object.entries(which.probabilities)
    // The distribution is echoed back from criteria we sent, but it reaches us
    // over the network from a third party and feeds a name we will print into
    // the system prompt. Only names we put in survive.
    .filter(([name]) => known.has(name))
    .sort((a, b) => b[1] - a[1])
    .map(([name, probability]) => ({ name, probability }));
  if (ranked.length === 0) return undefined;

  return {
    ranked,
    values,
    gate: oriented.reduce((sum, v) => sum + v, 0) / oriented.length,
    model: result.model,
    inputTokens: result.usage.inputTokens,
  };
}

interface RerankResult {
  winner: string;
  /** Per-candidate "does this skill do the thing asked for" probability. */
  fits: Record<string, number>;
  model: string | undefined;
  inputTokens: number;
}

/** Pass 2: the same question over the shortlist, with real evidence this time. */
async function rerank(
  opts: SkillSuggesterOptions,
  roster: RosterEntry[],
  shortlist: string[],
  request: string,
  excerptChars: number,
  signal: AbortSignal | undefined,
): Promise<RerankResult | undefined> {
  const byName = new Map(roster.map((entry) => [entry.name, entry]));
  const criteria: Record<string, string | null> = {};
  const questions: Record<string, TypeSafeQuestion> = {};

  for (const name of shortlist) {
    const entry = byName.get(name);
    if (!entry) continue;
    const excerpt = excerptChars > 0 ? await readExcerpt(opts.loader, name, excerptChars) : '';
    criteria[name] = excerpt ? `${entry.description} — ${excerpt}` : entry.description;
    questions[`${FITS_PREFIX}${name}`] = {
      type: 'noul',
      instructions:
        `Does the skill '${name}' do the specific thing the user's request asks for? ` +
        `It is described as: ${entry.description}`,
    };
  }
  const candidates = Object.keys(criteria);
  if (candidates.length === 0) return undefined;

  questions[WHICH] = { type: 'choice', instructions: RERANK_INSTRUCTIONS, criteria };

  const result = await opts.client.systemOne(
    { activityFeature: 'skillSuggestion', state: { request }, questions, model: opts.model },
    signal,
  );

  const which = choiceAnswer(result.answers[WHICH]);
  // The Choice settles WHICH skill; the `fits` Nouls settle WHETHER to say
  // anything at all. They answer different questions and are allowed to
  // disagree, so a winner is only taken from the Choice.
  if (!which || !candidates.includes(which.choice)) return undefined;

  const fits: Record<string, number> = {};
  for (const name of candidates) {
    const answer = noulAnswer(result.answers[`${FITS_PREFIX}${name}`]);
    if (answer !== undefined) fits[name] = answer;
  }
  if (!Object.hasOwn(fits, which.choice)) return undefined;

  return {
    winner: which.choice,
    fits,
    model: result.model,
    inputTokens: result.usage.inputTokens,
  };
}

async function readExcerpt(loader: SkillLoader, name: string, chars: number): Promise<string> {
  try {
    const body = stripFrontmatter(await loader.readBody(name)).trim();
    return body.slice(0, chars).replace(/\s+/g, ' ').trim();
  } catch {
    // A skill whose body will not read still has its description, which is
    // what the criteria fall back to.
    return '';
  }
}

function choiceAnswer(answer: unknown): ChoiceAnswer | undefined {
  return isAnswerOfType(answer, 'choice') ? (answer as ChoiceAnswer) : undefined;
}

function noulAnswer(answer: unknown): number | undefined {
  return isAnswerOfType(answer, 'noul') ? (answer as NoulAnswer).noul : undefined;
}

function isAnswerOfType(answer: unknown, type: 'choice' | 'noul'): boolean {
  return (
    typeof answer === 'object' && answer !== null && (answer as { type?: string }).type === type
  );
}
