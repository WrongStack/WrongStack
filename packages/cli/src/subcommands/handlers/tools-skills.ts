import { color } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';

export const toolsCmd: SubcommandHandler = async (_args, deps) => {
  const reg = deps.toolRegistry;
  if (!reg) return 0;
  for (const { tool, owner } of reg.listWithOwner())
    deps.renderer.write(
      `  ${tool.name.padEnd(28)} ${color.dim(`[${owner}]`)} ${tool.permission}\n`,
    );
  return 0;
};

export const skillsCmd: SubcommandHandler = async (_args, deps) => {
  if (!deps.skillLoader) return 0;
  const list = await deps.skillLoader.list();
  for (const s of list)
    deps.renderer.write(
      `  ${s.name.padEnd(24)} ${color.dim(`[${s.source}]`)} ${s.description.split('\n')[0]}\n`,
    );
  return 0;
};
