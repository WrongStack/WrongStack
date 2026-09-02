import type { CommandDetailMap } from './command-detail-types';

export const commandDetailsPart2: CommandDetailMap = {
  '/agents': {
    purpose:
      'Monitor agents, timeline events, and per-agent transcripts — the agent observability dashboard.',
    behavior:
      '`/agents` shows a list of all agents (leader + subagents) with status, current task, and last activity. `/agents show <id>` opens a detailed view. `/agents chat compact` shows a compacted transcript. `/agents timeline` shows an event chronology. The TUI panel provides live updates.',
    before: 'No preparation needed. Run it when you want to see what your fleet is doing.',
    during: 'The agent list prints with status indicators. Live agents show heartbeat timestamps.',
    after:
      'Terminate idle agents to free resources. Review transcripts for completed agents to extract results.',
  },

  '/agent-improve': {
    purpose:
      'Inspect and develop a roster agent for this project — what it has learned, which of its skills the project has extended, and when the next distillation runs.',
    behavior:
      '`/agent-improve` lists roles with project customization; `<role> show` summarizes its identity, learned directives and developed skills. `<role> capture` re-scans the last turn for `## LEARNED` blocks. `<role> optimize` distils captured directives into per-skill project addenda plus a consolidated role document, archives the raw buffer and resets it. `<role> skills` shows each skill with its project affinity; add a skill name to print its addendum, or `pin`/`unpin` to force it in or out of the eager load set.',
    before:
      'Nothing is required — capture and distillation run automatically. Reach for the command when you want to read what an agent has learned, teach it something directly, or force a pass early.',
    during:
      'Optimization synthesizes one document per developed skill and one for the role. With no model configured it still writes the skill addenda deterministically and routes the role document through the chat agent.',
    after:
      'The addendum is injected beneath that skill on the next spawn. Files live under `.wrongstack/agents/<role>/` and are committed, so the roster arrives trained on a fresh clone.',
  },

  '/director': {
    purpose:
      '(Obsolete — Director Mode is permanently on) Previously used to promote the session into Director orchestration mode.',
    behavior:
      'Director Mode is now always active. Fleet orchestration tools (spawn, assign, monitor, terminate) are available on every session without any command or flag. The `/director` slash command is a no-op that always succeeds.',
    before: 'No preparation needed — Director Mode is always on.',
    during: 'Fleet orchestration tools are available without any promotion step.',
    after: 'No action needed. Manage your fleet via /spawn, /fleet, /delegate, and /agents.',
  },

  '/delegate': {
    purpose:
      'Hand a bounded task to a specialist role — the simplest way to get parallel work done.',
    behavior:
      '`/delegate --role=<role> "task"` creates a subagent with the specified role, assigns the task, and waits for the result. It is a convenience wrapper around spawn + assign + await. You can also use smart dispatch by omitting the role and letting the system choose.',
    before:
      'Define a clear, self-contained task. Choose a role or trust the smart dispatcher to pick one.',
    during:
      'The delegate runs in the background. A status line shows progress. You can continue working in the REPL.',
    after:
      'The result appears when the delegate finishes. Review it, then the delegate terminates automatically.',
  },

  '/fleet': {
    purpose:
      'Inspect fleet status, budgets, logs, streams, retries, and workers — the full fleet operations surface.',
    behavior:
      '`/fleet` shows a snapshot of all subagents, coordinator counts, and pending tasks. `/fleet status` shows live state. `/fleet usage` shows token and cost breakdowns per agent. `/fleet health` shows budget pressure and activity. `/fleet dispatch` sends work to the fleet. `/fleet session <id>` reads agent transcripts.',
    before:
      'No preparation needed. Run it whenever you want visibility into your fleet operations.',
    during: 'Status output updates live. Usage reports show cumulative and per-agent breakdowns.',
    after:
      'Use `/fleet health` to identify agents near budget limits. Terminate idle agents to free resources.',
  },

  '/ensemble': {
    purpose:
      'Fan one task to multiple ACP-capable coding agents — get independent perspectives on the same problem.',
    behavior:
      'The command sends the same task to multiple installed ACP agents (Claude Code, Codex CLI, Gemini CLI, etc.) in parallel. Each agent works independently with its own tools and context. Results are collected and presented side by side for comparison or voting.',
    before:
      'Install and configure the ACP agents you want to use. Verify they are discoverable with `/acp probe`.',
    during: 'Each agent runs in parallel. Progress indicators show which agents are still working.',
    after:
      'Compare results. Ensemble works best for review tasks, architecture decisions, and solution comparison.',
  },

  '/collab': {
    purpose:
      'Start structured live collaboration helpers — BugHunter, RefactorPlanner, and Critic run in parallel on target files.',
    behavior:
      'The collaboration workflow spawns three specialist agents simultaneously: BugHunter scans for bugs, RefactorPlanner proposes improvements, and Critic evaluates both. Events flow between them on the FleetBus. The final report aggregates findings with an overall verdict.',
    before: 'Identify the target files or directories. Narrow scope for faster results.',
    during:
      'Agents emit events on the FleetBus as they find issues. The Critic evaluates in real time.',
    after: 'Review the structured report. Address bugs first, then consider refactor suggestions.',
  },

  '/brain': {
    purpose:
      'Inspect the decision arbiter, ask it a question, or set its risk ceiling — the Brain governs high-stakes fleet decisions.',
    behavior:
      'The Brain agent evaluates risky fleet actions (spawning, tool approval escalation, worktree creation) against configurable risk thresholds. `/brain` shows current settings. `/brain ask "..."` queries the Brain for a decision recommendation. `/brain risk <level>` sets the risk ceiling.',
    before:
      'Understand the Brain role in your fleet. It acts as a safety gate, not a replacement for your judgment.',
    during:
      'Brain queries return a decision with reasoning. Risk level changes apply immediately to future decisions.',
    after:
      'Monitor Brain decisions in the fleet event log. Adjust the risk ceiling if it is too conservative or permissive.',
  },

  '/coordinator': {
    purpose:
      'Control multi-session autonomous goal coordination — let goals persist and progress across terminal sessions.',
    behavior:
      'The Coordinator tracks goals across sessions. When you close a terminal and resume later, the Coordinator picks up the goal and continues. `/coordinator status` shows active goals. `/coordinator pause` suspends cross-session tracking. `/coordinator resume` reactivates it.',
    before:
      'Set a goal with `/goal set` first. The Coordinator only manages goals that have been explicitly created.',
    during:
      'The Coordinator runs in the background, tracking goal progress across session boundaries.',
    after:
      'Use `/coordinator status` to confirm goals are being tracked. Clear completed goals to free coordinator resources.',
  },

  '/mailbox': {
    purpose:
      'Read and send cross-agent project mailbox messages — the inter-agent communication hub.',
    behavior:
      'The project mailbox is a shared message store for all agents working on the same project. `/mailbox` shows unread messages. `/mailbox send` sends a typed message (note, ask, assign, steer, broadcast, etc.). `/mailbox query` filters messages. Messages support priorities, read receipts, and completion tracking.',
    before:
      'Check `/mailbox` when starting work to see if other agents have left messages or assignments for you.',
    during: 'Unread messages appear inline. Sending confirms with a message ID.',
    after:
      'Acknowledge completed assignments with `/mailbox ack`. Broadcast milestones so peers avoid duplicate work.',
  },

  '/mailbox-demo': {
    purpose:
      'Exercise mailbox routing during development — test message delivery, read receipts, and agent registration.',
    behavior:
      'A development-only command that simulates mailbox traffic: sends test messages, verifies delivery, tests read receipts, and exercises agent registration/heartbeat flows. Useful when building or debugging mailbox integrations.',
    before: 'Ensure the mailbox bridge or local mailbox is running.',
    during: 'Test messages flow through the mailbox. Results show delivery status and timing.',
    after: 'Review the demo output for any failures. All demo messages are marked as test traffic.',
  },

  '/mailbox-serve': {
    purpose:
      'Expose the project mailbox through its HTTP bridge — let external agents (Claude Code, scripts, CI) participate.',
    behavior:
      'The command starts a loopback HTTP server that forwards to the project-owned RemoteMailbox over local IPC. External agents can send/receive messages via REST endpoints using a bearer token; they never open SQLite directly. The server prints its bind URL and writes the token to `.mailbox.token`. External agents appear in the WebUI with `source: http`.',
    before:
      'Ensure the project is initialized. The bridge binds to loopback by default — safe for local development.',
    during:
      'The server prints its URL and routes. Press Ctrl+C to stop. Heartbeat from external agents keeps them visible.',
    after:
      'Stop the bridge when external coordination is complete. The token file is cleaned up on shutdown.',
  },

  '/shadow': {
    purpose:
      'Start and manage a shadow fleet monitor — a background agent that watches fleet health and detects anomalies.',
    behavior:
      'The Shadow Agent runs silently, checking fleet heartbeats, detecting stuck agents, tracking spike tasks (agents that start and die quickly), and monitoring mailbox traffic. `/shadow start` activates it. `/shadow status` shows its current snapshot. `/shadow stop` deactivates it. It can auto-intervene if configured.',
    before: 'Decide whether you want automatic intervention or observation-only mode.',
    during:
      'The Shadow runs on a cron schedule. Its findings appear as status events in the mailbox.',
    after:
      'Review Shadow reports periodically. Address stuck agents and investigate spike patterns.',
  },

  '/supervisor': {
    purpose:
      'Inspect or configure the Brain-gated Fleet Supervisor — the safety layer that approves or blocks fleet actions.',
    behavior:
      'The Supervisor sits between the Director and the fleet, evaluating every spawn, assign, and tool escalation against Brain risk thresholds. `/supervisor status` shows current state. `/supervisor on` enables it. `/supervisor off` disables it (not recommended for production work).',
    before:
      'Understand the risk implications of disabling the Supervisor. It prevents runaway fleet behavior.',
    during: 'Status shows recent decisions: approved, blocked, and escalated actions.',
    after:
      'Review blocked actions to understand why they were rejected. Adjust Brain risk levels if the Supervisor is too strict.',
  },

  '/acp': {
    purpose:
      'Discover and run installed ACP coding agents using their existing logins — no extra API keys needed.',
    behavior:
      'ACP (Agent Communication Protocol) lets WrongStack drive external coding agents like Claude Code, Codex CLI, and Gemini CLI. `/acp` lists discovered agents. `/acp probe` tests connectivity. `/acp <agent> "task"` sends work to a specific agent. `/acp parallel a,b "task"` fans to multiple.',
    before:
      'Install the ACP agents you want to use. Run `/acp probe` to verify they are reachable.',
    during:
      'The external agent runs with its own tools and context. Progress is streamed back to WrongStack.',
    after: 'Review the external agent output. Results are captured in the session transcript.',
  },

  '/hq': {
    purpose:
      'Inspect and control HQ Command Center connectivity for the current surface — connect to remote orchestration.',
    behavior:
      'The HQ Command Center provides a web-based fleet control panel. `/hq` shows connection status. `/hq connect <url>` links to an HQ server. `/hq disconnect` severs the link. When connected, HQ operators can send prompts, steer agents, and monitor fleet status through the web UI.',
    before:
      'Have the HQ server URL ready. Ensure network access and authentication are configured.',
    during:
      'Connection status updates live. HQ prompts appear in your mailbox as steer/btw/queue messages.',
    after:
      'Monitor HQ prompts in your mailbox. Disconnect when you no longer need remote orchestration.',
  },

  '/mode': {
    purpose:
      'Switch the session persona — choose from 19 built-in modes including lite, deep, and specialist workflows.',
    behavior:
      'WrongStack ships 19 persona modes: brief, code-reviewer, bug-hunter, refactor-planner, security-scanner, and more. `/mode` lists all modes. `/mode <name>` switches immediately. Each mode adjusts the system prompt, tool preferences, and output style. This is independent from `/context mode` and `/autonomy`.',
    before:
      'Review available modes with `/mode list`. Choose one that matches your current task type.',
    during:
      'The mode switch applies immediately. The next agent turn uses the new persona system prompt.',
    after:
      'Verify the agent behavior matches the mode expectations. Switch back to a general mode when the specialist task is done.',
  },

  '/setmodel': {
    purpose:
      'Set the leader model or role/phase model routing matrix — choose which AI model powers which agent.',
    behavior:
      '`/setmodel <model-id>` changes the model for the current session. You can also set per-role models: `/setmodel --role=security-scanner <model-id>`. `/setmodel --reset` clears custom assignments. Model changes take effect on the next agent turn. Some models have different pricing, speed, and capability profiles.',
    before:
      'Check available models with `/models` or `/modelcaps`. Consider cost, speed, and capability tradeoffs.',
    during:
      'The new model assignment prints for confirmation. Per-role overrides show in a routing table.',
    after:
      'Monitor the first few responses from the new model. Switch back if the quality or style does not match expectations.',
  },

  '/models': {
    purpose:
      'Manage custom model definitions — add, remove, and configure model entries beyond the built-in catalog.',
    behavior:
      '`/models` lists all configured models (built-in + custom). `/models add` registers a new model with provider, context window, pricing, and capability metadata. `/models remove` deletes a custom entry. Custom models appear in `/setmodel` and `/modelcaps` alongside built-ins.',
    before:
      'Have the model metadata ready: provider name, model ID, context window size, and pricing if known.',
    during: 'Custom model registration validates the metadata and adds it to the registry.',
    after: 'Verify the new model appears in `/modelcaps` and can be selected with `/setmodel`.',
  },

  '/modelcaps': {
    purpose:
      'Browse model context, capability, and pricing information — compare models before choosing one.',
    behavior:
      'The command prints a browsable table of all registered models with columns: provider, context window, max output tokens, pricing (input/output per 1M tokens), capabilities (vision, reasoning, tool use), and status. Custom models added via `/models` appear alongside built-ins.',
    before: 'No preparation needed. Run it when deciding which model to use for a task.',
    during:
      'The table prints with sortable columns. Use search to filter by provider or capability.',
    after:
      'Select a model with `/setmodel <id>`. Consider using cheaper models for simple tasks and premium models for complex work.',
  },

  '/yolo': {
    purpose:
      'Query or toggle automatic tool approval for this session — skip permission prompts when you trust the agent.',
    behavior:
      'By default, tools require confirmation before execution. `/yolo` enables automatic approval — the agent runs tools without asking. `/yolo off` restores confirmations. `/yolo` without arguments shows the current state. YOLO mode is session-scoped and resets on restart. Explicit deny rules still apply.',
    before:
      'Only enable YOLO when you fully trust the agent and the working directory. Review the permission policy first.',
    during: 'The status line updates to show YOLO is active. Tools execute without prompting.',
    after:
      'Monitor agent actions more closely in YOLO mode. Disable it when you need to review each step.',
  },

  '/settings': {
    purpose:
      'View or change live runtime settings — the unified configuration surface for all WrongStack behavior.',
    behavior:
      '`/settings` prints all current settings grouped by category. `/settings get <key>` reads a specific value. `/settings set <key> <value>` changes it. Settings can be session-only or persisted. The command validates values against expected types and ranges. Use it instead of editing config files directly.',
    before:
      'Check current values with `/settings get <key>` before changing. Some settings have interdependencies.',
    during:
      'Get returns the value immediately. Set validates and applies the change, printing the new effective value.',
    after:
      'Verify the change with `/settings get <key>`. Run `/diag` if the change does not seem to take effect.',
  },

  '/statusline': {
    purpose:
      'Choose which TUI status-bar instruments are visible — customize the information density of your terminal UI.',
    behavior:
      'The TUI status line shows mode, model, token usage, goal, YOLO state, and more. `/statusline` lists available instruments. `/statusline <instrument> on|off` toggles visibility. You can create a minimal bar for focus or a dense bar for full situational awareness.',
    before:
      'Decide which information you need visible at all times vs. what you can check on demand.',
    during: 'The status bar updates immediately. Changes persist for the session.',
    after:
      'Observe the status bar for a few turns. Adjust if it feels too sparse or too cluttered.',
  },

  '/fallback': {
    purpose:
      'Inspect and configure fallback model behavior — define what happens when the primary model fails or times out.',
    behavior:
      'Fallback chains let you specify backup models. `/fallback` shows the current chain. `/fallback add <model>` appends a fallback. `/fallback remove <model>` removes one. When the primary model errors, times out, or exceeds budget, the next fallback in the chain is tried automatically.',
    before:
      'Identify reliable backup models. Fallbacks should have different failure characteristics than the primary.',
    during: 'The chain prints in order. Fallback events are logged when they activate.',
    after:
      'Monitor fallback usage in `/stats`. Frequent fallbacks suggest the primary model is unreliable for your workload.',
  },
};
