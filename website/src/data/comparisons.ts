import { rosterIndex } from '@/data/product-catalog';
import { pluginCatalog, toolCatalog } from '@/data/runtime-catalog';

export type EvidenceLevel = 'native' | 'different' | 'extension' | 'not-verified' | 'absent';

export type ComparisonSource = {
  label: string;
  href: string;
  note: string;
};

export type ComparisonRow = {
  capability: string;
  wrongstack: string;
  competitor: string;
  difference: string;
  competitorLevel: EvidenceLevel;
};

export type ProductComparison = {
  id: string;
  name: string;
  maker: string;
  mark: string;
  accent: 'amber' | 'blue' | 'green' | 'purple' | 'red';
  positioning: string;
  strongestCase: string;
  wrongStackCase: string;
  sources: ComparisonSource[];
  rows: ComparisonRow[];
};

export const comparisonVerifiedOn = '13 July 2026';

const builtInAgentCount = rosterIndex.filter((agent) => agent.kind !== 'acp').length;
const acpAgentCount = rosterIndex.filter((agent) => agent.kind === 'acp').length;

export const overviewRows = [
  {
    capability: 'Source & license',
    wrongstack: 'Open source · MIT',
    claude: 'Commercial product',
    codex: 'CLI: Apache-2.0',
    opencode: 'Open source · MIT',
    cursor: 'Commercial product',
    pi: 'Open source · MIT',
  },
  {
    capability: 'Model strategy',
    wrongstack: 'Multi-provider + per-role routing',
    claude: 'Claude model family',
    codex: 'OpenAI model family',
    opencode: '75+ providers + local models',
    cursor: 'Multiple frontier models',
    pi: 'Many providers + custom adapters',
  },
  {
    capability: 'First-party agents',
    wrongstack: `${builtInAgentCount} built-in roles + ${acpAgentCount} ACP roles`,
    claude: 'Subagents + experimental teams',
    codex: 'Subagents; 6 threads by default',
    opencode: '2 primary + 3 subagents',
    cursor: 'Local and cloud subagents',
    pi: 'None in core by design',
  },
  {
    capability: 'Agent communication',
    wrongstack: 'Durable Global Mailbox',
    claude: 'Team peer messaging',
    codex: 'Parent-mediated threads',
    opencode: 'Primary invokes subagents',
    cursor: 'Parent/cloud hand-off',
    pi: 'Extension or external process',
  },
  {
    capability: 'Work system',
    wrongstack: 'Kanban + queue + goals + SDD',
    claude: 'Team shared task list',
    codex: 'Goal mode + agent jobs',
    opencode: 'Todo/task tools',
    cursor: 'Cloud agent dashboard',
    pi: 'No built-in todos by design',
  },
  {
    capability: 'MCP',
    wrongstack: 'Client + server; lazy lifecycle',
    claude: 'Native client',
    codex: 'Client + server',
    opencode: 'Native client + OAuth',
    cursor: 'Native',
    pi: 'Extension, not core',
  },
  {
    capability: 'Operations surface',
    wrongstack: 'CLI · TUI · WebUI · Desktop · HQ',
    claude: 'Terminal · IDE · Desktop · Web',
    codex: 'CLI · IDE · App · Cloud',
    opencode: 'TUI · Desktop · IDE · Web · Server',
    cursor: 'Editor · CLI · Web · Mobile · Cloud',
    pi: 'Terminal · JSON · RPC · SDK',
  },
] as const;

