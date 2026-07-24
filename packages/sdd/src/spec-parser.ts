import type {
  SpecAnalysis,
  Specification,
  SpecRequirement,
  SpecSection,
  SpecValidationResult,
} from '@wrongstack/core/types';

export class SpecParser {
  parse(content: string): Specification {
    const lines = content.split('\n');
    const sections = this.extractSections(lines);
    const requirements = this.extractRequirements(lines);
    const now = Date.now();

    return {
      id: crypto.randomUUID(),
      title: this.extractTitle(lines),
      version: this.extractVersion(lines),
      status: 'draft',
      overview: this.extractOverview(lines),
      sections,
      requirements,
      createdAt: now,
      updatedAt: now,
    };
  }

  private extractTitle(lines: string[]): string {
    for (const line of lines) {
      const m = /^#\s+(.+)/.exec(line.trim());
      if (m?.[1]) return m[1];
    }
    return 'Untitled Specification';
  }

  private extractVersion(lines: string[]): string {
    for (const line of lines) {
      const m = /version[:\s]+(\d+\.\d+\.\d+)/i.exec(line.trim());
      if (m?.[1]) return m[1];
    }
    return '0.0.1';
  }

  private extractOverview(lines: string[]): string {
    const overviewLines: string[] = [];
    let inOverview = false;
    let foundHeading = false;

    for (const line of lines) {
      if (/^##\s+Overview/i.test(line.trim())) {
        inOverview = true;
        foundHeading = true;
        continue;
      }
      if (foundHeading && /^##\s+/.test(line.trim())) break;
      if (inOverview) overviewLines.push(line);
    }

    return overviewLines.join('\n').trim() || 'No overview provided';
  }

  private extractSections(lines: string[]): SpecSection[] {
    const sections: SpecSection[] = [];
    let currentSection: Partial<SpecSection> | null = null;
    let currentLines: string[] = [];
    let depth = 1;

    for (const line of lines) {
      const h2 = /^##\s+(.+)/.exec(line.trim());
      const h3 = /^###\s+(.+)/.exec(line.trim());

      if (h2) {
        if (currentSection && currentLines.length > 0) {
          sections.push({
            type: this.mapSectionType(currentSection.title!),
            title: currentSection.title!,
            level: depth,
            content: currentLines.join('\n').trim(),
          });
        }
        currentSection = { title: h2[1]! };
        currentLines = [];
        depth = 2;
        continue;
      }

      if (h3) {
        currentLines.push(line);
        continue;
      }

      if (currentSection) {
        currentLines.push(line);
      }
    }

    if (currentSection && currentLines.length > 0) {
      sections.push({
        type: this.mapSectionType(currentSection.title!),
        title: currentSection.title!,
        level: depth,
        content: currentLines.join('\n').trim(),
      });
    }

    return sections;
  }

  private extractRequirements(lines: string[]): SpecRequirement[] {
    const requirements: SpecRequirement[] = [];
    let inRequirements = false;
    let idCounter = 0;

    for (const line of lines) {
      if (/^##\s+Requirements/i.test(line.trim())) {
        inRequirements = true;
        continue;
      }
      if (inRequirements && /^##\s+/.test(line.trim())) break;

      if (inRequirements) {
        const req = this.parseRequirementLine(line, `REQ-${++idCounter}`);
        if (req) requirements.push(req);
      }
    }

    return requirements;
  }

  private parseRequirementLine(line: string, id: string): SpecRequirement | null {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;

    const lower = trimmed.toLowerCase();
    const types: SpecRequirement['type'][] = [
      'functional',
      'non-functional',
      'security',
      'performance',
      'ux',
    ];
    let type: SpecRequirement['type'] = 'functional';
    for (const t of types) {
      if (lower.includes(`[${t}]`)) type = t;
    }

    let priority: SpecRequirement['priority'] = 'medium';
    if (trimmed.includes('[critical]') || trimmed.includes('[prio:high]')) {
      priority = 'critical';
    } else if (trimmed.includes('[high]')) {
      priority = 'high';
    } else if (trimmed.includes('[low]')) {
      priority = 'low';
    }

    return {
      id,
      type,
      priority,
      description: trimmed.replace(/\[[^\]]+\]/g, '').trim(),
      acceptanceCriteria: [],
    };
  }

  private mapSectionType(title: string): SpecSection['type'] {
    const t = title.toLowerCase();
    if (t.includes('overview')) return 'overview';
    if (t.includes('requirement')) return 'requirements';
    if (t.includes('architect')) return 'architecture';
    if (t.includes('api')) return 'api';
    if (t.includes('data')) return 'data';
    if (t.includes('security')) return 'security';
    if (t.includes('acceptance')) return 'acceptance';
    return 'overview';
  }

  analyze(spec: Specification): SpecAnalysis {
    const gaps: string[] = [];
    const suggestions: string[] = [];
    const risks: SpecAnalysis['risks'] = [];

    // Check completeness
    const hasOverview = spec.sections.some((s) => s.type === 'overview');
    const hasRequirements = spec.sections.some((s) => s.type === 'requirements');
    const hasAcceptance = spec.sections.some((s) => s.type === 'acceptance');

    if (!hasOverview) gaps.push('Missing Overview section');
    if (!hasRequirements) gaps.push('Missing Requirements section');
    if (!hasAcceptance) gaps.push('Missing Acceptance Criteria section');

    if (spec.requirements.length === 0) {
      gaps.push('No requirements defined');
      suggestions.push('Add specific functional and non-functional requirements');
    }

    const unverifiedReqs = spec.requirements.filter((r) => r.acceptanceCriteria.length === 0);
    if (unverifiedReqs.length > 0) {
      gaps.push(`${unverifiedReqs.length} requirements without acceptance criteria`);
      suggestions.push('Define clear acceptance criteria for each requirement');
    }

    const criticalUnresolved = spec.requirements.filter(
      (r) => r.priority === 'critical' && r.blockedBy && r.blockedBy.length > 0,
    );
    for (const req of criticalUnresolved) {
      risks.push({
        requirement: req.id,
        risk: `Critical requirement blocked by ${req.blockedBy?.length} other requirements`,
        severity: 'high',
      });
    }

    const completeness = Math.round(
      (((hasOverview ? 1 : 0) +
        (hasRequirements ? 1 : 0) +
        (hasAcceptance ? 1 : 0) +
        (spec.requirements.length > 0 ? 1 : 0) +
        (spec.sections.length > 3 ? 1 : 0)) /
        5) *
        100,
    );

    return {
      specId: spec.id,
      completeness,
      coverage: {
        requirements: spec.requirements.length,
        apiEndpoints: spec.apiEndpoints?.length ?? 0,
        edgeCases: 0,
        errorHandling: 0,
      },
      gaps,
      risks,
      suggestions,
    };
  }

  validate(spec: Specification): SpecValidationResult {
    const errors: SpecValidationResult['errors'] = [];
    const warnings: SpecValidationResult['warnings'] = [];

    if (!spec.title.trim()) {
      errors.push({ path: 'title', message: 'Title is required' });
    }

    if (!spec.version.trim()) {
      errors.push({ path: 'version', message: 'Version is required' });
    }

    for (const req of spec.requirements) {
      if (!req.description.trim()) {
        errors.push({ path: `requirement.${req.id}`, message: 'Requirement description is empty' });
      }
      if (req.acceptanceCriteria.length === 0) {
        warnings.push({ path: `requirement.${req.id}`, message: 'No acceptance criteria defined' });
      }
    }

    const reqIds = new Set(spec.requirements.map((r) => r.id));
    const blockedByIds = new Set(spec.requirements.flatMap((r) => r.blockedBy ?? []));
    for (const id of blockedByIds) {
      if (!reqIds.has(id)) {
        errors.push({
          path: 'requirements',
          message: `BlockedBy references non-existent requirement: ${id}`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
