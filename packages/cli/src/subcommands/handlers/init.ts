import { color } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';

/**
 * @deprecated Use `wstack auth` instead. The auth command handles provider setup,
 * key management, and model selection in one interactive workflow.
 */
export const initCmd: SubcommandHandler = async (_args, deps) => {
  deps.renderer.write(color.bold('WrongStack init (deprecated)\n'));
  deps.renderer.write(
    `\n  ${color.amber('⚠ This command is deprecated.')}\n\n` +
      `  Use ${color.bold('wstack auth')} to set up providers, add API keys,\n` +
      `  and configure your default model in one interactive workflow.\n\n` +
      `  ${color.dim('Examples:')}\n` +
      `    ${color.cyan('wstack auth')}              Interactive setup menu\n` +
      `    ${color.cyan('wstack auth anthropic')}   Add Anthropic API key directly\n` +
      `    ${color.cyan('wstack auth local')}        Add local LLM (Ollama, vLLM, LM Studio)\n\n` +
      `  Run ${color.bold('wstack auth --help')} for more options.\n`,
  );
  return 0;
};
