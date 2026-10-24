export type SpecStatus = 'draft' | 'review' | 'approved' | 'implemented' | 'deprecated';
export type SpecSectionType =
  | 'overview'
  | 'requirements'
  | 'architecture'
  | 'api'
  | 'data'
  | 'security'
  | 'acceptance';

export interface SpecSection {
  type: SpecSectionType;
  title: string;
  content: string;
  level: number;
  children?: SpecSection[] | undefined;
}

export interface SpecRequirement {
  id: string;
  type: 'functional' | 'non-functional' | 'security' | 'performance' | 'ux';
  priority: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  acceptanceCriteria: string[];
  blockedBy?: string[] | undefined;
  implements?: string[] | undefined;
}

export interface SpecApiEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  description: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  auth?: boolean | undefined;
}

export interface Specification {
  id: string;
  title: string;
  version: string;
  status: SpecStatus;
  overview: string;
  sections: SpecSection[];
  requirements: SpecRequirement[];
  apiEndpoints?: SpecApiEndpoint[] | undefined;
  dependencies?: string[] | undefined;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface SpecAnalysis {
  specId: string;
  completeness: number; // 0-100
  coverage: {
    requirements: number;
    apiEndpoints: number;
    edgeCases: number;
    errorHandling: number;
  };
  gaps: string[];
  risks: { requirement: string; risk: string; severity: 'high' | 'medium' | 'low' }[];
  suggestions: string[];
}

export interface SpecValidationResult {
  valid: boolean;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
}

export interface SpecTemplate {
  id: string;
  name: string;
  description: string;
  sections: Omit<SpecSection, 'content'>[];
  defaultRequirements: Omit<SpecRequirement, 'id' | 'description'>[];
}

export const DEFAULT_SPEC_TEMPLATE: SpecTemplate = {
  id: 'default',
  name: 'Default Feature Spec',
  description: 'Standard template for feature specifications',
  sections: [
    { type: 'overview', title: 'Overview', level: 1 },
    { type: 'requirements', title: 'Requirements', level: 1 },
    { type: 'architecture', title: 'Architecture', level: 1 },
    { type: 'api', title: 'API Design', level: 1 },
    { type: 'data', title: 'Data Model', level: 1 },
    { type: 'security', title: 'Security', level: 1 },
    { type: 'acceptance', title: 'Acceptance Criteria', level: 1 },
  ],
  defaultRequirements: [
    { type: 'functional', priority: 'high', acceptanceCriteria: [], blockedBy: [], implements: [] },
    {
      type: 'non-functional',
      priority: 'medium',
      acceptanceCriteria: [],
      blockedBy: [],
      implements: [],
    },
  ],
};
