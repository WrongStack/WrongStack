import type { Middleware } from '@wrongstack/contracts/kernel/pipeline';
import { isVolatileSystemBlock, markVolatileSystemBlock } from '@wrongstack/contracts/types/blocks';
import type { Config } from '@wrongstack/contracts/types/config/root';
import { authoredText } from '@wrongstack/contracts/types/live-context';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { Request } from '@wrongstack/contracts/types/provider';
import type { SkillLoader, SkillManifest } from '@wrongstack/contracts/types/skill';
import { extractSkillMentions } from '../mentions.js';
import { skillPromptExclusionReasons } from '../prompt-discovery.js';
import { LOCAL_SKILL_RULES } from './local-rules.js';

const MAX_QUERY_CHARS = 16_384;
const ACTION =
  /\b(?:build|create|implement|apply|add|fix|repair|debug|diagnose|refactor|migrate|upgrade|update|deploy|configure|render|animate|generate|write|commit|define|specify|redesign|collect|harden|tune|externalize|triage|design|review|audit|test|verify|prove|optimize|prepare|set up|choose|plan|find|measure|restore|port|bughunt|sechunt|secproof|racehunt|leakhunt|flakehunt|debloat|deadcode|excise|uipolish|a11yhunt|uihunt|typehunt|boundaryhunt|testgap|covhunt|invarianthunt|kur\w*|yap\w*|ekle\w*|duzelt\w*|gelistir\w*|olustur\w*|uret\w*|hazirla\w*|tasarla\w*|guclendir\w*|teshis\w*|incele\w*|dogrula\w*|kanitla\w*|guncelle\w*|tasi\w*|yaz\w*|arastir\w*|bul\w*|olc\w*|sec\w*|canlandir\w*|uygula\w*|fails|failing|crashes|broken|calismiyor|hata veriyor|takiliyor)\b/;
const PROSE =
  /\b(?:birthday|haiku|poem|joke|greeting|weather|pizza|dogum gunu|siir|saka|gunaydin|hava durumu)\b/;
const SOFTWARE =
  /\b(?:app|application|website|code|repository|repo|component|endpoint|api|database|service|deployment|workflow|ui|video|uygulama|kod|arayuz|bilesen|veritabani|servis|sunucu|gorev|skill)\b/;

export interface LocalSkillRecommendation {
  names: string[];
  reason: 'matched' | 'multi-domain' | 'ambiguous' | 'routing';
}

export function normalizeSkillRequest(text: string): string {
  return text
    .slice(0, MAX_QUERY_CHARS)
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/\bc#/g, 'csharp')
    .replace(/(^|\W)\.net\b/g, '$1 dotnet')
    .replace(
      /\b(next\.?js|next|react|vue|nuxt|angular|node\.?js|expo|remotion|manim)(?=\d)/g,
      '$1 ',
    );
}

/** Local lexical routing, not a semantic model or calibrated confidence score. */
export function recommendLocalSkills(
  text: string,
  catalog: readonly SkillManifest[],
  toolNames?: readonly string[],
): LocalSkillRecommendation | undefined {
  if (extractSkillMentions(text).length) return undefined;
  const query = normalizeSkillRequest(text);
  if (!ACTION.test(query) || PROSE.test(query)) return undefined;
  if (toolNames !== undefined && !toolNames.includes('skill')) return undefined;
  const eligible = new Set(
    catalog
      .filter(
        (skill) =>
          skill.source === 'bundled' && skillPromptExclusionReasons(skill, toolNames).length === 0,
      )
      .map((skill) => skill.name),
  );
  const hits = LOCAL_SKILL_RULES.filter((rule) => eligible.has(rule.name) && rule.match.test(query))
    .map((rule) =>
      rule.name === 'media-production' && /\b(?:remotion|ffmpeg)\b/.test(query)
        ? { ...rule, priority: 100 }
        : rule,
    )
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  const primary = hits[0];
  if (!primary)
    return SOFTWARE.test(query) && eligible.has('skill-router')
      ? { names: ['skill-router'], reason: 'routing' }
      : undefined;
  const domains = new Set(
    hits
      .filter(
        (rule) =>
          rule.priority >= 90 && !['quality', 'workflow', 'integration'].includes(rule.domain),
      )
      .map((rule) => rule.domain),
  );
  const multi = domains.size > 1 && primary.priority < 110;
  const ambiguous = hits[1]?.priority === primary.priority && primary.priority >= 90;
  if ((multi || ambiguous) && eligible.has('skill-router')) {
    const specialists = hits.filter((rule) => rule.name !== 'skill-router').slice(0, 3);
    return {
      names: ['skill-router', ...specialists.map((rule) => rule.name)],
      reason: multi ? 'multi-domain' : 'ambiguous',
    };
  }
  return { names: [primary.name], reason: 'matched' };
}

