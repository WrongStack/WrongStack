/**
 * Required skills for an agent leading the session (ACP or WrongForge).
 *
 * A `wrongstack:required-skills` marker gates a model WrongStack runs: the
 * executor refuses its edits until the `skill` tool delivered each skill. An
 * agent that keeps its own context is not gated — it loads skills with its own
 * tools, out of the host's sight — so the marker would reach it as an HTML
 * comment beside `$name` mentions it has no meaning for. This turns it into a
 * plain instruction that names the skill tool the route actually offers.
 */
import { parseRequiredSkillsMarker } from '@wrongstack/core/skills';

const MARKERS = /<!--\s*wrongstack:required-skills\s+[\s\S]*?-->/g;

/** The WrongStack `skill` tool as an agent sees it on this route, if offered. */
export function externalSkillLoader(
  offered: readonly string[] | undefined,
  prefix: string,
): string | undefined {
  return offered?.includes('skill') ? `${prefix}skill` : undefined;
}

/** `text` with its required-skills marker rewritten for an agent leader. */
export function externalSkillDirective(text: string, loader: string | undefined): string {
  const skills = parseRequiredSkillsMarker(text);
  if (!skills) return text;
  const list = skills.join(', ');
  const line = loader
    ? `[WrongStack] This task's playbook skills: ${list}. They are WrongStack skills: ` +
      `load each with the \`${loader}\` tool, following nextOffset to the last page, ` +
      'before changing code. Where the text below names the `skill` tool or a $name, ' +
      'it means that tool and these skills.'
    : `[WrongStack] This task's playbook skills: ${list}. This route offers no WrongStack ` +
      'skill tool: load them with your own skill tool if you have them, otherwise follow ' +
      'the protocol below without them.';
  let first = true;
  return text.replace(MARKERS, () => {
    if (!first) return '';
    first = false;
    return line;
  });
}
