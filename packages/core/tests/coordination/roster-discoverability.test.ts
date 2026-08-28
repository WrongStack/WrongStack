/**
 * A 77-role roster is only as useful as the leader's ability to find the right
 * role in it.
 *
 * Measured on this project before these guards existed: of the 77 roles the
 * leader is offered, 10 had ever completed a task and 2 accounted for 73% of
 * all learning — while `database`, `backend`, `frontend`, `devops` and
 * `android` had never once been chosen. The menu was built from the first 80
 * characters of each role prompt, every one of which opens "You are the X
 * agent. Your job is…", so the lines that were supposed to distinguish 77
 * specialists were a third boilerplate and truncated before the point.
 */

import { describe, expect, it } from 'vitest';
import { ALL_AGENT_DEFINITIONS } from '../../src/coordination/agents/index.js';
import { rosterSummaryFromConfigs } from '../../src/coordination/director-prompts.js';
import { FLEET_ROSTER } from '../../src/coordination/fleet.js';

/** Roles the leader can only find by reading a description, not by guessing. */
const SPECIALISTS = ['database', 'api', 'auth', 'accessibility', 'compliance'];

describe('the roster the leader is shown', () => {
  it('carries the catalog capability onto every catalog role', () => {
    const missing = ALL_AGENT_DEFINITIONS.filter((definition) => {
      const role = definition.config.role as string;
      return definition.capability?.summary?.trim() && !FLEET_ROSTER[role]?.dispatch?.summary;
    }).map((definition) => definition.config.role);
    expect(missing).toEqual([]);
  });

  it('does not mutate the catalog definition it copies from', () => {
    const definition = ALL_AGENT_DEFINITIONS.find((d) => d.config.role === 'database');
    expect(definition?.config.dispatch).toBeUndefined();
    expect(FLEET_ROSTER['database']?.dispatch?.summary).toBeTruthy();
  });

  it('describes what each specialist does instead of repeating the boilerplate', () => {
    const summary = rosterSummaryFromConfigs(FLEET_ROSTER);
    const lines = summary.split('\n');
    expect(lines).toHaveLength(Object.keys(FLEET_ROSTER).length);

    for (const role of SPECIALISTS) {
      const line = lines.find((l) => l.startsWith(`- ${role} `));
      expect(line, `roster line for "${role}"`).toBeTruthy();
      expect(line).not.toContain('You are the');
      // A line that says nothing past the role id cannot route anything to it.
      expect((line as string).split(' — ')[1]?.length ?? 0).toBeGreaterThan(30);
    }
  });

  it('leaves almost no line without a capability', () => {
    const lines = rosterSummaryFromConfigs(FLEET_ROSTER).split('\n');
    const blind = lines.filter((line) => !line.includes(' — '));
    expect(blind).toEqual([]);
  });

  it('leaves every role able to say it is stuck', () => {
    // Toolsets are deliberately narrow — a reviewer that cannot write is the
    // point of independent review. But narrow must never mean mute: an agent
    // that can only fail, and not ask, is a dead end in an autonomous run.
    // `vcs` was the one preset without `mailbox`, which silenced exactly the
    // two roles whose work most often needs a decision (`git`, `release`).
    //
    // There are two ways to speak, and a role needs only one. `mailbox` is
    // the durable cross-session letter; `session_note` is the in-process
    // note to the leader of THIS session. `explore-companion` deliberately
    // carries only the second — it is a same-session resident, and giving a
    // background explorer a durable outbox other sessions read was never the
    // intent. It declares the capability rather than the tool because the
    // host injects `session_note` the way it injects `submit_result`.
    const canSpeak = (cfg: (typeof FLEET_ROSTER)[string]): boolean => {
      const tools = Array.isArray(cfg.tools) ? cfg.tools : [];
      if (tools.includes('mailbox') || tools.includes('session_note')) return true;
      return (cfg.allowedCapabilities ?? []).includes('session.note');
    };
    const mute = Object.entries(FLEET_ROSTER)
      .filter(([, cfg]) => Array.isArray(cfg.tools) && !canSpeak(cfg))
      .map(([role]) => role);
    expect(mute).toEqual([]);
  });

  it('keeps the menu affordable', () => {
    // Roughly 120 chars per role. Worth paying: the alternative is a leader
    // that reaches for the same four ids regardless of the task.
    const summary = rosterSummaryFromConfigs(FLEET_ROSTER);
    expect(summary.length).toBeLessThan(12_000);
  });
});