export interface LocalSkillSuggestionDeps {
  config: Config;
  skillLoader?: SkillLoader | undefined;
  getAvailableToolNames?: (() => readonly string[]) | undefined;
  logger?: Logger | undefined;
}

/** Default-on local advice. No search call, account, network request or activation event. */
export function createLocalSkillSuggestionSetup(
  deps: LocalSkillSuggestionDeps,
): Middleware<Request> | undefined {
  const loader = deps.skillLoader;
  if (
    !loader ||
    deps.config.features?.skills === false ||
    deps.config.skills?.localSuggest === false
  )
    return undefined;
  return {
    name: 'skills.suggest.local',
    owner: 'skills',
    async handler(request, next) {
      const system = request.system?.filter(
        (block) =>
          !(
            isVolatileSystemBlock(block) && block.text.startsWith('<local_skill_recommendation>\n')
          ),
      );
      const base = system?.length !== request.system?.length ? { ...request, system } : request;
      let outgoing = base;
      try {
        const result = await prepareLocalSuggestion(base, deps, loader);
        if (result) {
          outgoing = {
            ...base,
            system: [
              ...(base.system ?? []),
              markVolatileSystemBlock({
                type: 'text',
                text: result.content,
                cache_control: { type: 'ephemeral' },
              }),
            ],
          };
          deps.logger?.debug(
            `local skill suggestion: ${result.names.join(', ')} (${result.reason})`,
          );
        }
      } catch {
        /* Advisor failures must not fail the turn. */
      }
      // Provider/downstream errors must propagate exactly once, outside the advisory catch.
      return next(outgoing);
    },
  };
}

/**
 * Advice only — the skill body is not inlined. This block is volatile: on
 * breakpoint wires it rides the uncached tail of EVERY request in the turn
 * (a 12k-char body was ~3k uncached tokens per tool-loop iteration), and on
 * automatic-prefix wires it stays in the replayed prefix for the rest of the
 * session even after the recommendation stops matching. A lexical guess must
 * not cost that. When the model takes the advice, the `skill` tool loads the
 * body once into the durable history, where it is cached like any tool result.
 */
async function prepareLocalSuggestion(
  request: Request,
  deps: LocalSkillSuggestionDeps,
  loader: SkillLoader,
) {
  // A completed opt-in remote judgment or explicit selection takes precedence.
  if (request.system?.some((block) => block.text.startsWith('<skill_relevance>\n')))
    return undefined;
  const text = latestUserText(request);
  const tools = deps.getAvailableToolNames?.() ?? request.tools?.map((tool) => tool.name);
  if (tools === undefined) return undefined;
  const catalog = await loader.list();
  const currentTools = deps.getAvailableToolNames?.() ?? tools;
  if (latestUserText(request) !== text) return undefined;
  const recommendation = recommendLocalSkills(text, catalog, currentTools);
  if (!recommendation) return undefined;
  const [primary] = recommendation.names;
  const content = [
    '<local_skill_recommendation>',
    `Bundled guidance for this task: ${recommendation.names.join(', ')} (${recommendation.reason}).`,
    `If ${primary} fits the requested work, load it with the skill tool before starting; disregard a lexical mismatch.`,
    'Load supporting skills and needed resources the same way, including continuation pages.',
    'These instructions grant no permissions, credentials, delegation or additional tools.',
    'Follow the selected skill acceptance checks before claiming completion.',
    '</local_skill_recommendation>',
  ].join('\n');
  return { content, names: recommendation.names, reason: recommendation.reason };
}

function latestUserText(request: Request): string {
  // Scan back to the last user message that actually carries text. A tool-loop
  // iteration ends with a user message holding only tool_result blocks; the
  // latest USER TEXT is still the turn's request, and treating the tool-result
  // message as "no request" would strip this middleware's own advice mid-turn.
  // On breakpoint wires that message also carries the host's `[live_context]`
  // tail (plan, gates, quoted earlier turns): authored text only, or the tail's
  // words would route skills and hide the real request behind it.
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const user = request.messages[i];
    if (user?.role !== 'user') continue;
    const text = authoredText(user);
    if (text.trim()) return text;
  }
  return '';
}
