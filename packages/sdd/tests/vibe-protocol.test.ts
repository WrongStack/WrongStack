import { describe, expect, it } from 'vitest';
import {
  auditVibeExecution,
  buildCoderContract,
  formatVibeReport,
  synthesizeVibeSpec,
} from '../src/index.js';

describe('VIBE Three-Stage Verification Protocol — SDD Engine', () => {
  const chaoticPrompt =
    '[VIBE] butona basınca sepet artsın ama admin kullanıcısı ise sepeti silsin ve onay istesin';

  describe('Stage 1: Spec-Synthesizer', () => {
    it('synthesizes structured spec from chaotic vibe prompt', () => {
      const spec = synthesizeVibeSpec(chaoticPrompt);

      expect(spec.coreIntent).toContain('butona basınca sepet artsın');
      expect(spec.sensibleDefaults.length).toBeGreaterThan(0);
      expect(
        spec.sensibleDefaults.some((d) => d.includes('role-based') || d.includes('permission')),
      ).toBe(true);
      expect(spec.sensibleDefaults.some((d) => d.includes('deletion') || d.includes('sil'))).toBe(
        true,
      );
      expect(spec.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(spec.scopeBoundaries.excluded).toContain('Unrelated UI refactors');
      expect(spec.formattedSpecMarkdown).toContain('## 🌊 VIBE Synthesized Specification');
    });
  });

  describe('Stage 2: Coder Contract', () => {
    it('generates coder contract strictly constrained by synthesized spec', () => {
      const spec = synthesizeVibeSpec(chaoticPrompt);
      const contract = buildCoderContract(spec, ['src/cart.ts', 'src/cart-button.tsx']);

      expect(contract.specSummary).toBe(spec.coreIntent);
      expect(contract.targetFiles).toEqual(['src/cart.ts', 'src/cart-button.tsx']);
      expect(
        contract.instructions.some((ins) =>
          ins.includes('DO NOT introduce: Unrelated UI refactors'),
        ),
      ).toBe(true);
    });
  });

  describe('Stage 3: Auditor Engine', () => {
    it('approves (PASS) when coder implementation aligns with spec', () => {
      const spec = synthesizeVibeSpec(chaoticPrompt);
      const coderOutput = `
        export function handleCartClick(user: User, cart: Cart) {
          if (user.isAdmin) {
            if (confirm('Sepeti silmek istiyor musunuz?')) {
              cart.clear();
            }
          } else {
            cart.increment();
          }
        }
      `;

      const audit = auditVibeExecution({
        rawPrompt: chaoticPrompt,
        spec,
        coderOutput,
      });

      expect(audit.verdict).toBe('PASS');
      expect(audit.score).toBe(100);
      expect(audit.summary).toContain('Auditor approved');
    });

    it('does not reject when the coder echoes default policy exclusion phrases', () => {
      const spec = synthesizeVibeSpec(chaoticPrompt);
      const audit = auditVibeExecution({
        rawPrompt: chaoticPrompt,
        spec,
        coderOutput: [
          'Implemented cart increment for non-admin users.',
          'I did not introduce Unrelated UI refactors.',
          'I did not add Unrequested third-party dependency additions.',
        ].join('\n'),
      });

      expect(audit.verdict).toBe('PASS');
      expect(audit.checks.some((c) => c.id === 'scope-bleed')).toBe(false);
    });

    it('rejects (REJECT) when coder output is empty or violates scope boundaries', () => {
      const spec = synthesizeVibeSpec(chaoticPrompt);
      spec.scopeBoundaries.excluded.push('unwanted-library');

      const coderOutputWithViolation = `
        import { something } from 'unwanted-library';
        export function doThings() {}
      `;

      const audit = auditVibeExecution({
        rawPrompt: chaoticPrompt,
        spec,
        coderOutput: coderOutputWithViolation,
      });

      expect(audit.verdict).toBe('REJECT');
      expect(audit.reworkDirectives?.length).toBeGreaterThan(0);
      expect(audit.reworkDirectives?.some((d) => d.includes('unwanted-library'))).toBe(true);
    });
  });

  describe('Report Generator', () => {
    it('generates a full 3-stage markdown report', () => {
      const spec = synthesizeVibeSpec(chaoticPrompt);
      const contract = buildCoderContract(spec);
      const audit = auditVibeExecution({
        rawPrompt: chaoticPrompt,
        spec,
        coderOutput: 'export function handleAction() {}',
      });

      const report = formatVibeReport(chaoticPrompt, spec, contract, audit);

      expect(report).toContain('### 🌊 [VIBE Protocol: Spec-Synthesizer]');
      expect(report).toContain('### 💻 [Coder Contract]');
      expect(report).toContain('### 🛡️ [Auditor Verdict]');
      expect(report).toContain('✅ PASS');
    });
  });
});
