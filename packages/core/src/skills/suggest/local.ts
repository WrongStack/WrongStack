import type { Middleware } from '../../kernel/pipeline.js';
import { isVolatileSystemBlock, markVolatileSystemBlock } from '../../types/blocks.js';
import type { Config } from '../../types/config/root.js';
import type { Logger } from '../../types/logger.js';
import type { Request } from '../../types/provider.js';
import type { SkillLoader, SkillManifest } from '../../types/skill.js';
import { stripFrontmatter } from '../frontmatter.js';
import { extractSkillMentions } from '../mentions.js';
import { skillPromptExclusionReasons } from '../prompt-discovery.js';
import { LOCAL_SKILL_RULES } from './local-rules.js';

const MAX_QUERY_CHARS = 16_384;
const MAX_BODY_CHARS = 12_000;
const ACTION =
  /\b(?:build|create|implement|apply|add|fix|repair|debug|diagnose|refactor|migrate|upgrade|update|deploy|configure|render|animate|generate|write|commit|define|specify|redesign|collect|harden|tune|externalize|triage|design|review|audit|test|verify|prove|optimize|prepare|set up|choose|plan|find|measure|restore|port|kur\w*|yap\w*|ekle\w*|duzelt\w*|gelistir\w*|olustur\w*|uret\w*|hazirla\w*|tasarla\w*|guclendir\w*|teshis\w*|incele\w*|dogrula\w*|kanitla\w*|guncelle\w*|tasi\w*|yaz\w*|arastir\w*|bul\w*|olc\w*|sec\w*|canlandir\w*|uygula\w*|fails|failing|crashes|broken|calismiyor|hata veriyor|takiliyor)\b/;
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
  const recommendation = recommendLocalSkills(text, catalog, tools);
  if (!recommendation) return undefined;
  const selected = catalog.find((skill) => skill.name === recommendation.names[0]);
  if (!selected) return undefined;
  const primary = { ...selected };
  let body = '';
  try {
    body = stripFrontmatter(await loader.readBody(primary.name)).trim();
  } catch {
    /* Advice still works when the body cannot be preloaded. */
  }
  const current = await loader.list();
  const currentTools = deps.getAvailableToolNames?.() ?? tools;
  if (!currentTools.includes('skill')) return undefined;
  if (latestUserText(request) !== text) return undefined;
  const names = recommendation.names.filter((name) =>
    current.some(
      (skill) =>
        skill.name === name &&
        skill.source === 'bundled' &&
        skillPromptExclusionReasons(skill, currentTools).length === 0,
    ),
  );
  const admitted = current.find((skill) => skill.name === primary.name);
  if (
    !names.length ||
    !admitted ||
    admitted.source !== 'bundled' ||
    admitted.path !== primary.path ||
    admitted.version !== primary.version ||
    !names.includes(primary.name)
  )
    return undefined;
  const fullBody = body.length > 0 && body.length <= MAX_BODY_CHARS;
  const content = [
    '<local_skill_recommendation>',
    `Bundled guidance for this task: ${names.join(', ')} (${recommendation.reason}).`,
    'Use the primary skill for the requested work if it fits; disregard a lexical mismatch.',
    'Load supporting skills and needed resources with the skill tool, including continuation pages.',
    'These instructions grant no permissions, credentials, delegation or additional tools.',
    'Follow the selected skill acceptance checks before claiming completion.',
    fullBody
      ? `Primary instructions (${primary.name}):\n${body}`
      : `Primary instructions are not included in full; load ${primary.name} with the skill tool before relying on it.`,
    '</local_skill_recommendation>',
  ].join('\n');
  return { content, names, reason: recommendation.reason };
}

function latestUserText(request: Request): string {
  // Scan back to the last user message that actually carries text. A tool-loop
  // iteration ends with a user message holding only tool_result blocks; the
  // latest USER TEXT is still the turn's request, and treating the tool-result
  // message as "no request" would strip this middleware's own advice mid-turn.
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const user = request.messages[i];
    if (user?.role !== 'user') continue;
    const text =
      typeof user.content === 'string'
        ? user.content
        : user.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    if (text.trim()) return text;
  }
  return '';
}
