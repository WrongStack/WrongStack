import { describe, expect, it } from 'vitest';
import { deriveVibeState, hasVibeTag, stripVibeTag } from '../src/index.js';
import { ALICE, makeHarness } from './helpers.js';

describe('VIBE Protocol — Requirement Intake', () => {
  describe('hasVibeTag', () => {
    it('detects [VIBE] at the beginning of prompt', () => {
      expect(hasVibeTag('[VIBE] butona basınca sepet artsın')).toBe(true);
    });

    it('detects [vibe] in lowercase anywhere in prompt', () => {
      expect(hasVibeTag('lütfen bunu yapın [vibe] hızlıca')).toBe(true);
    });

    it('detects [VIBE] at the end of prompt', () => {
      expect(hasVibeTag('burada bir şeyler eksik [VIBE]')).toBe(true);
    });

    it('returns false when tag is not present', () => {
      expect(hasVibeTag('normal standart bir prompt')).toBe(false);
      expect(hasVibeTag(null)).toBe(false);
      expect(hasVibeTag(undefined)).toBe(false);
    });
  });

  describe('stripVibeTag', () => {
    it('removes [VIBE] tag and cleans extra spaces', () => {
      expect(stripVibeTag('[VIBE] butona basınca sepet artsın')).toBe(
        'butona basınca sepet artsın',
      );
      expect(stripVibeTag('lütfen bunu   [VIBE]   yap')).toBe('lütfen bunu yap');
    });

    it('removes every occurrence, not only the first tag', () => {
      expect(stripVibeTag('[VIBE] önce [vibe] sonra [VIBE]')).toBe('önce sonra');
    });

    it('does not leave hasVibeTag sticky across repeated calls', () => {
      expect(hasVibeTag('[VIBE] bir')).toBe(true);
      expect(hasVibeTag('[VIBE] iki')).toBe(true);
      expect(hasVibeTag('normal')).toBe(false);
      expect(hasVibeTag('[vibe] üç')).toBe(true);
    });
  });

  describe('deriveVibeState & Refinement-Preservation', () => {
    it('initializes VibeProtocolState with synthesizer stage when tag is detected', () => {
      const state = deriveVibeState('[VIBE] test request', undefined, 1000);
      expect(state).toBeDefined();
      expect(state?.isVibeMode).toBe(true);
      expect(state?.stage).toBe('synthesizer');
      expect(state?.detectedAt).toBe(1000);
    });

    it('preserves VibeProtocolState across refining even when tag is omitted in subsequent text', () => {
      const initial = deriveVibeState('[VIBE] initial chaotic prompt', undefined, 1000);
      expect(initial?.isVibeMode).toBe(true);

      // Refining prompt without [VIBE]
      const refined = deriveVibeState('refined prompt without tag', initial, 2000);
      expect(refined).toBeDefined();
      expect(refined?.isVibeMode).toBe(true);
      expect(refined?.detectedAt).toBe(1000);
    });
  });

  describe('RequirementIntakeService with VIBE Protocol', () => {
    it('automatically marks record as isVibeMode and attaches vibeProtocol state upon creation', async () => {
      const harness = makeHarness();
      const created = await harness.service.createIntake(
        {
          projectId: 'proj_alpha',
          originalRequest: 'Şuraya bir buton koy [VIBE] adminse silsin',
          requestedBy: 'user-alice',
        },
        ALICE,
      );

      expect(created.record.isVibeMode).toBe(true);
      expect(created.record.vibeProtocol).toBeDefined();
      expect(created.record.vibeProtocol?.stage).toBe('synthesizer');
    });

    it('preserves isVibeMode on subsequent updates', async () => {
      const harness = makeHarness();
      const created = await harness.service.createIntake(
        {
          projectId: 'proj_alpha',
          originalRequest: '[VIBE] ham fikir',
          requestedBy: 'user-alice',
        },
        ALICE,
      );

      expect(created.record.isVibeMode).toBe(true);

      const updated = await harness.service.updateIntake(
        created.record.id,
        {
          title: 'Rafine Başlık',
          businessGoal: 'Rafine edilmiş hedef',
        },
        ALICE,
      );

      expect(updated.isVibeMode).toBe(true);
      expect(updated.vibeProtocol?.stage).toBe('synthesizer');
    });
  });
});
