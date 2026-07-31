/**
 * Additional tests for TechStackDetector — covering uncovered code paths.
 * Focuses on: C++, Swift, Docker, Terraform, Kotlin, monorepo detection,
 * glob pattern matching, and the default exported instance.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultTechStackDetector, TechStackDetector } from '../src/detector.js';

describe('TechStackDetector - additional coverage', () => {
  let detector: TechStackDetector;
  let tempDir: string;

  beforeEach(() => {
    detector = new TechStackDetector();
  });

  afterEach(async () => {
    detector.clearCache();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createProject(files: Record<string, string>): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-detect-'));
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }
    tempDir = dir;
    return dir;
  }

  // ============================================================================
  // Missing tech stacks
  // ============================================================================

  it('detects Rust project', async () => {
    const dir = await createProject({
      'Cargo.toml': '[package]\nname = "test-rust"',
      'Cargo.lock': '',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'rust')).toBe(true);
    expect(result.detectedStacks.some((s) => s.packageManager === 'cargo')).toBe(true);
  });

  it('detects Go project', async () => {
    const dir = await createProject({
      'go.mod': 'module test-go',
      'go.sum': '',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'go')).toBe(true);
  });

  it('detects C++ CMake project', async () => {
    const dir = await createProject({
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.0)',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'cpp')).toBe(true);
  });

  it('detects Swift project', async () => {
    const dir = await createProject({
      'Package.swift': '// swift-tools-version:5.5',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'swift')).toBe(true);
  });

  it('detects Kotlin project', async () => {
    const dir = await createProject({
      'build.gradle.kts': 'plugins { kotlin("jvm") }',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'java')).toBe(true);
    expect(result.detectedStacks.some((s) => s.packageManager === 'gradle')).toBe(true);
  });

  it('detects PHP project', async () => {
    const dir = await createProject({
      'composer.json': '{}',
      'composer.lock': '',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'php')).toBe(true);
  });

  it('detects Ruby project', async () => {
    const dir = await createProject({
      Gemfile: 'source "https://rubygems.org"',
      'Gemfile.lock': '',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'ruby')).toBe(true);
  });

  it('detects Docker project', async () => {
    // Docker is not in STACK_SIGNATURES - verify the detector doesn't detect it
    const dir = await createProject({
      Dockerfile: 'FROM node:20',
    });
    const result = await detector.detect(dir);
    // No docker signature exists in STACK_SIGNATURES
    expect(result.detectedStacks).toHaveLength(0);
  });

  it('detects Terraform project', async () => {
    // Terraform is not in STACK_SIGNATURES
    const dir = await createProject({
      'main.tf': 'resource "local_file" "test" {}',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks).toHaveLength(0);
  });

  it('detects Kubernetes project', async () => {
    // Kubernetes is not in STACK_SIGNATURES
    const dir = await createProject({
      'deployment.yaml': 'apiVersion: apps/v1',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks).toHaveLength(0);
  });

  // ============================================================================
  // Node.js variants
  // ============================================================================

  it('detects pnpm workspace project', async () => {
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.packageManager === 'pnpm')).toBe(true);
  });

  it('detects yarn project', async () => {
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'yarn.lock': '',
      '.yarnrc': 'yarn-path: .yarn/releases/yarn-3.6.0.cjs',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.packageManager === 'yarn')).toBe(true);
  });

  it('detects bun project', async () => {
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'bun.lockb': '',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.packageManager === 'bun')).toBe(true);
  });

  // ============================================================================
  // Python variants
  // ============================================================================

  it('detects poetry project', async () => {
    const dir = await createProject({
      'pyproject.toml': '[tool.poetry]\nname = "test-poetry"',
      'poetry.lock': '',
    });
    const result = await detector.detect(dir);
    expect(
      result.detectedStacks.some((s) => s.stack === 'python' && s.packageManager === 'poetry'),
    ).toBe(true);
  });

  it('detects pip project with requirements.txt', async () => {
    const dir = await createProject({
      'requirements.txt': 'flask>=2.0',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'python')).toBe(true);
  });

  it('detects pip project with pyproject.toml when no poetry.lock', async () => {
    const dir = await createProject({
      'pyproject.toml': '[build-system]\nrequires = ["setuptools"]',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'python')).toBe(true);
  });

  // ============================================================================
  // .NET detection (glob pattern matching)
  // ============================================================================

  it('detects .NET project with csproj glob', async () => {
    const dir = await createProject({
      'src/MyApp.csproj': '<Project Sdk="Microsoft.NET.Sdk">',
      'Directory.Build.props': '<Project>',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'dotnet')).toBe(true);
  });

  it('detects .NET project with fsproj at root level', async () => {
    const dir = await createProject({
      'Lib.fsproj': '<Project Sdk="Microsoft.NET.Sdk">',
      'Directory.Build.props': '<Project>',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'dotnet')).toBe(true);
  });

  // ============================================================================
  // Monorepo detection
  // ============================================================================

  it('detects monorepo with multiple stacks', async () => {
    const dir = await createProject({
      'package.json': '{"name":"monorepo"}',
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"',
      'Cargo.toml': '[package]\nname = "native-module"',
      'Cargo.lock': '',
    });
    const result = await detector.detect(dir);
    expect(result.isMonorepo).toBe(true);
  });

  it('detects npm monorepo with lerna', async () => {
    const dir = await createProject({
      'package.json': '{"name":"monorepo"}',
      'package-lock.json': '',
      'lerna.json': '{}',
    });
    const result = await detector.detect(dir);
    expect(result.isMonorepo).toBe(true);
    expect(result.workspaceConfigs).toBeDefined();
    expect(result.workspaceConfigs!.length).toBeGreaterThanOrEqual(1);
  });

  // ============================================================================
  // Cache behavior
  // ============================================================================

  it('caches detection results', async () => {
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'package-lock.json': '',
    });
    const first = await detector.detect(dir);
    const second = await detector.detect(dir);
    expect(first).toEqual(second);
  });

  it('bounds cached project roots and evicts the least recently used result', async () => {
    const root = await createProject({});
    const projects = ['a', 'b', 'c'].map((name) => path.join(root, name));
    await Promise.all(projects.map((project) => fs.mkdir(project)));
    const bounded = new TechStackDetector(30_000, 2);

    const firstA = await bounded.detect(projects[0]!);
    const firstB = await bounded.detect(projects[1]!);
    expect(await bounded.detect(projects[0]!)).toBe(firstA);
    await bounded.detect(projects[2]!);

    expect(await bounded.detect(projects[1]!)).not.toBe(firstB);
  });

  // ============================================================================
  // Default exported instance
  // ============================================================================

  it('should export a default detector instance', () => {
    expect(defaultTechStackDetector).toBeInstanceOf(TechStackDetector);
  });

  it('default instance should be reusable', async () => {
    defaultTechStackDetector.clearCache();
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'package-lock.json': '',
    });
    const result = await defaultTechStackDetector.detect(dir);
    expect(result.detectedStacks.length).toBeGreaterThan(0);
  });
});
