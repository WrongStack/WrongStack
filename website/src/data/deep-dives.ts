import type { CommandCategory } from './content';

export type FeatureDeepDive = {
  promise: string;
  mechanism: Array<{ title: string; body: string; code: string }>;
  operatorNotes: string[];
  signals: Array<{ label: string; value: string }>;
};

export const featureDeepDives: Record<string, FeatureDeepDive> = {
  'tool-execution': {
    promise:
      'A tool call should be understandable before it runs, observable while it runs and interruptible until the last safe write boundary.',
    mechanism: [
      {
        title: 'Repair streamed arguments',
        body: 'Provider adapters parse partial or malformed JSON through a bounded repair ladder before handing input to the executor.',
        code: 'parse → strip fence → sanitize → complete → salvage',
      },
      {
        title: 'Run lifecycle hooks',
        body: 'Mutating PreToolUse hooks compose first. Validation-stage hooks see the final input and may deny it, but cannot rewrite it.',
        code: 'mutate hooks → validate hooks',
      },
      {
        title: 'Validate and govern',
        body: 'JSON Schema validation gets one lossless coercion pass. The permission policy then resolves auto, confirm or deny.',
        code: 'schema → coercion → permission policy',
      },
      {
        title: 'Execute with a signal',
        body: 'The run signal and per-tool timeout are combined. Subprocesses, file walks, mutators and MCP calls all receive cancellation.',
        code: 'AbortSignal.any(run, timeout)',
      },
      {
        title: 'Publish progress',
        body: 'Streaming tools emit logs, partial output, metrics, changed files and warnings before one final result.',
        code: 'tool.progress × n → final',
      },
    ],
    operatorNotes: [
      'Use smart batching unless ordering is part of correctness.',
      'Treat an explicit deny as a hard boundary, including in YOLO.',
      'A repeated identical call is a signal to inspect the loop detector, not raise iteration limits immediately.',
    ],
    signals: [
      { label: 'Strategies', value: 'smart · parallel · sequential' },
      { label: 'Loop mode', value: 'steer-then-cut' },
      { label: 'Progress', value: '6 event shapes' },
    ],
  },
  'sessions-and-memory': {
    promise:
      'The model may forget old tokens; the project should not forget verified facts, decisions or what changed on disk.',
    mechanism: [
      {
        title: 'Record reconstructable events',
        body: 'The live session writer serializes user input, model output, tool results, checkpoints and in-flight markers into append-only JSONL.',
        code: 'agent.ctx.session → FIFO writeChain',
      },
      {
        title: 'Compact live context',
        body: 'Hybrid, intelligent or selective compactors reshape the model window while the raw session log remains untouched.',
        code: 'live messages ≠ audit history',
      },
      {
        title: 'Retrieve relevant memory',
        body: 'SAGE scores project-local facts against the current request and injects only novel, bounded context.',
        code: 'query → graph expansion → score → cap',
      },
      {
        title: 'Re-verify after changes',
        body: 'Write, edit, replace and patch operations trigger hygiene for anchors affected by the changed path.',
        code: 'file_changed → anchor verification',
      },
      {
        title: 'Recover deliberately',
        body: 'Resume repairs tool adjacency and uses in-flight markers to distinguish a clean stop from an interrupted turn.',
        code: 'replay → repair → resume',
      },
    ],
    operatorNotes: [
      'Use memory for stable project facts, not transient task chatter.',
      'Use checkpoints for reversible file state and sessions for conversational continuity.',
      'Compaction is normal operation; it is not data deletion.',
    ],
    signals: [
      { label: 'Session format', value: 'date-sharded JSONL' },
      { label: 'Memory store', value: '.wrongstack/memories' },
      { label: 'Scopes', value: 'project · user · session' },
    ],
  },
  'multi-agent-fleet': {
    promise:
      'Parallel work needs ownership, budgets and structured results—not merely several prompts running at once.',
    mechanism: [
      {
        title: 'Plan bounded tasks',
        body: 'The Director converts work into task records with dependencies, target roles and authoritative lineage.',
        code: 'objective → task DAG',
      },
      {
        title: 'Route a specialist',
        body: 'Roster role, role phase and model matrix decide the worker prompt, provider, model and fallback profile.',
        code: 'role → phase → * → leader',
      },
      {
        title: 'Negotiate budgets',
        body: 'Iterations, tool calls, tokens, cost and timeout are tracked independently; thresholds can request explicit extension.',
        code: 'threshold_reached → extend | deny',
      },
      {
        title: 'Share live state',
        body: 'Fleet events, pulse digests, status broadcasts and the mailbox keep the leader and workers aware of relevant peers.',
        code: 'FleetBus + Project Mailbox',
      },
      {
        title: 'Roll up evidence',
        body: 'Structured submit_result reports carry findings, files and confidence back to the leader without transcript scraping.',
        code: 'TaskResult.report → roll_up',
      },
    ],
    operatorNotes: [
      'Delegate work that can be verified independently.',
      'Prefer waiting for any result when one early answer can unblock the plan.',
      'Retarget pending work; running tasks should be steered or terminated explicitly.',
    ],
    signals: [
      { label: 'Default concurrency', value: '4 workers' },
      { label: 'Depth ceiling', value: '2' },
      { label: 'Result cap', value: '8K structured report' },
    ],
  },
  'provider-resilience': {
    promise:
      'A temporary provider failure should not become duplicated retries, random rerouting or a misleading authentication error.',
    mechanism: [
      {
        title: 'Classify once',
        body: 'Status, type and message heuristics live in classifyProviderError and produce one stable ProviderError.kind.',
        code: 'HTTP failure → ProviderError.kind',
      },
      {
        title: 'Retry in place',
        body: 'The retry policy chooses attempts by kind and uses Retry-After when available before exponential jitter.',
        code: 'same provider · same model',
      },
      {
        title: 'Hop the fallback chain',
        body: 'Only capacity and transport kinds move across configured providers after the current provider exhausts retries.',
        code: 'rate_limit | overloaded | server | transport',
      },
      {
        title: 'Apply one recovery strategy',
        body: 'Overflow compacts, capacity may downgrade and content filtering may reroute to a close-cost sibling.',
        code: 'one strategy per kind',
      },
      {
        title: 'Bound re-entry',
        body: 'A recovery retry re-enters retry and fallback layers, but the whole recovery cycle is capped.',
        code: 'recoveryRetries ≤ 2',
      },
    ],
    operatorNotes: [
      'Do not add a fallback to hide invalid requests or bad credentials.',
      'A cross-provider hop gets its own in-place retry cycle.',
      'Cooldown and half-open probing prevent the primary from being hammered.',
    ],
    signals: [
      { label: 'Error kinds', value: '11 classified kinds' },
      { label: 'Layer order', value: 'retry → fallback → recovery' },
      { label: 'Recovery cap', value: '2' },
    ],
  },
  'brain-and-autonomy': {
    promise:
      'Autonomous systems need one visible decision layer that can enforce a live human-defined risk ceiling.',
    mechanism: [
      {
        title: 'Deterministic policy first',
        body: 'DefaultBrainArbiter handles known decisions without model cost or ambiguity.',
        code: 'rule tier',
      },
      {
        title: 'Optional model judgment',
        body: 'The autonomy Brain receives only decisions allowed by the current risk ceiling and must return an exact option id.',
        code: '{ optionId, rationale }',
      },
      {
        title: 'Escalate to a human',
        body: 'Interactive hosts can queue ask-human decisions and render them in the TUI instead of silently denying.',
        code: 'BrainDecisionQueue',
      },
      {
        title: 'Observe the chain',
        body: 'ObservableBrainArbiter emits requested, resolved and denied events to TUI, WebUI and HQ.',
        code: 'brain.decision_*',
      },
      {
        title: 'Intervene on storms',
        body: 'BrainMonitor watches repeated tool failures and clustered errors, then sends a high-priority steering message.',
        code: 'signal → Brain → steer mail',
      },
    ],
    operatorNotes: [
      'Set the risk ceiling for the session you are actually running.',
      'Exact option ids prevent “do not spawn” from being interpreted as spawn.',
      'The Brain governs decisions; it does not replace tool permissions.',
    ],
    signals: [
      { label: 'Risk levels', value: 'off · low · medium · high · all' },
      { label: 'Default ceiling', value: 'medium' },
      { label: 'Storm cooldown', value: '120s' },
    ],
  },
  'model-routing': {
    promise:
      'Use expensive reasoning where it changes the outcome and faster models where the task is bounded and verifiable.',
    mechanism: [
      {
        title: 'Resolve the leader',
        body: 'Provider, model, credentials and runtime controls establish the default request path.',
        code: 'provider + model + modelRuntime',
      },
      {
        title: 'Match an exact role',
        body: 'A named specialist route wins when modelMatrix contains that role.',
        code: 'modelMatrix[role]',
      },
      {
        title: 'Fall back to phase',
        body: 'If no exact role exists, the current workflow phase may supply a model or reasoning override.',
        code: 'modelMatrix[phase]',
      },
      {
        title: 'Use wildcard defaults',
        body: 'The wildcard route sets fleet-wide defaults without changing the leader model.',
        code: 'modelMatrix["*"]',
      },
      {
        title: 'Apply fallback profiles',
        body: 'Named profiles keep ordered chains reusable across roles and phases.',
        code: 'route.fallbackProfile → fallbackProfiles',
      },
    ],
    operatorNotes: [
      'A route can override reasoning while inheriting the leader model.',
      'Keep explicit fallbacks for known production paths; use automatic derivation as a safety net.',
      'Favorite-model restrictions affect automatic derivation, not explicit chains.',
    ],
    signals: [
      { label: 'Precedence', value: 'role → phase → * → leader' },
      { label: 'Catalog', value: 'models.dev' },
      { label: 'Credentials', value: 'API key or OAuth' },
    ],
  },
  'agent-workflow': {
    promise:
      'A large objective should become inspectable state, bounded phases and verifiable completion—not an increasingly long prompt.',
    mechanism: [
      {
        title: 'Capture the objective',
        body: 'Goal commands convert the operator intent into steering text and durable workflow state for the active session.',
        code: 'objective → goal state → runText',
      },
      {
        title: 'Make work visible',
        body: 'Todos and plans expose current, pending and completed steps so both the operator and the model know what remains.',
        code: 'todo + PlanStore',
      },
      {
        title: 'Choose a workflow',
        body: 'SDD connects specification, tasks and evidence; Goal advances through staged work; autonomy handles longer session loops.',
        code: 'goal → SDD | Goal | autonomy',
      },
      {
        title: 'Steer in band',
        body: 'BTW, enhance and explicit steering add information to the live run without silently replacing the original objective.',
        code: 'operator context → next iteration',
      },
      {
        title: 'Finish with evidence',
        body: 'The workflow resolves only after relevant tools, checks, diffs and structured results support the claimed outcome.',
        code: 'execution → verification → summary',
      },
    ],
    operatorNotes: [
      'Use a plan when order matters; use a Kanban board when work must survive sessions or be shared.',
      'A runText result becomes the next user turn, so it remains visible in the session record.',
      'Pause or stop autonomous workflows explicitly before switching objectives.',
    ],
    signals: [
      { label: 'Workflow state', value: 'goals · todos · plans' },
      { label: 'Structured mode', value: 'SDD' },
      { label: 'Phase engine', value: 'Goal' },
    ],
  },
  'code-intelligence': {
    promise:
      'The agent should find the smallest relevant code surface before reading broadly or proposing a change.',
    mechanism: [
      {
        title: 'Map structure quickly',
        body: 'Tree and glob narrow packages, file types and likely ownership boundaries without loading file contents.',
        code: 'tree + glob → candidate paths',
      },
      {
        title: 'Search exact evidence',
        body: 'Grep finds symbols, messages and call sites with path and line context while observing cancellation during long walks.',
        code: 'pattern → ranked matches',
      },
      {
        title: 'Retrieve semantically',
        body: 'The codebase index adds project-wide retrieval when naming differs or a concept spans several packages.',
        code: 'index query → relevant chunks',
      },
      {
        title: 'Ask the language server',
        body: 'The optional LSP bridge supplies diagnostics, definition targets and language-specific semantic knowledge.',
        code: '/lsp:start → diag | goto',
      },
      {
        title: 'Confirm the dependency path',
        body: 'Read the defining file and its consumers before editing, then use quality tools to validate the inferred boundary.',
        code: 'definition → references → focused edit',
      },
    ],
    operatorNotes: [
      'Prefer exact search before semantic search when you have a symbol or error string.',
      'Index results are leads; source files and tests remain the evidence.',
      'Start the LSP only for languages where semantic diagnostics materially help the task.',
    ],
    signals: [
      { label: 'Structural tools', value: 'tree · glob · grep' },
      { label: 'Persistent layer', value: 'codebase index' },
      { label: 'Semantic layer', value: 'LSP bridge' },
    ],
  },
  'quality-system': {
    promise:
      'Every meaningful code claim should be backed by a proportional check whose output remains attached to the run.',
    mechanism: [
      {
        title: 'Select the narrow gate',
        body: 'The agent starts with the smallest relevant test, typecheck target, lint scope or format check.',
        code: 'changed surface → focused check',
      },
      {
        title: 'Stream the evidence',
        body: 'Long-running validation emits progress and remains cancellable through the standard tool execution contract.',
        code: 'quality tool → progress × n → final',
      },
      {
        title: 'Broaden by risk',
        body: 'Package and repository-level gates follow when public types, shared infrastructure or cross-package behavior changed.',
        code: 'focused → package → repository',
      },
      {
        title: 'Audit supply and security',
        body: 'Dependency auditing and security dispatch cover risks that functional tests cannot prove absent.',
        code: 'dependencies + threat surface',
      },
      {
        title: 'Report failures honestly',
        body: 'A failing check is preserved with its scope and cause instead of being hidden behind a generic completion message.',
        code: 'result + limitation + next action',
      },
    ],
    operatorNotes: [
      'Match verification cost to the blast radius of the change.',
      'Formatting is not a substitute for linting, and linting is not a substitute for tests.',
      'Keep pre-existing failures separate from regressions introduced by the task.',
    ],
    signals: [
      { label: 'Core gates', value: 'test · typecheck · lint' },
      { label: 'Hygiene', value: 'format · dependency audit' },
      { label: 'Extended review', value: 'security dispatch' },
    ],
  },
  'coordination-system': {
    promise:
      'Every participant should know its identity, owned task, current peers and the exact channel used to return evidence.',
    mechanism: [
      {
        title: 'Create authoritative identity',
        body: 'The host assigns session-unique leader and worker ids plus lineage; model output cannot invent ownership.',
        code: 'session tag + agent id + lineage',
      },
      {
        title: 'Assign bounded work',
        body: 'Director tasks carry dependencies, specialist roles, budgets and expected structured output.',
        code: 'task DAG → worker assignment',
      },
      {
        title: 'Exchange typed messages',
        body: 'Mailbox and FleetBus carry tasks, status, steer instructions, findings and results across processes and surfaces.',
        code: 'mailbox + FleetBus',
      },
      {
        title: 'Maintain peer awareness',
        body: 'Pulse digests, status broadcasts and fleet_status expose relevant liveness without copying entire transcripts.',
        code: 'events → compact peer snapshot',
      },
      {
        title: 'Rebalance safely',
        body: 'Only pending work can be retargeted. Running work requires an explicit steer or termination action.',
        code: 'pending → retarget | running → steer',
      },
    ],
    operatorNotes: [
      'Choose mailbox for durable cross-session coordination and FleetBus for live task-pipeline events.',
      'A status message informs; a steer message changes current work.',
      'Structured submit_result reports are more reliable than transcript scraping.',
    ],
    signals: [
      { label: 'Ownership', value: 'Director task + lineage' },
      { label: 'Durable channel', value: 'Project Mailbox' },
      { label: 'Live channel', value: 'FleetBus' },
    ],
  },
  'context-management': {
    promise:
      'The model window should remain useful under long sessions while the durable record remains complete and reconstructable.',
    mechanism: [
      {
        title: 'Estimate before sending',
        body: 'A shared token estimator uses observed provider usage to calibrate the size of future requests.',
        code: 'messages → estimate → calibrated ratio',
      },
      {
        title: 'Apply an operating mode',
        body: 'Balanced, frugal, deep and archival modes adjust how aggressively context is preserved or reduced.',
        code: 'context.mode',
      },
      {
        title: 'Compact by strategy',
        body: 'Hybrid is lossless and rule-based; intelligent summarizes; selective chooses content to retain or collapse.',
        code: 'hybrid | intelligent | selective',
      },
      {
        title: 'Repair tool adjacency',
        body: 'After context surgery, orphan tool-use and tool-result blocks are removed so provider requests remain valid.',
        code: 'compact → repairToolUseAdjacency',
      },
      {
        title: 'Recover from overflow',
        body: 'A classified context_overflow invokes its single recovery strategy, compacts and retries within the recovery cap.',
        code: 'overflow → compact → retry',
      },
    ],
    operatorNotes: [
      'Compaction changes the live provider context, not the append-only session log.',
      'Use archival only when long-history retention is worth the larger request.',
      'Custom endpoints may need an explicit effective context limit.',
    ],
    signals: [
      { label: 'Modes', value: '4' },
      { label: 'Strategies', value: '3' },
      { label: 'Default', value: 'balanced + hybrid' },
    ],
  },
  observability: {
    promise:
      'Operators should be able to explain what happened across the agent, tools, fleet and providers without enabling noisy telemetry by default.',
    mechanism: [
      {
        title: 'Publish typed events',
        body: 'The EventMap defines lifecycle events for sessions, providers, tools, compaction, fleets, Brain decisions and errors.',
        code: 'runtime action → EventBus',
      },
      {
        title: 'Project into surfaces',
        body: 'CLI, TUI, WebUI and HQ translate the same events into local views without moving UI dependencies into core.',
        code: 'EventBus → surface bridge',
      },
      {
        title: 'Enable telemetry explicitly',
        body: 'Metrics, traces and health registries use no-op defaults until the operator enables an exporter or endpoint.',
        code: '--metrics + OTel + HealthRegistry',
      },
      {
        title: 'Protect content boundaries',
        body: 'Tool events and session writes truncate oversized payloads; HQ publishing applies its configured content policy.',
        code: 'event → truncate | redact → publish',
      },
      {
        title: 'Alert on transitions',
        body: 'HQ evaluates aggregate state on an interval and emits alerts only when state changes, preventing repeated noise.',
        code: 'snapshot → state transition → alert',
      },
    ],
    operatorNotes: [
      'Start with health and event views; add traces when you need request-level causality.',
      'Raw content publishing is a separate privacy decision from operational metrics.',
      'Use stable event kinds instead of parsing rendered terminal output.',
    ],
    signals: [
      { label: 'Sources', value: 'typed EventMap' },
      { label: 'Export', value: 'Prometheus · OTLP' },
      { label: 'Command center', value: 'HQ :3499' },
    ],
  },
  persistence: {
    promise:
      'Conversation history, reversible file state and verified project knowledge should be durable without being conflated.',
    mechanism: [
      {
        title: 'Serialize the session',
        body: 'One live writer appends the core reconstruct set through a FIFO chain and closes exactly once.',
        code: 'Context.session → JSONL',
      },
      {
        title: 'Mark in-flight work',
        body: 'Start and end markers distinguish interrupted turns from a clean trailing session_end during recovery.',
        code: 'in_flight_start → work → in_flight_end',
      },
      {
        title: 'Checkpoint file state',
        body: 'Checkpoints preserve a reversible project moment independently from the conversational session timeline.',
        code: 'working tree → checkpoint',
      },
      {
        title: 'Replay or rewind deliberately',
        body: 'Session readers query, search and replay historical events while rewind operations change the chosen live state.',
        code: 'session events → replay | rewind',
      },
      {
        title: 'Store verified knowledge',
        body: 'SAGE preserves project facts, anchors and graph relations with deduplication and file-change hygiene.',
        code: 'fact → verify → memory graph',
      },
    ],
    operatorNotes: [
      'Sessions answer what happened; checkpoints restore files; memory answers what remains true.',
      'A save flushes the writer and does not end an active session.',
      'Live-session deletion is guarded across processes.',
    ],
    signals: [
      { label: 'Session store', value: 'date-sharded JSONL' },
      { label: 'Recovery', value: 'in-flight markers' },
      { label: 'Knowledge', value: 'SAGE graph' },
    ],
  },
  extensibility: {
    promise:
      'New capabilities should plug into documented contracts while the kernel remains provider-, interface- and plugin-agnostic.',
    mechanism: [
      {
        title: 'Add remote tools with MCP',
        body: 'Stdio, SSE and streamable HTTP servers expose tools behind registry-managed connection and cancellation behavior.',
        code: 'MCP server → mcp__server__tool',
      },
      {
        title: 'Add reusable knowledge with skills',
        body: 'Project and user SKILL.md packages load by priority and can inject eagerly or progressively on demand.',
        code: 'skill manifest → body + resources',
      },
      {
        title: 'Compose runtime capabilities',
        body: 'Plugins declare tools, providers, commands, MCP and pipeline capabilities before setup receives a scoped API.',
        code: 'manifest → scoped plugin API',
      },
      {
        title: 'Steer lifecycle with hooks',
        body: 'Command, HTTP and in-process hooks can mutate or deny at defined lifecycle points without bypassing permissions.',
        code: 'hook outcome → allow | mutate | deny',
      },
      {
        title: 'Add provider adapters',
        body: 'A provider translates one wire protocol into the common streaming, tool-use, usage and classified-error contract.',
        code: 'vendor wire ↔ Provider interface',
      },
    ],
    operatorNotes: [
      'Use a skill for knowledge, MCP for external tools and a plugin for in-process composition.',
      'Declare the narrowest capabilities an extension actually needs.',
      'Keep provider-specific concepts out of the core lifecycle.',
    ],
    signals: [
      { label: 'Remote tools', value: 'MCP' },
      { label: 'Knowledge packs', value: 'skills + prompts' },
      { label: 'Runtime extension', value: 'plugins + hooks' },
    ],
  },
  'global-mailbox': {
    promise:
      'Agents in different sessions and interfaces should exchange durable, typed messages without sharing mutable model context.',
    mechanism: [
      {
        title: 'Register a live identity',
        body: 'Each process registers session-unique agent ids, roles, surface source and current work in the project registry.',
        code: 'leader@session-tag + heartbeat',
      },
      {
        title: 'Address exact or broad recipients',
        body: 'A unique id targets one agent, a bare base alias reaches matching live identities, and * broadcasts project-wide.',
        code: 'agent@tag | leader | *',
      },
      {
        title: 'Send typed intent',
        body: 'Note, ask, assign, steer, BTW, status, result, review and control messages state how the receiver should treat the payload.',
        code: 'type + subject + body + priority',
      },
      {
        title: 'Track the lifecycle',
        body: 'Per-recipient receipts, completion outcomes, replies, expiry and restorable soft deletes preserve operational meaning.',
        code: 'unread → read → completed | expired',
      },
      {
        title: 'Stay safe across processes',
        body: 'Every client uses RemoteMailbox over a deterministic local endpoint; one elected owner serializes SQLite messages, receipts, presence, credentials and retention.',
        code: 'RemoteMailbox → IPC owner → _mailbox.sqlite',
      },
    ],
    operatorNotes: [
      'Use steer for a live behavior change and BTW for non-urgent context.',
      'Status broadcasts are coalesced and rate-capped so awareness does not flood context.',
      'Stale identities are pruned after missed heartbeats; durable messages remain independently queryable.',
    ],
    signals: [
      { label: 'Scope', value: 'one project · all surfaces' },
      { label: 'Message types', value: '10 typed intents' },
      { label: 'Presence', value: 'heartbeat + stale pruning' },
    ],
  },
  'kanban-work-queue': {
    promise:
      'A project board should be both a human-readable plan and an atomic, dependency-aware queue that agents can execute safely.',
    mechanism: [
      {
        title: 'Model durable work',
        body: 'Boards contain custom columns and tasks with priority, status, ownership, success criteria, metrics, links and notes.',
        code: '.wrongstack/kanbans/_kanban.sqlite',
      },
      {
        title: 'Compute readiness',
        body: 'A task is ready only when it is pending or ready, unclaimed, unmerged and every dependency is complete.',
        code: 'status + assignment + dependencies → ready',
      },
      {
        title: 'Claim atomically',
        body: 'Per-board locks serialize the read-modify-write operation so two agents cannot successfully claim the same ready task.',
        code: 'withFileLock → claimReadyTask',
      },
      {
        title: 'Route per task',
        body: 'Assignment metadata persists role, provider, model, fallback, tools and allowed capabilities through later claims.',
        code: 'task route → roster → worker runtime',
      },
      {
        title: 'Dispatch through Director',
        body: 'kanban_queue claims, spawns, assigns, records runtime ids and writes completion or failure back to the board.',
        code: 'ready task → Director → structured result',
      },
      {
        title: 'Bridge workflow graphs',
        body: 'TaskGraph, SDD and Goal structures can create, synchronize and export boards while rejecting dependency cycles.',
        code: 'graph ↔ Kanban board',
      },
    ],
    operatorNotes: [
      'Task status and assignment status are distinct; assignment is the stronger runtime signal.',
      'Use success criteria and goal metrics so completion means more than moving a card.',
      'Cross-board transfers are not a distributed transaction; locking is scoped per board.',
    ],
    signals: [
      { label: 'Default flow', value: 'backlog → todo → active → review → done' },
      { label: 'Queue safety', value: 'atomic per-board claims' },
      { label: 'Fleet bridge', value: 'kanban_queue' },
    ],
  },
  'brain-council': {
    promise:
      'High-risk autonomous decisions can receive independent multi-provider scrutiny before the runtime acts or escalates to a human.',
    mechanism: [
      {
        title: 'Gate by risk',
        body: 'The live autonomy ceiling and the Council minimum-risk threshold decide whether the panel convenes for a request.',
        code: 'decision.risk ≥ council.minRisk',
      },
      {
        title: 'Collect independent votes',
        body: 'Executor, skeptic, auditor or custom seats evaluate the same exact option ids in parallel without seeing peer rationales.',
        code: 'Promise.allSettled(voters)',
      },
      {
        title: 'Apply quorum and veto',
        body: 'Too few valid votes abstain to escalation; a configured veto seat can refuse every offered action outright.',
        code: 'quorum → veto → tally',
      },
      {
        title: 'Resolve weighted majority',
        body: 'Vote weights can encode trust or specialty. A winner must exceed the configured fraction of all cast weight.',
        code: 'Σ option weight > approval fraction',
      },
      {
        title: 'Send close calls to a judge',
        body: 'A separate judge sees all rationales for ties or weak pluralities; without a valid judgment the Council asks for human input.',
        code: 'tie | weak plurality → judge | ask_human',
      },
      {
        title: 'Learn from the ledger',
        body: 'A project-local decision ledger records decisions and observed outcomes, then supplies a digest for similar later choices.',
        code: 'brain-ledger.jsonl → decision digest',
      },
    ],
    operatorNotes: [
      'Use models or providers with genuinely different failure modes for meaningful diversity.',
      'A Council abstention never silently approves; the outer escalation tier resolves it.',
      'Council governance complements tool permissions and does not override explicit deny rules.',
    ],
    signals: [
      { label: 'Resolution', value: 'quorum → veto → majority → judge' },
      { label: 'Default quorum', value: '50% of seats' },
      { label: 'Default timeout', value: '15s per seat' },
    ],
  },
  customization: {
    promise:
      'Teams should be able to change how WrongStack thinks, acts, remembers and appears while keeping security boundaries explicit.',
    mechanism: [
      {
        title: 'Layer configuration',
        body: 'Global config establishes trusted defaults, project config carries safe preferences and CLI or slash commands override the session.',
        code: 'global → project allow-list → session',
      },
      {
        title: 'Choose model behavior',
        body: 'Provider, leader model, role matrix, fallback profiles and runtime reasoning controls can vary independently.',
        code: 'provider + modelMatrix + modelRuntime',
      },
      {
        title: 'Shape agent knowledge',
        body: 'Project instructions, skills, prompts and SAGE define reusable context without hardcoding it in application code.',
        code: 'AGENTS.md + skills + prompts + memory',
      },
      {
        title: 'Shape execution',
        body: 'Tool policy, hooks, plugins, MCP servers, fleet roles and permission capabilities define what the runtime may do.',
        code: 'policy + extensions + roster',
      },
      {
        title: 'Shape the interface',
        body: 'CLI modes, TUI panels, WebUI settings, SimpleUI, Desktop and HQ expose shared state while preserving surface-specific preferences.',
        code: 'one kernel → six tailored surfaces',
      },
      {
        title: 'Protect trust boundaries',
        body: 'Attacker-controlled in-project config cannot define providers, endpoints, MCP servers, hooks, plugins, fleet policy or YOLO.',
        code: 'stripUnsafeInProjectFields()',
      },
    ],
    operatorNotes: [
      'Use project config for portable preferences and the project-local user config for sensitive integrations.',
      'Prefer declarative routing and capability grants over prompt-only instructions.',
      'A new top-level config field is denied in project config until explicitly classified.',
    ],
    signals: [
      { label: 'Knowledge', value: 'skills · prompts · memory' },
      { label: 'Execution', value: 'tools · MCP · hooks · plugins' },
      { label: 'Governance', value: 'permissions · Brain · config allow-list' },
    ],
  },
  'wrongtrace-integration': {
    promise:
      'Coordination with an external daemon should improve edit safety when present and change nothing when absent.',
    mechanism: [
      {
        title: 'Discover lazily',
        body: 'Boot probes the daemon health endpoint once, fire-and-forget, with a one-second timeout. No session startup path ever awaits the daemon.',
        code: 'GET /api/health → { available, socketPath }',
      },
      {
        title: 'Gate mutating tools',
        body: 'In-process hooks sit in front of the shared executor: edit, write, replace, patch and AST replace pass a lock pre-flight on every host surface.',
        code: 'preToolUse → preflightFileEdit(path)',
      },
      {
        title: 'Deny or claim',
        body: 'A file locked by another owner denies the call with owner and expiry in the reason. Allowed edits claim the lock so peers see the work in flight; fragile files get a surgical-edit nudge.',
        code: 'lockFile(path, reason, { ttlSeconds: 900 })',
      },
      {
        title: 'Release or reap',
        body: 'The post-tool hook releases the claim; if the process dies mid-edit, the daemon TTL reaps the lock. Every failure path allows the edit — coordination, never authorization.',
        code: 'postToolUse → unlockFile(path)',
      },
      {
        title: 'Route per method',
        body: 'Calls prefer the JSON-RPC pipe, then MCP tools, then HTTP — except lock acquisition, which stays HTTP to preserve conflict semantics.',
        code: 'IPC → MCP → HTTP (lock: HTTP-only)',
      },
    ],
    operatorNotes: [
      'The daemon is optional everywhere: offline means no-ops, never blocked edits.',
      'Both integrations default to port 3444; override via WRONGTRACE_URL and tools.wrongProxy.url.',
      'Live-daemon test suites self-skip offline — a green run proves the fail-open contract, not live locks.',
    ],
    signals: [
      { label: 'Transports', value: 'HTTP · IPC · MCP' },
      { label: 'Lock TTL', value: '900s' },
      { label: 'Daemon', value: 'optional · fail-open' },
    ],
  },
};

