import { color } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';

export const toolsCmd: SubcommandHandler = async (args, deps) => {
  const verb = args[0] ?? '';
  if (['list', 'describe', 'run', 'batch', 'agent-guide', 'serve', 'catalog'].includes(verb)) {
    const { runToolsCli } = await import('./tools-cli.js');
    return runToolsCli(verb, args.slice(1), deps);
  }
  const reg = deps.toolRegistry;
  if (!reg) return 0;
  for (const { tool, owner } of reg.listWithOwner())
    deps.renderer.write(
      `  ${(tool.name === 'tool_script' ? 'tool_script / ToolFlow' : tool.name).padEnd(28)} ${color.dim(`[${owner}]`)} ${tool.permission}\n`,
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
