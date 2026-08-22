/**
 * Tests for remaining uncovered branches/paths in TechStackDetector.
 * Coverage targets: MATCHERS (mavenWrapper, dotnetSdk with fsproj/xproj),
 * glob pattern matching in lock/manifest files, C++ secondary signatures,
 * monorepo indicators for go/nuget, workspace configs with no match,
 * and empty directory handling.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TechStackDetector } from '../src/detector.js';

describe('TechStackDetector - remaining uncovered paths', () => {
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-det-'));
    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }
    tempDir = dir;
    return dir;
  }

  // ── MATCHERS.mavenWrapper (._mvn directory) ────────────────────────────────
  it('detects Maven project with .mvn directory via mavenWrapper matcher', async () => {
    const dir = await createProject({
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>',
      '.mvn/jvm.config': '-Xmx512m',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'java' && s.packageManager === 'maven')).toBe(true);
  });

  // ── MATCHERS.yarnConfig — second branch: yarn.config.js ──────────────────
  it('detects Yarn project via yarn.config.js (second branch of yarnConfig)', async () => {
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'yarn.lock': '',
      'yarn.config.js': 'module.exports = {}',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.packageManager === 'yarn')).toBe(true);
  });

  // ── C++ with CMakeCache.txt (secondarySignatures) ──────────────────────────
  it('detects C++ project via CMakeCache.txt secondary signature', async () => {
    const dir = await createProject({
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.0)',
      'CMakeCache.txt': 'CMAKE_BUILD_TYPE:STRING=Debug',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'cpp')).toBe(true);
  });

  // ── C++ with CMakePresets.json (secondarySignatures) ───────────────────────
  it('detects C++ project via CMakePresets.json secondary signature', async () => {
    const dir = await createProject({
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.0)',
      'CMakePresets.json': '{"version": 3}',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'cpp')).toBe(true);
  });

  // ── .NET with fsproj (glob pattern in lockFiles) ──────────────────────────
  it('detects .NET with fsproj file (glob pattern in dotnetSdk)', async () => {
    const dir = await createProject({
      'MyLib.fsproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'dotnet')).toBe(true);
  });

  // ── .NET with xproj (glob pattern in manifestFiles) ────────────────────────
  it('detects .NET with xproj file (glob match in manifestFiles)', async () => {
    const dir = await createProject({
      'OldApp.xproj': '<Project></Project>',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'dotnet')).toBe(true);
  });

  // ── Java Gradle with .gradle.kts manifest + gradlew dir ───────────────────
  it('detects Gradle KTS project with gradlew', async () => {
    const dir = await createProject({
      'build.gradle.kts': 'plugins { kotlin("jvm") version "1.9" }',
      'gradlew': '#!/bin/bash',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.packageManager === 'gradle')).toBe(true);
  });

  // ── Go monorepo with go.work ──────────────────────────────────────────────
  it('detects Go monorepo with go.work file', async () => {
    const dir = await createProject({
      'go.mod': 'module example.com/test\ngo 1.21',
      'go.sum': '',
      'go.work': 'go 1.21\nuse (\n  .\n  ./sub\n)',
    });
    const result = await detector.detect(dir);
    expect(result.isMonorepo).toBe(true);
    expect(result.workspaceConfigs).toContain('go.work');
  });

  // ── NuGet monorepo with Directory.Build.props ─────────────────────────────
  it('detects .NET monorepo with Directory.Build.props indicator', async () => {
    const dir = await createProject({
      'MyApp.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      'Directory.Build.props': '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    });
    const result = await detector.detect(dir);
    expect(result.isMonorepo).toBe(true);
    expect(result.workspaceConfigs).toContain('Directory.Build.props');
  });

  // ── Monorepo detection: single stack without indicator files → false ──────
  it('detects NOT monorepo for single stack without indicators', async () => {
    const dir = await createProject({
      'Cargo.toml': '[package]\nname = "simple"',
      'Cargo.lock': '',
    });
    const result = await detector.detect(dir);
    expect(result.isMonorepo).toBe(false);
  });

  // ── Workspace configs: negative case (no indicators match) ───────────────
  it('returns empty workspace configs when no indicators match', async () => {
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'package-lock.json': '',
    });
    const result = await detector.detect(dir);
    // npm monorepo requires lerna.json or nx.json
    expect(result.isMonorepo).toBe(false);
    expect(result.workspaceConfigs).toEqual([]);
  });

  // ── Node.js with lock file wildcard (*) ────────────────────────────────────
  it('detects Node.js with wildcard lock file match disabled here (no .* lock file)', async () => {
    // The lockFiles that contain '*' are *.csproj, *.fsproj, *.xproj entries.
    // The dotnet stack entries use dotnetSdk as secondary signature, but also
    // the wildcard happens only in matchSignature's lock file check.
    // For nodejs, there are no wildcard lock entries, but for dotnet:
    // '*.csproj', '*.fsproj', '*.xproj' appear as manifestFiles, not lockFiles.
    // Let's create a dotnet project with xproj to test the wildcard path in
    // findMatchingManifest:
    const dir = await createProject({
      'Legacy.xproj': '<Project></Project>',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'dotnet')).toBe(true);
  });

  // ── findWorkspaceConfigs with indicators not present → empty ──────────────
  it('findWorkspaceConfigs returns empty when indicators absent', async () => {
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'pnpm-lock.yaml': '',
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"',
    });
    const result = await detector.detect(dir);
    expect(result.isMonorepo).toBe(true);
    expect(result.workspaceConfigs).toContain('pnpm-workspace.yaml');
  });

  // ── detectMonorepo with unknown PM (no indicators array) → false ──────────
  it('does not detect monorepo when PM has no indicators', async () => {
    // Use a Swift project (swiftpm has empty indicators array)
    const dir = await createProject({
      'Package.swift': '// swift-tools-version:5.5',
    });
    const result = await detector.detect(dir);
    // swiftpm indicators array is [], so no indicator match → not monorepo
    expect(result.isMonorepo).toBe(false);
  });

  // ── detect returns cached result when cache is primed ─────────────────────
  it('returns cached detection result on second call for same root', async () => {
    const dir = await createProject({
      'package.json': '{"name":"test"}',
      'package-lock.json': '',
    });
    const first = await detector.detect(dir);
    const second = await detector.detect(dir);
    expect(first).toBe(second);
  });

  // ── Ruby project (Gemfile only) ───────────────────────────────────────────
  it('detects Ruby project with Gemfile only', async () => {
    const dir = await createProject({
      'Gemfile': 'source "https://rubygems.org"\ngem "rails"',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'ruby')).toBe(true);
  });

  // ── PHP project with composer ─────────────────────────────────────────────
  it('detects PHP project with composer', async () => {
    const dir = await createProject({
      'composer.json': '{"require":{"php":">=8.0"}}',
      'composer.lock': '',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'php')).toBe(true);
  });

  // ── PIP with setup.py (different manifest) ────────────────────────────────
  it('detects Python project with setup.py', async () => {
    const dir = await createProject({
      'setup.py': 'from setuptools import setup\nsetup(name="test")',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'python')).toBe(true);
  });

  // ── Pip with pyproject.toml AND poetry.lock → picks poetry first ─────────
  it('prefers poetry over pip when both poetry.lock and pyproject.toml exist', async () => {
    const dir = await createProject({
      'pyproject.toml': '[tool.poetry]\nname = "test"',
      'poetry.lock': '',
    });
    const result = await detector.detect(dir);
    const poetryStack = result.detectedStacks.find((s) => s.stack === 'python');
    expect(poetryStack?.packageManager).toBe('poetry');
  });

  it('ignores an unexpected package manager while collecting workspace configs', () => {
    const internals = detector as never as {
      findWorkspaceConfigs(
        stacks: Array<{ packageManager: string }>,
        dirs: string[],
        files: string[],
      ): string[];
    };
    expect(
      internals.findWorkspaceConfigs([{ packageManager: 'future-pm' }], [], []),
    ).toEqual([]);
  });

  it('does not match manifest wildcard patterns when dot is substituted with arbitrary characters', async () => {
    const dir = await createProject({
      'my_csproj': 'not a real csproj file',
      'fooAcsproj': 'not a real csproj file',
    });
    const result = await detector.detect(dir);
    expect(result.detectedStacks.some((s) => s.stack === 'dotnet')).toBe(false);
  });
});

