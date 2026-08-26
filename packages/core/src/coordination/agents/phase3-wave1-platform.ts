import { agentPrompt } from './agent-prompts.js';
import type { BundledAgentSkill } from './role-skills.js';
import {
  type AgentDefinition,
  HEAVY_BUDGET,
  MEDIUM_BUDGET,
  type RoleDispatcherSignal,
  TOOLS,
} from './types.js';

const skillSet = (...names: BundledAgentSkill[]): BundledAgentSkill[] => names;

void skillSet;

/**
 * Wave 1: Platform and systems engineering.
 *
 * Six new specialist roles sit alongside the existing build/domain/verify
 * phases. Each carries an explicit `RoleDispatcherSignal` so the dispatcher
 * can tell it apart from siblings that share vocabulary.
 */

const ANDROID_META = {
  rationale:
    'Android platform specialist: Kotlin, Jetpack Compose, Android SDK and Play Store delivery. Mirrors the iOS role on the Android side of the mobile fence.',
  signals: [
    'android',
    'kotlin',
    'jetpack compose',
    'compose',
    'android sdk',
    'gradle',
    'play store',
    'aosp',
  ] as const,
  differentiatesFrom:
    'frontend builds cross-platform UI; android owns the Android-specific lifecycle, framework and platform APIs.',
} satisfies RoleDispatcherSignal;

const DESKTOP_META = {
  rationale:
    'Desktop application specialist: Electron, Tauri, native packaging, IPC and OS integration. Owns the process/IPC boundary that web-only roles ignore.',
  signals: [
    'desktop',
    'electron',
    'tauri',
    'ipc',
    'tray',
    'native packaging',
    'sandbox',
    'os integration',
  ] as const,
  differentiatesFrom:
    'frontend assumes a single browser tab; desktop owns the multi-process / IPC / OS-level boundaries.',
} satisfies RoleDispatcherSignal;

const REALTIME_META = {
  rationale:
    'Realtime transport specialist: WebSocket, SSE, presence, heartbeat, reconnect and backpressure. Owns long-lived connection state and lifecycle.',
  signals: [
    'realtime',
    'websocket',
    'sse',
    'server-sent events',
    'presence',
    'heartbeat',
    'backpressure',
    'reconnect',
  ] as const,
  differentiatesFrom:
    'api designs request/response contracts; realtime designs long-lived connections and presence semantics.',
} satisfies RoleDispatcherSignal;

const DISTRIBUTED_SYSTEMS_META = {
  rationale:
    'Distributed-systems engineer: consistency, partitioning, idempotency, saga and distributed coordination. Implementation-level specialist; architect designs the surface, distributed-systems implements the failure semantics.',
  signals: [
    'distributed systems',
    'consensus',
    'saga',
    'idempotency',
    'partition',
    'eventual consistency',
    'leader election',
    'replication',
  ] as const,
  differentiatesFrom:
    'architect designs the system surface; distributed-systems implements the failure semantics and coordination protocols.',
} satisfies RoleDispatcherSignal;

const CONCURRENCY_META = {
  rationale:
    'Concurrency engineer: race conditions, locks, worker pools, async lifecycle and shared-state safety. Focused practitioner; debugger diagnoses, concurrency designs.',
  signals: [
    'concurrency',
    'race condition',
    'deadlock',
    'worker pool',
    'lock',
    'mutex',
    'async lifecycle',
    'shared state',
  ] as const,
  differentiatesFrom:
    'debugger diagnoses concurrency incidents; concurrency designs shared-state systems to avoid them in the first place.',
} satisfies RoleDispatcherSignal;

const PLATFORM_ENGINEER_META = {
  rationale:
    'Platform engineer: monorepo, build graph, internal tooling and developer experience. The "DX half" of CI/CD, separate from devops which owns deployment.',
  signals: [
    'platform',
    'monorepo',
    'build graph',
    'developer experience',
    'developer tooling',
    'scaffolding',
    'workspace',
  ] as const,
  differentiatesFrom:
    'devops owns deploy/operate; platform-engineer owns the internal developer surface that ships the code.',
} satisfies RoleDispatcherSignal;

export const WAVE1_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'android',
      name: 'Android',
      role: 'android',
      tools: [...TOOLS.build, 'fetch'],
      prompt: agentPrompt('android'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'domain',
      summary:
        'Android platform specialist: Kotlin, Jetpack Compose, Android SDK, lifecycle and Play Store delivery.',
      rationale: ANDROID_META,
      keywords: [...ANDROID_META.signals, 'android', 'kotlin', 'compose', 'gradle', 'playstore'],
    },
  },
  {
    config: {
      id: 'desktop',
      name: 'Desktop',
      role: 'desktop',
      tools: [...TOOLS.build, 'fetch'],
      prompt: agentPrompt('desktop'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'domain',
      summary:
        'Desktop application specialist: Electron or Tauri, native packaging, IPC and OS integration.',
      rationale: DESKTOP_META,
      keywords: [...DESKTOP_META.signals, 'desktop', 'electron', 'tauri', 'ipc', 'tray'],
    },
  },
  {
    config: {
      id: 'realtime',
      name: 'Realtime',
      role: 'realtime',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('realtime'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'verify',
      summary:
        'Realtime transport specialist: WebSocket, SSE, presence, heartbeat, reconnect and backpressure.',
      rationale: REALTIME_META,
      keywords: [
        ...REALTIME_META.signals,
        'realtime',
        'websocket',
        'sse',
        'presence',
        'heartbeat',
        'reconnect',
      ],
    },
  },
  {
    config: {
      id: 'distributed-systems',
      name: 'Distributed Systems',
      role: 'distributed-systems',
      tools: [...TOOLS.inspect, 'plan', 'test'],
      prompt: agentPrompt('distributed-systems'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'domain',
      summary:
        'Distributed-systems engineer: consistency, partitioning, idempotency, saga and coordination at the implementation level.',
      rationale: DISTRIBUTED_SYSTEMS_META,
      keywords: [
        ...DISTRIBUTED_SYSTEMS_META.signals,
        'distributed-systems',
        'consensus',
        'saga',
        'idempotency',
        'partition',
        'leader-election',
      ],
    },
  },
  {
    config: {
      id: 'concurrency',
      name: 'Concurrency',
      role: 'concurrency',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('concurrency'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'build',
      summary:
        'Concurrency engineer: race conditions, locks, worker pools, async lifecycle and shared-state safety.',
      rationale: CONCURRENCY_META,
      keywords: [
        ...CONCURRENCY_META.signals,
        'concurrency',
        'race',
        'deadlock',
        'worker-pool',
        'lock',
      ],
    },
  },
  {
    config: {
      id: 'platform-engineer',
      name: 'Platform Engineer',
      role: 'platform-engineer',
      tools: [...TOOLS.build, 'install', 'git'],
      prompt: agentPrompt('platform-engineer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'delivery',
      summary:
        'Platform engineer: monorepo, build graph, internal tooling and developer experience.',
      rationale: PLATFORM_ENGINEER_META,
      keywords: [
        ...PLATFORM_ENGINEER_META.signals,
        'platform',
        'monorepo',
        'build-graph',
        'dx',
        'scaffolding',
        'workspace',
      ],
    },
  },
];
