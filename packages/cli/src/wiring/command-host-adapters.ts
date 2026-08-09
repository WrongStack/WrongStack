/** Terminal and tool-execution adapters used by the slash-command host. */
import type { Agent } from '@wrongstack/core/agent';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { color, isStdinTTY } from '@wrongstack/core/utils';
import type { ReadlineInputReader } from '../input-reader.js';
import type { BuiltinSlashCommandDeps } from './slash-commands.js';

type SlashCommandDeps = BuiltinSlashCommandDeps;

export function createCommandHostAdapters(input: {
  agent: Agent;
  toolRegistry: ToolRegistry;
  interruptController: {
    confirmSlash?: ((question: string, defaultYes: boolean) => Promise<boolean | null>) | undefined;
  };
  reader: ReadlineInputReader;
}): Pick<SlashCommandDeps, 'executeTool' | 'confirm'> {
  return {
    executeTool: async (name, toolInput, context) => {
      const tool = input.toolRegistry.get(name);
      if (!tool) throw new Error(`Tool "${name}" is not registered in this session.`);
      const { outputs } = await input.agent.toolExecutor.executeBatch(
        [
          {
            type: 'tool_use',
            id: `slash-${name}-${Date.now()}`,
            name,
            input: toolInput,
          },
        ],
        context,
        'sequential',
      );
      const output = outputs[0];
      if (!output) throw new Error(`Tool "${name}" returned no result.`);
      if (output.result.type === 'tool_confirm_pending') {
        throw new Error(`Tool "${name}" still requires interactive confirmation.`);
      }
      if (output.result.is_error) throw new Error(output.result.content);
      return { detail: output.result.content };
    },
    confirm: async (question, defaultYes = true) => {
      if (input.interruptController.confirmSlash) {
        return input.interruptController.confirmSlash(question, defaultYes);
      }
      if (!isStdinTTY()) return false;
      const hint = defaultYes ? '[Y/n/q]' : '[y/N/q]';
      try {
        const raw = await input.reader.readLine(
          `  ${color.amber('?')} ${question} ${color.dim(hint)} `,
        );
        const answer = raw.trim().toLowerCase();
        if (answer === 'q' || answer === 'quit' || answer === 'cancel') return null;
        if (answer === '') return defaultYes;
        return answer === 'y' || answer === 'yes';
      } catch {
        return false;
      }
    },
  };
}
