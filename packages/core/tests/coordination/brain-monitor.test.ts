import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecision } from '../../src/coordination/brain.js';
import { DefaultBrainArbiter } from '../../src/coordination/brain.js';
import { type BrainInterventionInput, BrainMonitor } from '../../src/coordination/brain-monitor.js';
import { createTieredBrainArbiter } from '../../src/execution/autonomy-brain.js';
import { EventBus, type EventMap } from '../../src/kernel/events.js';

const STEER: BrainDecision = {
  type: 'answer',
  optionId: 'steer',
  text: 'Steer the agent with corrective guidance',
  rationale: 'Try reading the file before editing it.',
};
const CONTINUE: BrainDecision = {
  type: 'answer',
  optionId: 'continue',
  text: 'Let the agent continue unaided',
};

function failedTool(name: string): EventMap['tool.executed'] {
  return { name, durationMs: 5, ok: false, output: 'boom' };
}

function okTool(name: string): EventMap['tool.executed'] {
  return { name, durationMs: 5, ok: true };
}

/** Wait for the monitor's async engage() chain to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BrainMonitor', () => {
  let events: EventBus;
  let interventions: BrainInterventionInput[];
  let intervene: (input: BrainInterventionInput) => Promise<void>;

  beforeEach(() => {
    events = new EventBus();
    interventions = [];
    intervene = async (input) => {
      interventions.push(input);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function monitor(
    brain: BrainArbiter,
    opts: Partial<ConstructorParameters<typeof BrainMonitor>[0]> = {},
  ) {
    const m = new BrainMonitor({ events, brain, intervene, ...opts });
    m.start();
    return m;
  }

  it('engages after N consecutive failures of the same tool and delivers a steer', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = monitor(brain);

    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.subject).toContain('tool failure streak');
    expect(interventions[0]?.body).toContain('Try reading the file before editing it.');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe('tool_failure_streak');
    expect(emitted[0]?.intervened).toBe(true);
    m.stop();
  });

  it('resets the streak when the tool succeeds', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = monitor(brain);

    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', okTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(0);
    m.stop();
  });

  it('tracks streaks per tool — different tools do not accumulate together', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = monitor(brain);

    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('bash'));
    events.emit('tool.executed', failedTool('grep'));
    await settle();

    expect(interventions).toHaveLength(0);
    m.stop();
  });

  it('observes without intervening when the brain chooses continue', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => CONTINUE) };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = monitor(brain);

    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.intervened).toBe(false);
    m.stop();
  });

  it('rate-limits engagements of the same kind via cooldown', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = monitor(brain, { cooldownMs: 60_000 });

    for (let i = 0; i < 6; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(1);
    m.stop();
  });

  it('engages on an error storm within the sliding window', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = monitor(brain, { errorStormCount: 3 });

    for (let i = 0; i < 3; i++) {
      events.emit('error', { err: new Error(`boom ${i}`), phase: 'tool' });
    }
    await settle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe('error_storm');
    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.subject).toContain('error storm');
    m.stop();
  });

  it('never throws when the brain itself fails', async () => {
    const brain: BrainArbiter = {
      decide: async () => {
        throw new Error('brain offline');
      },
    };
    const m = monitor(brain);

    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(0);
    m.stop();
  });

  it('reports intervened=false when steer delivery fails', async () => {
    const brain: BrainArbiter = { decide: async () => STEER };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = new BrainMonitor({
      events,
      brain,
      intervene: async () => {
        throw new Error('mailbox unavailable');
      },
    });
    m.start();

    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.intervened).toBe(false);
    m.stop();
  });

  it('stop() detaches all listeners', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = monitor(brain);
    m.stop();

    for (let i = 0; i < 5; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(0);
  });

  it('with tiered brain: routes to LLM layer after 3 failures via ask_human fallback', async () => {
    // Mock autonomous layer that returns a real steer (simulates createAutonomyBrain)
    const LLM_STEER: BrainDecision = {
      type: 'answer',
      optionId: 'steer',
      text: 'Steer the agent with corrective guidance',
      rationale: 'The tool "edit" has failed 3 times — try a different approach.',
    };
    const mockAutonomous: BrainArbiter = { decide: vi.fn(async () => LLM_STEER) };

    // TieredBrain: DefaultBrainArbiter (policy) + mock autonomous layer
    const tieredBrain = createTieredBrainArbiter({
      policy: new DefaultBrainArbiter(),
      autonomous: mockAutonomous,
      getMaxAutoRisk: () => 'all',
    });

    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = new BrainMonitor({ events, brain: tieredBrain, intervene });

    m.start();
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await settle();

    // Autonomous layer should have been consulted (DefaultBrain returned ask_human, tiered routed to LLM)
    expect(mockAutonomous.decide).toHaveBeenCalledOnce();
    // Intervention should be delivered
    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.body).toContain('try a different approach');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.intervened).toBe(true);
    m.stop();
  });

  it('offers no recommended option — interrupting the agent has no safe default', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => CONTINUE) };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = monitor(brain);
    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    const request = emitted[0]?.request;
    expect(request?.options?.map((o) => o.id)).toEqual(['steer', 'continue']);
    // A recommended option here would (a) be auto-accepted by the headless
    // terminal policy at medium risk, turning a dead provider into a canned
    // steer on every signal, and (b) render "★ recommended" into the prompt of
    // the very judgement the model is being asked to make.
    expect(request?.options?.some((o) => o.recommended)).toBe(false);
    m.stop();
  });

  it('is observe-only when the escalation resolves without a model', async () => {
    // The real headless path: the policy tier escalates (fallback ask_human),
    // no LLM is reachable, and the terminal policy has no recommended option
    // to fall back on — so it denies, which must NOT reach the agent.
    const deadPool: BrainArbiter = {
      decide: vi.fn(async () => ({ type: 'deny', reason: 'pool unavailable' }) as BrainDecision),
    };
    const tiered = createTieredBrainArbiter({
      policy: new DefaultBrainArbiter(),
      autonomous: deadPool,
      getMaxAutoRisk: () => 'all',
    });
    const escalated: BrainDecision[] = [];
    const headless: BrainArbiter = {
      async decide(request) {
        const d = await tiered.decide(request);
        if (d.type !== 'ask_human') return d;
        const { terminalPolicyDecision } = await import('../../src/coordination/brain.js');
        const terminal = terminalPolicyDecision(request);
        escalated.push(terminal);
        return terminal;
      },
    };

    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = monitor(headless);
    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(escalated[0]).toMatchObject({ type: 'deny' });
    expect(interventions).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    // The signal is still recorded for the surfaces — only the steer is withheld.
    expect(emitted[0]?.intervened).toBe(false);
    m.stop();
  });
});

describe('BrainMonitor — deterministic policies and kill switches', () => {
  let events: EventBus;
  let interventions: BrainInterventionInput[];
  let intervene: (input: BrainInterventionInput) => Promise<void>;
  let brain: BrainArbiter & { decide: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    events = new EventBus();
    interventions = [];
    intervene = async (input) => {
      interventions.push(input);
    };
    brain = { decide: vi.fn(async (): Promise<BrainDecision> => STEER) };
  });

  const failThrice = () => {
    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
  };

  it("policy 'steer' intervenes without consulting the Brain", async () => {
    const monitor = new BrainMonitor({ events, brain, intervene, policy: 'steer' });
    monitor.start();
    failThrice();
    await settle();

    expect(interventions).toHaveLength(1);
    expect(brain.decide).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("policy 'observe' records the signal but never steers or calls the Brain", async () => {
    const seen = vi.fn();
    events.on('brain.intervention', seen);
    const monitor = new BrainMonitor({ events, brain, intervene, policy: 'observe' });
    monitor.start();
    failThrice();
    await settle();

    expect(interventions).toHaveLength(0);
    expect(brain.decide).not.toHaveBeenCalled();
    // The engagement is still visible to the surfaces — observing is the
    // point of this mode, so the event must not be suppressed too.
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ intervened: false }));
    monitor.stop();
  });

  it("policy 'llm' still consults the Brain (unchanged default)", async () => {
    const monitor = new BrainMonitor({ events, brain, intervene });
    monitor.start();
    failThrice();
    await settle();

    expect(brain.decide).toHaveBeenCalledTimes(1);
    expect(interventions).toHaveLength(1);
    monitor.stop();
  });

  it('enabled:false makes start() a no-op', async () => {
    const monitor = new BrainMonitor({ events, brain, intervene, enabled: false });
    monitor.start();
    failThrice();
    await settle();

    expect(brain.decide).not.toHaveBeenCalled();
    expect(interventions).toHaveLength(0);
    monitor.stop();
  });

  it('a disabled signal never engages while the others still do', async () => {
    const monitor = new BrainMonitor({
      events,
      brain,
      intervene,
      signals: { toolFailureStreak: false },
      errorStormCount: 2,
    });
    monitor.start();

    failThrice();
    await settle();
    expect(brain.decide).not.toHaveBeenCalled();

    events.emit('error', { phase: 'tool', err: new Error('a') });
    events.emit('error', { phase: 'tool', err: new Error('b') });
    await settle();
    expect(brain.decide).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('tracks churn for custom edit tool names', async () => {
    const monitor = new BrainMonitor({
      events,
      brain,
      intervene,
      signals: { toolFailureStreak: false },
      fileEditTools: ['apply_diff'],
      fileChurnThreshold: 2,
    });
    monitor.start();

    // A built-in name is no longer tracked once the list is replaced.
    for (let i = 0; i < 3; i++) {
      events.emit('tool.executed', { ...okTool('edit'), input: { file_path: '/a.ts' } });
    }
    await settle();
    expect(brain.decide).not.toHaveBeenCalled();

    for (let i = 0; i < 2; i++) {
      events.emit('tool.executed', { ...okTool('apply_diff'), input: { file_path: '/a.ts' } });
    }
    await settle();
    expect(brain.decide).toHaveBeenCalledTimes(1);
    monitor.stop();
  });
});

describe('BrainMonitor — live reconfiguration', () => {
  let events: EventBus;
  let interventions: BrainInterventionInput[];
  let intervene: (input: BrainInterventionInput) => Promise<void>;
  let brain: BrainArbiter & { decide: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    events = new EventBus();
    interventions = [];
    intervene = async (input) => {
      interventions.push(input);
    };
    brain = { decide: vi.fn(async (): Promise<BrainDecision> => STEER) };
  });

  it('applies a new failure threshold to a running monitor', async () => {
    const monitor = new BrainMonitor({ events, brain, intervene, toolFailureStreak: 3 });
    monitor.start();

    expect(monitor.reconfigure({ toolFailureStreak: 5 })).toBe(true);
    for (let i = 0; i < 4; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();
    // Would have engaged twice under the old threshold of 3.
    expect(brain.decide).not.toHaveBeenCalled();

    events.emit('tool.executed', failedTool('edit'));
    await settle();
    expect(brain.decide).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('reports no change for an identical config and leaves counters intact', async () => {
    // onApplied fires for EVERY Brain setting, so `/brain risk` reaches this
    // path too. If an unchanged monitor block restarted the watchers, it would
    // silently discard an in-flight failure streak.
    const monitor = new BrainMonitor({ events, brain, intervene, toolFailureStreak: 3 });
    monitor.start();
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));

    expect(monitor.reconfigure({ toolFailureStreak: 3 })).toBe(false);

    events.emit('tool.executed', failedTool('edit'));
    await settle();
    expect(brain.decide).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('resets accumulating counters when a threshold actually changes', async () => {
    const monitor = new BrainMonitor({ events, brain, intervene, toolFailureStreak: 3 });
    monitor.start();
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));

    // Two failures banked, then the threshold moves. The partial streak was
    // measured against the old threshold and must not carry over.
    expect(monitor.reconfigure({ toolFailureStreak: 3, cooldownMs: 999 })).toBe(true);
    events.emit('tool.executed', failedTool('edit'));
    await settle();
    expect(brain.decide).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('switches policy live — llm to steer stops consulting the Brain', async () => {
    const monitor = new BrainMonitor({ events, brain, intervene, policy: 'llm', cooldownMs: 0 });
    monitor.start();
    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();
    expect(brain.decide).toHaveBeenCalledTimes(1);

    expect(monitor.reconfigure({ policy: 'steer', cooldownMs: 0 })).toBe(true);
    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();
    expect(brain.decide).toHaveBeenCalledTimes(1);
    expect(interventions).toHaveLength(2);
    monitor.stop();
  });

  it('disabling live detaches the watchers; re-enabling reattaches them', async () => {
    const monitor = new BrainMonitor({ events, brain, intervene, cooldownMs: 0 });
    monitor.start();

    expect(monitor.reconfigure({ enabled: false })).toBe(true);
    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();
    expect(brain.decide).not.toHaveBeenCalled();

    expect(monitor.reconfigure({ enabled: true, cooldownMs: 0 })).toBe(true);
    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();
    expect(brain.decide).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  it('does not double-subscribe when start() is called twice', async () => {
    const monitor = new BrainMonitor({ events, brain, intervene, cooldownMs: 0 });
    monitor.start();
    monitor.start();
    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();
    // A second subscription would double-count every tool event, tripping the
    // streak after two failures and engaging twice.
    expect(brain.decide).toHaveBeenCalledTimes(1);
    monitor.stop();
  });
});

describe('BrainMonitor — control-plane discipline', () => {
  let events: EventBus;
  let interventions: BrainInterventionInput[];

  beforeEach(() => {
    events = new EventBus();
    interventions = [];
  });

  const run = async (decision: BrainDecision) => {
    const m = new BrainMonitor({
      events,
      brain: { decide: async () => decision },
      intervene: async (input) => {
        interventions.push(input);
      },
    });
    m.start();
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    m.stop();
    return emitted;
  };

  it('does not steer on prose when no option was chosen', async () => {
    // The request always offers `steer`/`continue`, so an optionless answer
    // means no tier actually made this choice. Steering on a sentence that
    // merely did not start with "continue" injected guidance into a live
    // agent off the back of a regex.
    const emitted = await run({
      type: 'answer',
      text: 'The agent appears to be stuck on a dependency problem.',
    });

    expect(interventions).toHaveLength(0);
    // The engagement is still reported — observe-only, not silent.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.intervened).toBe(false);
  });

  it('steers on the exact option id', async () => {
    await run({ type: 'answer', optionId: 'steer', text: 'Steer', rationale: 'read first' });
    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.body).toContain('read first');
  });

  it('does not steer on an empty steer answer', async () => {
    const emitted = await run({ type: 'answer', optionId: 'steer', text: '   ' });
    expect(interventions).toHaveLength(0);
    expect(emitted[0]?.intervened).toBe(false);
  });
});
