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

    it('separates word-embedded tags with a space instead of gluing words', () => {
      expect(stripVibeTag('kelime[VIBE]sonra')).toBe('kelime sonra');
      expect(stripVibeTag('önce[VIBE][VIBE]sonra')).toBe('önce sonra');
      expect(stripVibeTag('son[VIBE]')).toBe('son');
    });

    it.each([
      ['\u{10400}[VIBE]next', '\u{10400} next'], // Deseret letter before the tag
      ['item[VIBE][vibe]\u{1D7CF}', 'item \u{1D7CF}'], // Mathematical digit after the tags
      ['item[VIBE]next', 'item next'],
      ['item[VIBE]!', 'item!'],
    ])('preserves word boundaries when stripping the tag from %s', (prompt, expected) => {
      expect(stripVibeTag(prompt)).toBe(expected);
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

    it('copies auditNotes when preserving an existing state', () => {
      const existing = {
        isVibeMode: true as const,
        detectedAt: 1,
        stage: 'coder' as const,
        auditNotes: ['spec checked'],
      };
      const state = deriveVibeState('refined without tag', existing, 2000);
      expect(state?.auditNotes).toEqual(['spec checked']);
      expect(state?.auditNotes).not.toBe(existing.auditNotes);
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

    it('rejects malformed caller-supplied VIBE state before persistence', async () => {
      const harness = makeHarness();

      await expect(
        harness.service.createIntake(
          {
            projectId: 'proj_alpha',
            originalRequest: 'Do not persist malformed VIBE state',
            requestedBy: 'user-alice',
            vibeProtocol: {
              isVibeMode: 'yes',
              detectedAt: 'yesterday',
              stage: 'root',
              auditNotes: Array.from({ length: 51 }, (_, index) => `note-${index}`),
            } as never,
          },
          ALICE,
        ),
      ).rejects.toMatchObject({ code: 'INTAKE_VALIDATION_ERROR' });

      await expect(harness.store.list('proj_alpha')).resolves.toEqual([]);
    });

    it('prevents unlocking VIBE mode via updateIntake({ isVibeMode: false }) and initializes vibeProtocol when enabling VIBE mode on update', async () => {
      const harness = makeHarness();
      const locked = await harness.service.createIntake(
        {
          projectId: 'proj_alpha',
          originalRequest: '[VIBE] Keep audited workflow locked',
          requestedBy: 'user-alice',
        },
        ALICE,
      );

      const afterUnlockAttempt = await harness.service.updateIntake(
        locked.record.id,
        { isVibeMode: false },
        ALICE,
      );
      expect(afterUnlockAttempt.isVibeMode).toBe(true);
      expect(afterUnlockAttempt.vibeProtocol?.isVibeMode).toBe(true);

      const plain = await harness.service.createIntake(
        {
          projectId: 'proj_alpha',
          originalRequest: 'Normal request later promoted to VIBE',
          requestedBy: 'user-alice',
        },
        ALICE,
      );

      const promoted = await harness.service.updateIntake(
        plain.record.id,
        { isVibeMode: true },
        ALICE,
      );
      expect(promoted.isVibeMode).toBe(true);
      expect(promoted.vibeProtocol?.isVibeMode).toBe(true);
      expect(promoted.vibeProtocol?.stage).toBe('synthesizer');
    });

    it('synchronizes VIBE state on addAnswer/updateAnswer, updates question.answer on repeated answers, clears fieldSources on blank optional strings, and marks populated fields answered (F677)', async () => {
      const harness = makeHarness({
        generator: {
          async generate() {
            return {
              suggested_questions: [
                { field: 'business_goal', question: 'What is the business goal?' },
                { field: 'description_scope', question: 'What is the scope?' },
                { field: 'security_review', question: 'Which security review?' },
              ],
            };
          },
        },
      });
      const { record } = await harness.service.createIntake(
        {
          projectId: 'proj_alpha',
          originalRequest: 'Add enterprise SAML SSO',
          requestedBy: 'user-alice',
        },
        ALICE,
      );

      await harness.service.addAnswer(
        record.id,
        { field: 'business_goal', answer: 'First goal' },
        ALICE,
      );
      const afterSecond = await harness.service.addAnswer(
        record.id,
        { field: 'business_goal', answer: '[VIBE] Second goal with VIBE' },
        ALICE,
      );
      expect(afterSecond.isVibeMode).toBe(true);
      expect(afterSecond.vibeProtocol?.stage).toBe('synthesizer');
      expect(afterSecond.questions.find((q) => q.field === 'business_goal')?.answer).toBe(
        '[VIBE] Second goal with VIBE',
      );

      const afterUpdate = await harness.service.updateIntake(
        record.id,
        {
          businessGoal: '   ',
          expectedOutcome: 'SAML login works',
        },
        ALICE,
      );
      expect(afterUpdate.businessGoal).toBeUndefined();
      expect(afterUpdate.fieldSources.business_goal).toBeUndefined();
      expect(afterUpdate.questions.find((q) => q.field === 'expected_outcome')?.status).toBe(
        'answered',
      );

      const custom = await harness.service.createIntake(
        {
          projectId: 'proj_alpha',
          originalRequest: 'Custom catalog intake',
          requestedBy: 'user-alice',
          businessGoal: 'Supplied goal',
          questions: [{ field: 'custom_q', question: 'Custom question?' }],
        },
        ALICE,
      );
      const proposals = await harness.service.generateSuggestions(custom.record.id, ALICE);
      for (const proposal of proposals) {
        await harness.service.acceptSuggestion(custom.record.id, proposal.id, ALICE);
      }
      const pendingFields = (await harness.service.pendingQuestions(custom.record.id, ALICE)).map(
        (q) => q.field,
      );
      expect(pendingFields).toEqual(['custom_q', 'security_review']);
    });
  });
});
