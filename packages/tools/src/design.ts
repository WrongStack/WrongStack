import type { DesignStack, Tool } from '@wrongstack/core';
import { getDesignKitLoader, isDesignStack, recordKitChoice, setActiveKit } from '@wrongstack/core';

interface DesignInput {
  action?: 'list' | 'use' | 'foundations' | undefined;
  kit?: string | undefined;
  stack?: string | undefined;
}

interface DesignOutput {
  action: string;
  kit?: string | undefined;
  stack?: string | undefined;
  output: string;
}

/**
 * Design Studio tool — progressive disclosure of curated UI design kits.
 *
 * The model is nudged toward this tool by the Design Studio request middleware
 * once frontend work is detected. `list` shows the menu (cheap); `use` loads the
 * full, stack-specific kit spec into context and pins it as the active kit;
 * `foundations` returns the mandatory cross-cutting baseline.
 */
export const designTool: Tool<DesignInput, DesignOutput> = {
  name: 'design',
  category: 'Design',
  description:
    'Browse and load curated frontend/mobile UI design kits (selectable, production-grade design ' +
    'directions with concrete tokens + per-stack guidance). Use BEFORE writing UI code to commit to ' +
    'one coherent, modern, responsive, dark/light, accessible design — instead of generic default output. ' +
    'Actions: "list" (menu), "use" (load a kit\'s full spec for a stack and pin it active), ' +
    '"foundations" (mandatory responsive/a11y/theming/motion baseline).',
  usageHint:
    'Typical flow: `design {action:"list"}` → pick a kit → ' +
    '`design {action:"use", kit:"minimal-clarity", stack:"web"}` → implement faithfully.\n' +
    'Stacks: web | react-native | flutter | swiftui | compose.',
  permission: 'auto',
  mutating: false,
  capabilities: [],
  timeoutMs: 10_000,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'use', 'foundations'],
        description:
          'list = show the kit menu; use = load a kit; foundations = baseline rules. Default: list.',
      },
      kit: {
        type: 'string',
        description: 'Kit id (required for action "use"), e.g. "minimal-clarity", "neo-brutalist".',
      },
      stack: {
        type: 'string',
        enum: ['web', 'react-native', 'flutter', 'swiftui', 'compose'],
        description: 'Target stack — narrows guidance to that platform. Default: web.',
      },
    },
    required: [],
  },
  async execute(input, ctx): Promise<DesignOutput> {
    const loader = getDesignKitLoader(ctx.projectRoot);
    const action = input.action ?? 'list';
    const stack: DesignStack | undefined =
      input.stack && isDesignStack(input.stack) ? input.stack : undefined;

    if (action === 'foundations') {
      const text = await loader.foundationsText(stack);
      return {
        action,
        stack,
        output: text || 'No foundations document is installed.',
      };
    }

    if (action === 'use') {
      const kitId = input.kit?.trim();
      if (!kitId) {
        const menu = await loader.menuText();
        return { action, output: `No kit id provided.\n\n${menu}` };
      }
      const manifest = await loader.find(kitId);
      if (!manifest) {
        const menu = await loader.menuText();
        return { action, kit: kitId, output: `Kit "${kitId}" not found.\n\n${menu}` };
      }
      const resolvedStack = stack ?? manifest.stacks[0] ?? 'web';
      const body = await loader.readBody(manifest.id, resolvedStack);
      const tokens = await loader.readTokens(manifest.id);
      // Pin the chosen kit so the request middleware switches from "pick a kit"
      // to a compact adherence reminder, and UI pickers reflect the selection.
      setActiveKit(ctx, manifest.id, resolvedStack);
      // Persist the decision to the gitignored `.design/` dir (active.json +
      // decisions.md) so it survives across sessions. Best-effort.
      await recordKitChoice(
        ctx.projectRoot,
        manifest.id,
        resolvedStack,
        'design-tool',
        new Date().toISOString(),
      );

      const header =
        `# Active design kit: ${manifest.name} (${manifest.id}) — stack: ${resolvedStack}\n` +
        `${manifest.aesthetic}\n\n` +
        'Implement the UI faithfully to this spec. Keep light/dark, responsive, and WCAG AA.\n';
      const tokenBlock = tokens
        ? `\n## Token snapshot (tokens.json)\n\`\`\`json\n${JSON.stringify(tokens, null, 2)}\n\`\`\`\n`
        : '';
      return {
        action,
        kit: manifest.id,
        stack: resolvedStack,
        output: `${header}${tokenBlock}\n${body}`,
      };
    }

    // Default: list
    const menu = await loader.menuText();
    return {
      action: 'list',
      output:
        (menu || 'No design kits are installed.') +
        '\n\nLoad one with `design {action:"use", kit:"<id>", stack:"<stack>"}`.',
    };
  },
};
