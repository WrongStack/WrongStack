import type { Middleware } from '@wrongstack/contracts/kernel/pipeline';
import { markVolatileSystemBlock } from '@wrongstack/contracts/types/blocks';
import { authoredText } from '@wrongstack/contracts/types/live-context';
import type { Request } from '@wrongstack/contracts/types/provider';
import type { SkillLoader } from '@wrongstack/contracts/types/skill';
import { extractSkillMentions } from './mentions.js';

/** Explicit selections are local and independent of the optional skill recommender. */
export function createSkillMentionMiddleware(loader: SkillLoader): Middleware<Request> {
  return {
    name: 'skills.mentions',
    owner: 'skills',
    async handler(request, next) {
      const latest = request.messages.findLast((message) => message.role === 'user');
      // A `$skill` quoted by the live-context tail (continuity, memory
      // evidence) is not a selection made in this message.
      const content = latest ? authoredText(latest) : '';
      const names = extractSkillMentions(content);
      if (!names.length) return next(request);
      loader.invalidateCache();
      const catalog = new Set((await loader.list()).map((skill) => skill.name));
      const selected = names.filter((name) => catalog.has(name));
      const missing = names.filter((name) => !catalog.has(name) && /[a-z]/.test(name));
      if (!selected.length && !missing.length) return next(request);
      const text = [
        'Explicit skill selections in the current user message take precedence over automatic skill suggestions.',
        selected.length
          ? `The user selected: ${selected.map((name) => `$${name}`).join(', ')}. Load each with the skill tool before relying on it, including any continuation pages. Apply the instructions to the current task; skill selection does not expand authorization.`
          : '',
        missing.length
          ? `These requested skills are unavailable: ${missing.join(', ')}. Tell the user; do not invent their instructions.`
          : '',
      ]
        .filter(Boolean)
        .join('\n');
      return next({
        ...request,
        system: [
          ...(request.system ?? []),
          markVolatileSystemBlock({ type: 'text', text, cache_control: { type: 'ephemeral' } }),
        ],
      });
    },
  };
}