export const productComparisons: ProductComparison[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    maker: 'Anthropic',
    mark: 'CC',
    accent: 'purple',
    positioning:
      'A mature Claude-first coding product with polished terminal, IDE, desktop and web surfaces, plus one of the strongest documented extension layers in the category.',
    strongestCase:
      'Choose Claude Code when your team is standardized on Claude and values its polished cross-surface hand-off, agent teams, Slack/CI integrations and Anthropic-managed routines.',
    wrongStackCase:
      'Choose WrongStack when the operating system around the models matters: provider-independent role routing, a durable project mailbox, fleet budgets, Brain-governed intervention and a self-hosted HQ map.',
    sources: [
      {
        label: 'Product overview',
        href: 'https://code.claude.com/docs/en',
        note: 'Surfaces, MCP, memory, automation and agent teams',
      },
      {
        label: 'Extension map',
        href: 'https://code.claude.com/docs/en/features-overview',
        note: 'Skills, subagents, teams, hooks, MCP and plugins',
      },
      {
        label: 'Subagents',
        href: 'https://code.claude.com/docs/en/sub-agents',
        note: 'Isolated contexts, models, tools and permissions',
      },
    ],
    rows: [
      {
        capability: 'Execution surfaces',
        wrongstack:
          'Six first-class surfaces share one kernel: CLI, TUI, WebUI, SimpleUI, Desktop and HQ.',
        competitor:
          'Officially available in the terminal, VS Code and JetBrains IDEs, desktop app and browser.',
        difference:
          'Both are genuinely cross-surface. WrongStack adds an operations-focused HQ; Claude Code adds a more mature hosted web/mobile hand-off.',
        competitorLevel: 'native',
      },
      {
        capability: 'Models and routing',
        wrongstack:
          'Anthropic, OpenAI, Google and OpenAI-compatible providers can be mixed by role, phase and fallback profile.',
        competitor:
          'Claude model family, authenticated through Claude or supported third-party enterprise provider routes.',
        difference:
          'WrongStack can put different model families behind leader, reviewer, Brain and fallback roles in the same run.',
        competitorLevel: 'different',
      },
      {
        capability: 'Multi-agent execution',
        wrongstack:
          'Director dispatches a code-owned roster with queueing, concurrency, recursion limits and per-worker token, cost, tool and timeout budgets.',
        competitor:
          'Subagents run isolated loops; experimental agent teams coordinate independent sessions through a lead agent.',
        difference:
          'Claude has real first-party multi-agent work. WrongStack exposes more of the fleet as an operator-controlled runtime with explicit budgets and lifecycle events.',
        competitorLevel: 'native',
      },
      {
        capability: 'Agent-to-agent communication',
        wrongstack:
          'Global Mailbox persists typed messages across agents, processes and surfaces, with unique identities, aliases, acknowledgements and presence.',
        competitor:
          'Agent teams support direct teammate messaging and a shared task list; the feature is documented as experimental and disabled by default.',
        difference:
          'Claude team messaging is strong inside a team. WrongStack mailbox routing is project-wide and also connects separate CLI, TUI, WebUI and Desktop sessions.',
        competitorLevel: 'native',
      },
      {
        capability: 'Work tracking',
        wrongstack:
          'Kanban primitives, Director tasks, goals, todos, plans and SDD evidence form one durable work system.',
        competitor:
          'Agent teams share a task list and the lead assigns work; official docs do not present it as a general project Kanban system.',
        difference:
          'WrongStack keeps work state useful before, during and after a particular agent team exists.',
        competitorLevel: 'different',
      },
      {
        capability: 'Decision governance',
        wrongstack:
          'A separate Brain tier evaluates autonomous proposals; Fleet Supervisor signals, risk ceilings and exact option IDs keep decisions bounded.',
        competitor:
          'Permission modes, hooks and lead-agent coordination govern actions. A separate, inspectable decision arbiter was not found in the reviewed official docs.',
        difference:
          'WrongStack treats “should the fleet do this?” as a first-class decision event, not only a tool permission.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Memory and continuity',
        wrongstack:
          'Append-only reconstructable sessions plus SAGE with scopes, anchors, graph relationships, verification and hygiene.',
        competitor:
          'CLAUDE.md, path-scoped rules, auto memory and managed sessions provide persistent project context.',
        difference:
          'Both persist knowledge. WrongStack emphasizes inspectable provenance and re-verifying memories when anchored files change.',
        competitorLevel: 'native',
      },
      {
        capability: 'Extensions',
        wrongstack:
          'MCP, skills, hooks, plugins, prompt libraries, provider adapters and ACP enter through explicit capability contracts.',
        competitor:
          'MCP, skills, hooks, subagents and plugins/marketplaces are all documented first-party extension points.',
        difference:
          'This is a shared strength. WrongStack additionally exposes provider/runtime composition; Claude has a more established distribution ecosystem.',
        competitorLevel: 'native',
      },
      {
        capability: 'Operations and observability',
        wrongstack:
          'HQ aggregates surface, fleet, mailbox, Brain, tool, worktree, cost and alert telemetry and can issue scoped control commands.',
        competitor:
          'Desktop can run multiple sessions, web can run parallel work, and sessions move between surfaces. No comparable fleet-wide HQ was verified in the reviewed docs.',
        difference:
          'WrongStack is designed to operate a mixed local fleet as a system, not only to view parallel conversations.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Source and cost model',
        wrongstack: 'The complete WrongStack runtime is MIT licensed with no paid feature gate.',
        competitor:
          'Claude Code is a commercial Anthropic product; most surfaces require a Claude subscription or Console account.',
        difference:
          'Claude usage buys a managed product. WrongStack itself has no license fee; the model provider may still charge for usage.',
        competitorLevel: 'different',
      },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    maker: 'OpenAI',
    mark: 'OX',
    accent: 'green',
    positioning:
      'OpenAI’s local-and-cloud coding system, spanning an open-source CLI, IDE, desktop app and hosted tasks with first-party subagent workflows.',
    strongestCase:
      'Choose Codex when you want the first-party OpenAI model experience, ChatGPT sign-in, polished app/cloud workflows and OpenAI’s integrated browser and computer-use surfaces.',
    wrongStackCase:
      'Choose WrongStack when one project must mix OpenAI with other providers, route models per role, keep agents talking across independent surfaces and expose fleet decisions through Brain and HQ.',
    sources: [
      {
        label: 'Developer overview',
        href: 'https://learn.chatgpt.com/docs/developers',
        note: 'Local/cloud environments, skills, plugins, SDK and integrations',
      },
      {
        label: 'Subagents',
        href: 'https://learn.chatgpt.com/docs/agent-configuration/subagents',
        note: 'Availability, thread limits, custom agents and orchestration',
      },
      {
        label: 'Open-source CLI',
        href: 'https://github.com/openai/codex',
        note: 'Local CLI, ChatGPT login and Apache-2.0 license',
      },
    ],
    rows: [
      {
        capability: 'Execution surfaces',
        wrongstack:
          'CLI, TUI, WebUI, SimpleUI, Electron Desktop and HQ run on the same TypeScript kernel.',
        competitor:
          'Codex runs in the ChatGPT desktop app, CLI and IDE extension, with local and OpenAI-managed cloud environments.',
        difference:
          'Codex has a polished first-party local/cloud product line. WrongStack keeps every core surface self-hostable and adds a dedicated fleet control plane.',
        competitorLevel: 'native',
      },
      {
        capability: 'Models and routing',
        wrongstack:
          'Per-role modelMatrix entries can cross provider families and attach runtime reasoning or fallback profiles.',
        competitor:
          'Custom agents can select different OpenAI models and reasoning levels; authentication is ChatGPT or OpenAI API.',
        difference:
          'Both route models per agent. WrongStack’s matrix is provider-neutral and its fallback layer can cross provider boundaries for capacity failures.',
        competitorLevel: 'different',
      },
      {
        capability: 'Multi-agent execution',
        wrongstack: `Director operates ${builtInAgentCount} built-in roles plus ${acpAgentCount} optional ACP roles, with pending-task retargeting, first-finisher waits and negotiated budgets.`,
        competitor:
          'Subagent workflows are enabled by default. Codex ships default, worker and explorer agents; open threads default to a cap of six and depth one.',
        difference:
          'Codex has real, inspectable parallel threads. WrongStack ships a much larger domain roster and treats budget, queue and supervisor policy as part of the orchestration contract.',
        competitorLevel: 'native',
      },
      {
        capability: 'Agent-to-agent communication',
        wrongstack:
          'Agents can mail peers, the leader, aliases or broadcasts; messages survive turns and can cross running products on the project.',
        competitor:
          'The main thread spawns, steers, waits for and closes subagent threads, then consolidates their results.',
        difference:
          'Codex documentation describes parent-mediated orchestration. It does not document a durable peer mailbox shared by independent clients.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Work tracking',
        wrongstack:
          'Kanban, goals, SDD, todos, Director queue state and mailbox status form a single persisted project workflow.',
        competitor:
          'Goal mode supports long-running objectives and experimental CSV agent jobs provide structured batch state; no general Kanban board was verified.',
        difference:
          'Codex is strong at bounded tasks and batch fan-out. WrongStack exposes an ongoing work system that human and agent surfaces share.',
        competitorLevel: 'different',
      },
      {
        capability: 'Decision governance',
        wrongstack:
          'Brain policy, optional LLM judgment and human escalation sit above tool permissions; Supervisor proposals always pass through that layer.',
        competitor:
          'Subagents inherit sandbox and approval policy, with per-agent sandbox overrides and managed permission controls.',
        difference:
          'Codex has strong execution security. WrongStack separately models autonomous operational decisions such as spawn, retarget, steer and terminate.',
        competitorLevel: 'different',
      },
      {
        capability: 'Extensions and automation',
        wrongstack:
          'Plugins, skills, hooks, MCP client/server, ACP, reusable prompts and provider adapters all run through the same runtime contracts.',
        competitor:
          'Skills, plugins, apps/connectors, hooks, MCP server, SDK, App Server, GitHub Action and non-interactive mode are official surfaces.',
        difference:
          'This is a shared strength. Codex has broader OpenAI/ChatGPT product integration; WrongStack exposes more of its provider and fleet internals for replacement.',
        competitorLevel: 'native',
      },
      {
        capability: 'Operations and observability',
        wrongstack:
          'HQ receives typed telemetry from every connected surface and visualizes clients, agents, mailbox, Brain, worktrees, cost and alerts.',
        competitor:
          'App, CLI and IDE display subagent activity and let operators inspect individual threads. No equivalent mixed-surface fleet topology was verified.',
        difference:
          'Codex thread inspection is product-native; WrongStack HQ is a self-hosted operations console for the entire project runtime.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Source and cost model',
        wrongstack: 'Whole runtime and graphical surfaces are MIT licensed and free to use.',
        competitor:
          'Codex CLI is Apache-2.0; hosted app/web access is tied to eligible ChatGPT plans or API usage.',
        difference:
          'Both have open-source local cores. WrongStack’s surrounding WebUI, Desktop, HQ, fleet and provider layer live in the same open monorepo.',
        competitorLevel: 'native',
      },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    maker: 'Anomaly',
    mark: 'OC',
    accent: 'blue',
    positioning:
      'A fast-moving open-source coding agent with exceptional provider breadth, a client/server architecture and strong permissions, plugins and MCP support.',
    strongestCase:
      'Choose OpenCode when maximum provider choice, a polished TUI, local models and a very large open-source ecosystem are the primary requirements.',
    wrongStackCase:
      'Choose WrongStack when the hard problem is not connecting a model but operating a governed team: roster budgets, durable mailbox, Kanban/SDD, Brain decisions and HQ telemetry.',
    sources: [
      {
        label: 'Introduction',
        href: 'https://opencode.ai/docs',
        note: 'Open-source status and terminal, desktop and IDE surfaces',
      },
      {
        label: 'Providers',
        href: 'https://opencode.ai/docs/providers',
        note: '75+ providers, local models and /connect',
      },
      {
        label: 'Agents',
        href: 'https://opencode.ai/docs/agents/',
        note: 'Primary agents, subagents, models and permissions',
      },
      {
        label: 'Server',
        href: 'https://opencode.ai/docs/server/',
        note: 'Headless HTTP server, OpenAPI and SSE events',
      },
      {
        label: 'Permissions',
        href: 'https://opencode.ai/docs/permissions/',
        note: 'Allow, ask, deny and auto mode',
      },
    ],
    rows: [
      {
        capability: 'Execution surfaces',
        wrongstack:
          'CLI, optional Ink TUI, WebUI, Electron Desktop and HQ compose one lower-level runtime.',
        competitor:
          'Terminal TUI, desktop app, IDE extension, web interface and headless OpenAPI server are documented surfaces.',
        difference:
          'Both are open and multi-surface. OpenCode’s server/client split is especially clean; WrongStack adds a fleet-specific HQ and cross-process coordination services.',
        competitorLevel: 'native',
      },
      {
        capability: 'Models and routing',
        wrongstack:
          'Multiple provider families, OpenAI-compatible endpoints, subscription auth, per-role matrix and bounded cross-provider fallback.',
        competitor:
          'Official docs state 75+ LLM providers plus local models, configured with /connect and provider-specific config.',
        difference:
          'OpenCode wins the documented provider-count comparison. WrongStack concentrates on role/phase routing, resilience taxonomy and fleet-wide policy around those providers.',
        competitorLevel: 'native',
      },
      {
        capability: 'Multi-agent execution',
        wrongstack: `${builtInAgentCount} built-in roles, structured Director tasks, worker reuse/retirement, budgets, lineage, supervisor signals and ${acpAgentCount} ACP ensemble roles.`,
        competitor:
          'Two built-in primary agents (Build and Plan) plus three built-in subagents (General, Explore and Scout); custom agents can set prompts, models and permissions.',
        difference:
          'OpenCode has clean agent specialization and parallel subagents. WrongStack ships a larger lifecycle roster and a more explicit fleet scheduler/governor.',
        competitorLevel: 'native',
      },
      {
        capability: 'Agent-to-agent communication',
        wrongstack:
          'Mailbox identities, aliases, broadcasts, heartbeats and acknowledgements connect agents and separate live sessions.',
        competitor:
          'Primary agents can invoke subagents automatically or through @ mentions. Peer-to-peer persistent agent mail was not found in the reviewed docs.',
        difference:
          'OpenCode’s model is task delegation; WrongStack also treats coordination messages and liveness as durable project infrastructure.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Work tracking',
        wrongstack:
          'Kanban queue primitives, goals, SDD trackers, Director task state and session recovery are built in.',
        competitor:
          'Todo and task tools are permission-aware, but the reviewed official docs do not present a durable cross-client Kanban/SDD layer.',
        difference:
          'WrongStack couples agent work to explicit project state instead of keeping task shape mainly inside a conversation.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Permissions',
        wrongstack:
          'Auto, confirm and deny policies combine with hooks, encrypted secrets and an allow-listed untrusted project config boundary; explicit deny survives YOLO.',
        competitor:
          'Allow, ask and deny rules support granular patterns. Auto mode approves asks but continues to enforce explicit deny.',
        difference:
          'The core permission posture is closely aligned. WrongStack additionally documents project-config fields that are stripped to prevent repo-borne RCE or key exfiltration.',
        competitorLevel: 'native',
      },
      {
        capability: 'Extensions and MCP',
        wrongstack: `Capability-declared plugins, ${pluginCatalog.length} managed plugins, skills, hooks, prompts and MCP client/server with lazy cached tool manifests.`,
        competitor:
          'Local/npm plugins, custom tools and native local/remote MCP with automatic OAuth are documented first-party features.',
        difference:
          'Both are highly extensible. WrongStack’s managed catalog exposes default state and risk metadata; OpenCode benefits from a broader public ecosystem.',
        competitorLevel: 'native',
      },
      {
        capability: 'Memory and continuity',
        wrongstack:
          'Reconstructable session JSONL and graph-based SAGE include verification, anchors, scopes and file-change hygiene.',
        competitor:
          'Sessions and project instructions are supported; a comparable verified memory graph was not found in the reviewed official pages.',
        difference:
          'WrongStack gives durable facts an explicit storage, provenance and re-verification model.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Operations and observability',
        wrongstack:
          'HQ is a multi-client topology, telemetry, alerts and scoped command plane; metrics, traces and health also exist below the UI.',
        competitor:
          'Headless server exposes OpenAPI, health and SSE events and can support multiple clients.',
        difference:
          'OpenCode provides excellent programmatic building blocks. WrongStack ships the higher-level operational fleet console on top of them.',
        competitorLevel: 'different',
      },
      {
        capability: 'Source and cost model',
        wrongstack: 'MIT licensed, free runtime; provider charges remain external.',
        competitor: 'MIT licensed, open-source runtime; provider charges remain external.',
        difference:
          'No meaningful license advantage either way. The choice is architecture and workflow, not access to the source.',
        competitorLevel: 'native',
      },
    ],
  },
  {
    id: 'cursor',
    name: 'Cursor',
    maker: 'Anysphere',
    mark: 'CU',
    accent: 'amber',
    positioning:
      'An IDE-first commercial coding environment with excellent inline editing, frontier-model access and increasingly capable isolated cloud agents.',
    strongestCase:
      'Choose Cursor when the editor itself is the product: Tab completion, inline diffs, codebase navigation and managed cloud VMs are central to the way the team works.',
    wrongStackCase:
      'Choose WrongStack when you want an open terminal-first command center, direct provider ownership and a fleet coordination layer that is independent of one editor or hosted agent service.',
    sources: [
      {
        label: 'Cloud agents',
        href: 'https://cursor.com/en-US/cloud',
        note: 'Parallel agents, integrations, automations and memory',
      },
      {
        label: 'Cloud subagents',
        href: 'https://cursor.com/changelog/cloud-in-agents-window',
        note: 'Isolated VM subagents and local/cloud hand-off',
      },
      {
        label: 'Agent practices',
        href: 'https://cursor.com/blog/agent-best-practices',
        note: 'Cloud task flow and agent dashboard',
      },
      {
        label: 'Plans',
        href: 'https://cursor.com/pricing',
        note: 'Free and paid tiers, MCP, skills, hooks and cloud agents',
      },
    ],
    rows: [
      {
        capability: 'Execution surfaces',
        wrongstack:
          'Terminal CLI/TUI plus WebUI, Desktop and a project-independent HQ command center.',
        competitor:
          'Editor, CLI, web, mobile and cloud agents; integrations include Slack, Teams, Linear, Jira and GitHub.',
        difference:
          'Cursor has the broader managed end-user surface. WrongStack’s surfaces are open, self-hosted compositions of the same runtime.',
        competitorLevel: 'native',
      },
      {
        capability: 'Models and routing',
        wrongstack:
          'Users own provider credentials and can assign provider/model/runtime settings by exact role, phase or wildcard, with capacity-aware fallback.',
        competitor:
          'Cursor exposes multiple frontier models and its own Composer harness/models through the product model picker.',
        difference:
          'Cursor optimizes a managed multi-model editor experience. WrongStack makes provider and routing policy an operator-owned configuration surface.',
        competitorLevel: 'different',
      },
      {
        capability: 'Multi-agent execution',
        wrongstack:
          'Director runs role-specialized local workers with budgets, queue retargeting, lineage and Brain-gated supervision.',
        competitor:
          'Cloud subagents run in separate VMs and branches, can continue while the parent works, and can be handed between local and cloud.',
        difference:
          'Cursor’s isolated cloud environments are a major strength. WrongStack’s distinction is model/provider-neutral orchestration and visible operational policy around local or ACP workers.',
        competitorLevel: 'native',
      },
      {
        capability: 'Agent-to-agent communication',
        wrongstack:
          'Global Mailbox provides durable peer, leader, alias and broadcast messages across all live project surfaces.',
        competitor:
          'Parent agents can offload work to cloud subagents and sessions hand off between local/cloud clients. A peer mailbox was not verified in official docs.',
        difference:
          'Cursor emphasizes delegation and environment hand-off; WrongStack exposes communication itself as a programmable project primitive.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Work tracking',
        wrongstack:
          'Local Kanban/task queues, goals, SDD, todos and Director state stay within the open project runtime.',
        competitor:
          'cursor.com/agents provides a dashboard for multiple cloud tasks, and official guidance explicitly shows a Kanban-style view.',
        difference:
          'Both give parallel work a visual home. Cursor’s is cloud-agent delivery; WrongStack’s queue also governs local agents, modes, mail and spec evidence.',
        competitorLevel: 'native',
      },
      {
        capability: 'Decision governance',
        wrongstack:
          'Brain Arbiter and Fleet Supervisor create inspectable decision proposals with risk ceilings, deterministic policy and human escalation.',
        competitor:
          'Cloud agents use isolated VMs, hooks and team/enterprise controls for network, MCP, models and audit. No comparable decision arbiter was verified.',
        difference:
          'Cursor has strong managed infrastructure controls; WrongStack adds a model-independent reasoning layer for autonomous fleet choices.',
        competitorLevel: 'not-verified',
      },
      {
        capability: 'Memory and instructions',
        wrongstack:
          'SAGE stores scoped, anchored, quality-scored facts in a graph and automatically re-checks affected anchors after edits.',
        competitor:
          'Rules provide reusable scoped instructions, while Memories and cloud automation memory carry learnings between runs.',
        difference:
          'Both have real persistence. WrongStack emphasizes local inspectability, provenance and verification mechanics.',
        competitorLevel: 'native',
      },
      {
        capability: 'Extensions',
        wrongstack:
          'MCP, skills, hooks, plugins, prompts, ACP and providers are first-class runtime contracts with project/user trust boundaries.',
        competitor:
          'Current plans document MCP, skills, hooks and plugins; agents and automations can use MCP-backed tools.',
        difference:
          'Cursor extensions improve a managed editor/agent product. WrongStack extensions can replace or compose more of the runtime itself.',
        competitorLevel: 'native',
      },
      {
        capability: 'Operations and observability',
        wrongstack:
          'HQ maps every attached client and agent, overlays mailbox/Brain/fleet events, persists telemetry and exposes scoped commands.',
        competitor:
          'Cloud agent dashboards, artifacts, logs, screenshots, videos, remote desktop and enterprise audit controls provide rich managed visibility.',
        difference:
          'Cursor is stronger at reviewing what an isolated cloud worker produced. WrongStack HQ is stronger at seeing how a mixed local project fleet is coordinating.',
        competitorLevel: 'different',
      },
      {
        capability: 'Source and cost model',
        wrongstack: 'MIT licensed with no paid runtime tier or proprietary feature gate.',
        competitor:
          'Commercial product with a limited Hobby tier and paid Individual, Teams and Enterprise plans.',
        difference:
          'Cursor bundles models and managed infrastructure into a subscription. WrongStack is free software; provider usage can still cost money.',
        competitorLevel: 'different',
      },
    ],
  },
  {
    id: 'pi',
    name: 'Pi',
    maker: 'Earendil Works',
    mark: 'PI',
    accent: 'red',
    positioning:
      'A deliberately minimal terminal coding harness whose small core is meant to be reshaped through TypeScript extensions, skills, prompts, themes and packages.',
    strongestCase:
      'Choose Pi when minimalism is the feature: four default tools, direct terminal observability and a highly hackable SDK/extension surface without a prescribed workflow.',
    wrongStackCase:
      'Choose WrongStack when you want the batteries installed and governed already: MCP, permissions, roster, mailbox, Kanban, Brain, memory graph, six surfaces and HQ.',
    sources: [
      {
        label: 'Coding agent README',
        href: 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md',
        note: 'Providers, tools, sessions, extensions and explicit philosophy',
      },
      {
        label: 'Project repository',
        href: 'https://github.com/earendil-works/pi',
        note: 'Toolkit packages and MIT license',
      },
    ],
    rows: [
      {
        capability: 'Execution surfaces',
        wrongstack:
          'CLI, Ink TUI, browser WebUI, Electron Desktop and a separate React HQ dashboard.',
        competitor:
          'Terminal harness with interactive, print/JSON, RPC and SDK modes for embedding in other applications.',
        difference:
          'Pi is intentionally a small composable harness. WrongStack ships the end-user and operations surfaces as one product.',
        competitorLevel: 'different',
      },
      {
        capability: 'Models and routing',
        wrongstack:
          'Multi-provider models plus per-role/phase matrix, fallback profiles, runtime reasoning controls and provider failure recovery.',
        competitor:
          'Many built-in API-key and subscription providers, custom compatible providers and extension-defined provider/OAuth support.',
        difference:
          'Both are strongly provider-neutral. Pi keeps selection simple and extensible; WrongStack adds structured fleet routing and bounded fallback behavior.',
        competitorLevel: 'native',
      },
      {
        capability: 'Built-in tool surface',
        wrongstack: `${toolCatalog.length} documented tools cover files, shell, Git, browser, quality, dependencies, indexing, work state and agent coordination.`,
        competitor:
          'Four default tools: read, write, edit and bash. Additional capabilities come from skills, extensions or packages.',
        difference:
          'This is a philosophical split, not a missing checkbox: Pi minimizes core behavior; WrongStack standardizes a large production tool contract.',
        competitorLevel: 'different',
      },
      {
        capability: 'Multi-agent execution',
        wrongstack:
          'First-party Director, roster, structured results, budgets, mailbox, peer pulse, rebalancing and supervisor lifecycle.',
        competitor:
          'Official philosophy explicitly excludes subagents from core; users can spawn processes, build an extension or install a package.',
        difference:
          'WrongStack is fleet-first. Pi lets each user choose or invent the orchestration model.',
        competitorLevel: 'extension',
      },
      {
        capability: 'Work tracking',
        wrongstack:
          'Kanban, todos, goals, SDD trackers, task queues and checkpoints are built-in and visible across surfaces.',
        competitor:
          'Official philosophy explicitly excludes built-in todos and plan mode; files or extensions are the recommended path.',
        difference:
          'WrongStack prescribes interoperable work primitives. Pi deliberately avoids prescribing them.',
        competitorLevel: 'absent',
      },
      {
        capability: 'Permissions and safety',
        wrongstack:
          'Tool policy, explicit deny, hook validation, encrypted credentials, project-config allow-listing and audit logs are in the core runtime.',
        competitor:
          'Official philosophy excludes permission popups from core and recommends containers or extension-defined confirmation flows.',
        difference:
          'WrongStack embeds application-level safety policy. Pi expects environment isolation or a policy shaped by the user.',
        competitorLevel: 'extension',
      },
      {
        capability: 'MCP',
        wrongstack:
          'Native client registry supports stdio, SSE and streamable HTTP, OAuth, cached lazy tools and an MCP server mode.',
        competitor:
          'Official philosophy says no MCP in core; an extension can add MCP server integration.',
        difference:
          'WrongStack standardizes MCP lifecycle and permissions. Pi keeps protocol choice outside the core.',
        competitorLevel: 'extension',
      },
      {
        capability: 'Extensions',
        wrongstack:
          'Plugins declare tools, providers, slash commands, MCP and pipeline capabilities; skills, prompts and hooks have separate contracts.',
        competitor:
          'TypeScript extensions can add or replace tools, UI, providers, subagents, permissions, compaction and more; packages bundle extensions, skills, prompts and themes.',
        difference:
          'Pi may be the more radically hackable small core. WrongStack trades some minimalism for stable contracts and managed catalogs.',
        competitorLevel: 'native',
      },
      {
        capability: 'Memory and sessions',
        wrongstack:
          'Append-only reconstructable sessions, exclusive live-writer ownership, checkpoints, compaction and verified project memory graph.',
        competitor:
          'Sessions support resume, fork, tree navigation, branching, compaction, import/export and custom storage via SDK.',
        difference:
          'Pi has excellent conversation/session mechanics. WrongStack additionally separates durable verified project knowledge from transcript history.',
        competitorLevel: 'native',
      },
      {
        capability: 'Source and cost model',
        wrongstack: 'MIT licensed, open source and free; models remain bring-your-own.',
        competitor: 'MIT licensed, open source and free; models remain bring-your-own.',
        difference:
          'No license advantage either way. The decision is batteries-included operating system versus minimal extensible harness.',
        competitorLevel: 'native',
      },
    ],
  },
];

export const evidenceLabels: Record<EvidenceLevel, string> = {
  native: 'First-party',
  different: 'Different model',
  extension: 'Extension path',
  'not-verified': 'Not verified',
  absent: 'Explicitly absent',
};
