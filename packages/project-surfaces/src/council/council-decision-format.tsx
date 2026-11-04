import { Award, Coins, Shield, ShieldAlert, Users, Wrench, Zap } from 'lucide-react';
import type { CouncilDecisionData, CouncilSeatVote } from './types';

export const OPTION_THEME_CLASSES = [
  { bg: 'bg-success', text: 'text-success', badge: 'bg-success/15 text-success border-success/30' },
  { bg: 'bg-info', text: 'text-info', badge: 'bg-info/15 text-info border-info/30' },
  { bg: 'bg-warning', text: 'text-warning', badge: 'bg-warning/15 text-warning border-warning/30' },
  { bg: 'bg-primary', text: 'text-primary', badge: 'bg-primary/15 text-primary border-primary/30' },
  {
    bg: 'bg-destructive',
    text: 'text-destructive',
    badge: 'bg-destructive/15 text-destructive border-destructive/30',
  },
  {
    bg: 'bg-accent',
    text: 'text-accent-foreground',
    badge: 'bg-accent/40 text-accent-foreground border-border',
  },
];

/** Parse legacy or replayed markdown into a structured CouncilDecisionData fallback */
export function parseCouncilMarkdown(content: string): CouncilDecisionData | null {
  if (!content.includes('Council') && !content.includes('⚖️')) return null;
  const isCouncil =
    content.startsWith('⚖️') ||
    content.includes('Council resolved') ||
    content.includes('Council veto');
  if (!isCouncil) return null;

  const lines = content.split('\n');
  const firstLine = lines[0] ?? '';
  const isVeto = firstLine.toLowerCase().includes('veto');
  const isJudge = firstLine.toLowerCase().includes('judge');

  const seats: CouncilSeatVote[] = [];
  const warnings: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (line.startsWith('> ⚠')) {
      warnings.push(line.replace(/^>\s*⚠\s*/, ''));
      continue;
    }
    if (line.startsWith('- **')) {
      const match = line.match(
        /^-\s*\*\*([^*]+)\*\*(?:\s*\(([^)]+)\))?\s*→\s*([^·]+)(?:\s*·\s*`([^`]+)`)?/,
      );
      if (match) {
        const persona = match[1] ?? 'voter';
        const vetoTag = (match[2] ?? '').includes('veto');
        const optionId = (match[3] ?? '').trim();
        const model = match[4]?.trim();
        seats.push({
          seatId: `seat-${i}`,
          persona,
          status: 'valid',
          optionId,
          model,
          veto: vetoTag,
          at: Date.now(),
        });
      }
    }
  }

  return {
    requestId: 'replayed-council',
    phase: 'resolved',
    status: isVeto ? 'denied' : 'decided',
    resolution: isVeto ? 'veto' : isJudge ? 'judge' : 'decided',
    judgeUsed: isJudge,
    validVoteCount: seats.length,
    configuredSeatCount: seats.length,
    distinctTargetCount: new Set(seats.map((s) => s.model || s.persona)).size,
    warnings: warnings.length > 0 ? warnings : undefined,
    seats,
  };
}

export function getPersonaIcon(persona: string) {
  const p = persona.toLowerCase();
  if (p.includes('executor') || p.includes('action')) return <Zap className="h-3.5 w-3.5" />;
  if (p.includes('skeptic')) return <ShieldAlert className="h-3.5 w-3.5" />;
  if (p.includes('security')) return <Shield className="h-3.5 w-3.5" />;
  if (p.includes('auditor') || p.includes('cost') || p.includes('budget'))
    return <Coins className="h-3.5 w-3.5" />;
  if (p.includes('maintainer') || p.includes('architect'))
    return <Wrench className="h-3.5 w-3.5" />;
  if (p.includes('user') || p.includes('advocate')) return <Users className="h-3.5 w-3.5" />;
  return <Award className="h-3.5 w-3.5" />;
}

export function getPersonaColor(persona: string) {
  const p = persona.toLowerCase();
  if (p.includes('executor')) return 'bg-warning/20 text-warning border-warning/30';
  if (p.includes('skeptic') || p.includes('security'))
    return 'bg-destructive/20 text-destructive border-destructive/30';
  if (p.includes('auditor')) return 'bg-info/20 text-info border-info/30';
  if (p.includes('maintainer')) return 'bg-success/20 text-success border-success/30';
  return 'bg-primary/20 text-primary border-primary/30';
}
