import type {
  SpecAnalysis,
  Specification,
  SpecRequirement,
  SpecSection,
  SpecValidationResult,
} from '@wrongstack/contracts/types';

export class SpecParser {
  parse(content: string): Specification {
    // Split on every line ending: a CRLF spec left `\r` on each line, and the
    // fence matcher's `(.*)$` cannot cross it — fenced code then parsed as
    // requirements and a `##` inside the fence ended the section early.
    const lines = content.split(/\r\n?|\n/);
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
    let fence: string | undefined;

    for (const line of lines) {
      // A fenced code block is verbatim content, not document structure: a `#`
      // comment inside a snippet is not the spec's title.
      const nextFence = this.updateFence(line, fence);
      const inFence = fence !== undefined || nextFence !== undefined;
      fence = nextFence;
      if (inFence) continue;

      const m = /^#\s+(.+)/.exec(line.trim());
      if (m?.[1]) return m[1];
    }
    return 'Untitled Specification';
  }

  private extractVersion(lines: string[]): string {
    let fence: string | undefined;

    for (const line of lines) {
      // Same rule as the title: a `Version:` line inside a fenced block is
      // sample content, not the spec's version.
      const nextFence = this.updateFence(line, fence);
      const inFence = fence !== undefined || nextFence !== undefined;
      fence = nextFence;
      if (inFence) continue;

      const m = /version[:\s]+(\d+\.\d+\.\d+)/i.exec(line.trim());
      if (m?.[1]) return m[1];
    }
    return '0.0.1';
  }

  private updateFence(line: string, fence: string | undefined): string | undefined {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const markerRun = marker?.[1];
    if (fence) {
      if (
        markerRun &&
        markerRun[0] === fence[0] &&
        markerRun.length >= fence.length &&
        !marker?.[2]?.trim()
      ) {
        return undefined;
      }
      return fence;
    }
    return markerRun;
  }

  private extractOverview(lines: string[]): string {
    const overviewLines: string[] = [];
    let inOverview = false;
    let foundHeading = false;
    let fence: string | undefined;

    for (const line of lines) {
      const nextFence = this.updateFence(line, fence);
      const inFence = fence !== undefined || nextFence !== undefined;
      fence = nextFence;
      if (!inFence) {
        if (/^##\s+Overview/i.test(line.trim())) {
          inOverview = true;
          foundHeading = true;
          continue;
        }
        if (foundHeading && /^##\s+/.test(line.trim())) break;
      }
      if (inOverview) overviewLines.push(line);
    }

    return overviewLines.join('\n').trim() || 'No overview provided';
  }

  private extractSections(lines: string[]): SpecSection[] {
    const sections: SpecSection[] = [];
    let currentSection: Partial<SpecSection> | null = null;
    let currentLines: string[] = [];
    let depth = 1;
    let fence: string | undefined;

    for (const line of lines) {
      const nextFence = this.updateFence(line, fence);
      const inFence = fence !== undefined || nextFence !== undefined;
      fence = nextFence;

      if (!inFence) {
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
    let fence: string | undefined;
    let inComment = false;

    for (const line of lines) {
      let visible = line;
      let hadComment = false;

      if (inComment) {
        // Every line of an HTML comment is comment content: nothing in it can
        // be a requirement, and a fence marker inside it does not open a code
        // block. Only the text after the comment's closing marker is visible.
        const comment = this.stripHtmlComments(line, true);
        inComment = comment.inComment;
        if (inComment) continue;
        visible = comment.visible;
        hadComment = true;
      } else {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        const markerRun = marker?.[1];
        if (fence) {
          if (
            markerRun &&
            markerRun[0] === fence[0] &&
            markerRun.length >= fence.length &&
            !marker?.[2]?.trim()
          ) {
            fence = undefined;
          }
          continue;
        }
        if (marker) {
          fence = marker[1];
          continue;
        }

        // An HTML comment is invisible content, not document structure: a
        // comment line is not a requirement, and a comment inside a requirement
        // line is not part of its description.
        const comment = this.stripHtmlComments(line, false);
        inComment = comment.inComment;
        visible = comment.visible;
        hadComment = comment.hadComment;
      }

      // The heading match keeps the ORIGINAL line, so a heading that is only
      // partly commented out is not newly promoted to document structure;
      // only the requirement text itself is read from `visible`.
      if (/^##\s+Requirements/i.test(line.trim())) {
        inRequirements = true;
        continue;
      }
      if (inRequirements && /^##\s+/.test(line.trim())) break;

      if (inRequirements) {
        // A line that carried only a comment — the `<!-- ... -->` form, or
        // the `_<!-- ... -->_` placeholder `templateToMarkdown` emits — holds
        // no requirement text and is skipped.
        if (hadComment && !/[\p{L}\p{N}]/u.test(visible)) continue;
        const req = this.parseRequirementLine(visible, `REQ-${idCounter + 1}`);
        if (req) {
          idCounter += 1;
          requirements.push(req);
        }
      }
    }

    return requirements;
  }

  /**
   * Split a line into the text visible outside HTML comments and the comment
   * state that carries into the next line.
   *
   * `<!--` opens a comment and `-->` closes it; the closing marker need not
   * be on the opening line, so the state spans lines. `hadComment` is true
   * when the line contained any part of a comment region.
   */
  private stripHtmlComments(
    line: string,
    inComment: boolean,
  ): { visible: string; inComment: boolean; hadComment: boolean } {
    let visible = '';
    let rest = line;
    let open = inComment;
    let hadComment = inComment;

    while (rest.length > 0) {
      if (open) {
        const end = rest.indexOf('-->');
        if (end === -1) return { visible, inComment: true, hadComment: true };
        rest = rest.slice(end + 3);
        open = false;
        hadComment = true;
        continue;
      }
      const start = rest.indexOf('<!--');
      if (start === -1) {
        visible += rest;
        break;
      }
      hadComment = true;
      visible += rest.slice(0, start);
      rest = rest.slice(start + 4);
      open = true;
    }

    return { visible, inComment: open, hadComment };
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
    if (lower.includes('[critical]') || lower.includes('[prio:high]')) {
      priority = 'critical';
    } else if (lower.includes('[high]')) {
      priority = 'high';
    } else if (lower.includes('[low]')) {
      priority = 'low';
    }

    return {
      id,
      type,
      priority,
      description: trimmed
        .replace(
          /\[(?:functional|non-functional|security|performance|ux|critical|high|medium|low|prio:high)\]/gi,
          '',
        )
        .trim(),
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