export const commandGuidance: Record<
  Exclude<CommandCategory, 'All'>,
  { intent: string; before: string; during: string; after: string }
> = {
  Workflow: {
    intent: 'Shape a repeatable agent workflow instead of manually restating its operating rules.',
    before: 'Confirm the objective and the current session state.',
    during: 'Watch the returned steering text, phase state or plan update.',
    after: 'Review evidence and stop or pause the workflow explicitly when needed.',
  },
  Session: {
    intent: 'Inspect or change the durable and live state around the current conversation.',
    before: 'Know whether the operation affects only the view, live context or persisted session.',
    during: 'Read the command result before sending the next model turn.',
    after: 'Use /diag or the relevant status command to confirm the new state.',
  },
  Agents: {
    intent:
      'Coordinate bounded work across specialists while keeping ownership and budgets visible.',
    before: 'Separate independent work and decide what evidence each worker must return.',
    during: 'Monitor agent status, cost, tools and mailbox events.',
    after: 'Roll up results and retire or redirect remaining work deliberately.',
  },
  Configure: {
    intent: 'Change runtime behavior without editing code or restarting unnecessarily.',
    before: 'Check whether the setting is session-only or persisted.',
    during: 'Inspect the command response for the effective value.',
    after: 'Verify with /settings, /diag or the corresponding status surface.',
  },
  Developer: {
    intent: 'Run a focused engineering or repository operation around the agent.',
    before: 'Check the working tree and scope the target path.',
    during: 'Keep generated evidence, output and mutations reviewable.',
    after: 'Inspect the diff and run the proportional quality gate.',
  },
  Ecosystem: {
    intent: 'Inspect or extend tools, integrations, reusable knowledge and observability.',
    before: 'Confirm the capability and trust boundary you are enabling.',
    during: 'Watch connection, plugin or discovery state.',
    after: 'Disable unused integrations and verify the registered surface.',
  },
};
