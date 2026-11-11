import type { SiteRoute } from './content';
import { COMMAND_COUNT } from './content-commands';
import { PLUGIN_COUNT, TOOL_COUNT } from './runtime-catalog';
import { releaseHighlights } from './release-highlights';

export const pageMeta: Record<SiteRoute, { title: string; description: string }> = {
  '/': {
    title: 'WrongStack — AI coding, under your control',
    description: releaseHighlights.socialDescription,
  },
  '/features': {
    title: 'Features — WrongStack',
    description:
      'Explore WrongStack tools, autonomy, memory, model routing, sessions and developer workflows.',
  },
  '/how-it-works': {
    title: 'How WrongStack works',
    description:
      'Follow one request through context, providers, tools, permissions, retries, memory and persistence.',
  },
  '/compare': {
    title: 'WrongStack vs Claude Code, Codex, OpenCode, Cursor & Pi',
    description:
      'An evidence-based, official-source comparison of model routing, multi-agent coordination, mailbox, work tracking, extensions, security and operations.',
  },
  '/interfaces': {
    title: 'CLI, TUI, WebUI, VibeUI & HQ — WrongStack',
    description:
      'Five interfaces, one agent kernel. Choose the surface that fits the way you work.',
  },
  '/commands': {
    title: 'Slash command reference — WrongStack',
    description: `Search and understand ${COMMAND_COUNT} documented WrongStack operator commands.`,
  },
  '/settings': {
    title: 'Settings & configuration — WrongStack',
    description:
      'Configure providers, models, tools, context, fleets, sessions and security safely.',
  },
  '/architecture': {
    title: 'Architecture — WrongStack',
    description:
      'Understand the kernel, package boundaries, execution pipeline, recovery and persistence model.',
  },
  '/ecosystem': {
    title: 'WrongStack family & ecosystem — WrongStack',
    description:
      'Meet the WrongStack family: WrongStack for orchestration, WrongForge for agent execution and WrongTrace for observability. Explore prompts, skills, MCP, hooks, plugins and provider adapters.',
  },
  '/security': {
    title: 'Security model — WrongStack',
    description:
      'Permissions, encrypted secrets, network boundaries, project config safety and audit trails.',
  },
  '/getting-started': {
    title: 'Getting started — WrongStack',
    description:
      'Install WrongStack, choose authentication, initialize a project and run your first safe coding session.',
  },
  '/workflows': {
    title: 'Workflows — WrongStack',
    description:
      'Choose between goals, SDD, Goal, BTW, collaboration, ensemble and review workflows.',
  },
  '/fleet': {
    title: 'Fleet & Brain — WrongStack',
    description:
      'Understand Director orchestration, specialist agents, budgets, supervision and Brain-governed decisions.',
  },
  '/modes': {
    title: 'Session modes — WrongStack',
    description:
      'Compare all 19 built-in WrongStack persona modes, from token-saving lite passes to deep specialist workflows.',
  },
  '/agent-roster': {
    title: 'Agent roster — WrongStack',
    description:
      'Explore phase specialists, operational roles including Shadow, and optional ACP agents in the runtime fleet roster.',
  },
  '/mailbox': {
    title: 'Global Mailbox — WrongStack',
    description:
      'Understand typed cross-agent communication, identities, aliases, heartbeats, message lifecycle and the project mailbox bridge.',
  },
  '/memory': {
    title: 'Memory & sessions — WrongStack',
    description:
      'Learn how session logs, SAGE, checkpoints, compaction, replay and recovery preserve continuity.',
  },
  '/providers': {
    title: 'Providers & model routing — WrongStack',
    description:
      'Configure API-key and subscription providers, model routing, fallback chains and runtime reasoning controls.',
  },
  '/coding-plans': {
    title: 'Connect ChatGPT, OpenCode, MiniMax, Z.AI & Kimi — WrongStack',
    description:
      'Connect WrongStack with ChatGPT Codex sign-in or dedicated OpenCode, MiniMax, Z.AI and Kimi coding-plan API keys.',
  },
  '/mcp': {
    title: 'MCP guide — WrongStack',
    description: 'Connect, secure and operate MCP servers over stdio, SSE and streamable HTTP.',
  },
  '/tools': {
    title: `${TOOL_COUNT} built-in tools — WrongStack`,
    description:
      'Explore every built-in WrongStack tool, its permission level, mutability, execution contract and token-saving tier.',
  },
  '/plugins': {
    title: `${PLUGIN_COUNT} managed plugins — WrongStack`,
    description:
      'Search all managed first-party WrongStack plugins by source, default state and operational risk.',
  },
  '/troubleshooting': {
    title: 'Troubleshooting — WrongStack',
    description:
      'Diagnose provider, context, tool, MCP, session, plugin and terminal issues methodically.',
  },
  '/brand': {
    title: 'Brand guidelines — WrongStack',
    description:
      'Download the WrongStack logo and use the canonical colors, typography, naming and voice guidelines.',
  },
  '/created-by': {
    title: 'Built by OxogNet — WrongStack',
    description:
      'WrongStack is built and maintained by OXOGNET OÜ. Explore the studio, its principles and its ecosystem of AI agents, developer tools and open-source infrastructure.',
  },
  '/sage': {
    title: 'SAGE — WrongStack',
    description:
      'Persistent, structured knowledge that the agent remembers across sessions. Scopes, types, relevance scoring, graph edges, and auto-injection.',
  },
  '/design-studio': {
    title: 'Design Studio — WrongStack',
    description:
      'Curated design kits and design skills. Choose a direction, materialize tokens, and review the resulting UI.',
  },
  '/skills': {
    title: 'Skills — WrongStack',
    description:
      'Installable instruction packages selected by descriptions and triggers, then loaded on demand or eagerly into context.',
  },
  '/prompts': {
    title: 'Prompts library — WrongStack',
    description:
      'Reusable prompt templates across bundled, user, and project layers. Variables, favorites, and AI-assisted authoring.',
  },
  '/sdd': {
    title: 'SDD workflow — WrongStack',
    description:
      'Spec-Driven Development: plan, implement, and verify in structured phases with review between each step.',
  },
  '/shadow-agent': {
    title: 'Shadow Agent — WrongStack',
    description:
      'One-shot fleet checks on request or after problematic work, with anomaly detection and explicit intervention commands.',
  },
  '/acp': {
    title: 'ACP — WrongStack',
    description:
      'Drive external coding agents (Claude Code, Codex CLI, Gemini CLI) from WrongStack using their existing logins.',
  },
  '/supervisor': {
    title: 'Fleet Supervisor — WrongStack',
    description:
      'Brain-gated safety layer that approves or blocks fleet actions against risk thresholds.',
  },
  '/goal': {
    title: 'Goal — WrongStack',
    description:
      'Fully autonomous phased workflows with git worktree isolation and checkpoint rollback.',
  },
  '/ensemble': {
    title: 'Ensemble — WrongStack',
    description:
      'Fan one task to multiple ACP agents simultaneously. Compare independent results side by side.',
  },
  '/hq': {
    title: 'HQ Command Center — WrongStack',
    description:
      'Web-based fleet control panel. Monitor status, send steer prompts, and queue work from a browser.',
  },
  '/telegram': {
    title: 'Telegram integration — WrongStack',
    description:
      'Push notifications, interactive approval prompts, and remote commands through Telegram.',
  },
  '/collab': {
    title: 'Collab debugging — WrongStack',
    description:
      'BugHunter, RefactorPlanner, and Critic run in parallel and produce a structured verdict.',
  },
  '/sync': {
    title: 'GitHub Sync — WrongStack',
    description:
      'Sync settings, skills, prompts, and memory across machines through a GitHub repository.',
  },
  '/checkpoints': {
    title: 'Checkpoints — WrongStack',
    description: 'File state snapshots before risky edits. Roll back to the last known-good state.',
  },
  '/commit-workflow': {
    title: 'Commit workflow — WrongStack',
    description:
      'Auto-generated conventional commits from your diff. Stage, review, and commit with one command.',
  },
};
