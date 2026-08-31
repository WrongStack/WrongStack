import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseNodeDependencies } from './manifest-parser.js';
import type { DetectionResult, PackageManager, TechStack, TechStackInfo } from './types.js';

interface StackSignature {
  stack: TechStack;
  packageManager: PackageManager;
  manifestFiles: string[];
  lockFiles: string[];
}

const STACK_SIGNATURES: StackSignature[] = [
  // Node.js variants - checked in order, first match wins
  {
    stack: 'nodejs',
    packageManager: 'pnpm',
    manifestFiles: ['package.json'],
    lockFiles: ['pnpm-lock.yaml'],
  },
  {
    stack: 'nodejs',
    packageManager: 'bun',
    manifestFiles: ['package.json'],
    lockFiles: ['bun.lockb', 'bun.lock'],
  },
  {
    stack: 'nodejs',
    packageManager: 'yarn',
    manifestFiles: ['package.json'],
    lockFiles: ['yarn.lock'],
  },
  {
    stack: 'nodejs',
    packageManager: 'npm',
    manifestFiles: ['package.json'],
    lockFiles: ['package-lock.json', 'npm-shrinkwrap.json'],
  },
  // Python variants
  {
    stack: 'python',
    packageManager: 'poetry',
    manifestFiles: ['pyproject.toml'],
    lockFiles: ['poetry.lock'],
  },
  {
    stack: 'python',
    packageManager: 'pip',
    manifestFiles: ['requirements.txt', 'setup.py'],
    lockFiles: [],
  },
  {
    stack: 'python',
    packageManager: 'pip',
    manifestFiles: ['pyproject.toml'],
    lockFiles: [],
  },
  // Rust
  {
    stack: 'rust',
    packageManager: 'cargo',
    manifestFiles: ['Cargo.toml'],
    lockFiles: ['Cargo.lock'],
  },
  // Go
  {
    stack: 'go',
    packageManager: 'go',
    manifestFiles: ['go.mod'],
    lockFiles: ['go.sum'],
  },
  // Java variants
  {
    stack: 'java',
    packageManager: 'gradle',
    manifestFiles: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    lockFiles: [],
  },
  {
    stack: 'java',
    packageManager: 'maven',
    manifestFiles: ['pom.xml'],
    lockFiles: [],
  },
  // .NET
  {
    stack: 'dotnet',
    packageManager: 'nuget',
    manifestFiles: ['Directory.Build.props', 'Directory.Packages.props'],
    lockFiles: ['packages.lock.json'],
  },
  {
    stack: 'dotnet',
    packageManager: 'nuget',
    manifestFiles: ['*.csproj', '*.fsproj', '*.xproj'],
    lockFiles: [],
  },
  // PHP
  {
    stack: 'php',
    packageManager: 'composer',
    manifestFiles: ['composer.json'],
    lockFiles: ['composer.lock'],
  },
  // Ruby
  {
    stack: 'ruby',
    packageManager: 'bundler',
    manifestFiles: ['Gemfile'],
    lockFiles: ['Gemfile.lock'],
  },
  // C++
  {
    stack: 'cpp',
    packageManager: 'cmake',
    manifestFiles: ['CMakeLists.txt'],
    lockFiles: [],
  },
  // Swift
  {
    stack: 'swift',
    packageManager: 'swiftpm',
    manifestFiles: ['Package.swift'],
    lockFiles: [],
  },
];

const MONOREPO_INDICATORS: Record<string, string[]> = {
  pnpm: ['pnpm-workspace.yaml'],
  npm: ['lerna.json', 'nx.json'],
  yarn: [],
  bun: [],
  cargo: [],
  go: ['go.work'],
  maven: [],
  gradle: [],
  nuget: ['Directory.Build.props'],
  pip: [],
  poetry: [],
  bundler: [],
  cmake: [],
  swiftpm: [],
  unknown: [],
};

export class TechStackDetector {
  private cachedResults = new Map<string, { result: DetectionResult; timestamp: number }>();

  constructor(
    private readonly cacheTTL = 30_000,
    private readonly maxCacheEntries = 32,
  ) {}

  async detect(projectRoot: string): Promise<DetectionResult> {
    const cached = this.cachedResults.get(projectRoot);
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      this.cachedResults.delete(projectRoot);
      this.cachedResults.set(projectRoot, cached);
      return cached.result;
    }
    if (cached) this.cachedResults.delete(projectRoot);

    const result: DetectionResult = {
      timestamp: new Date().toISOString(),
      projectRoot,
      detectedStacks: [],
      isMonorepo: false,
      workspaceConfigs: [],
    };

    const entries = await readdir(projectRoot, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => e.name);
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    const detectedStacks = new Set<TechStack>();

    for (const signature of STACK_SIGNATURES) {
      const detected = this.matchSignature(signature, files, dirs);
      if (detected) {
        // First match wins per stack type (don't detect multiple PMs for the same stack)
        if (detectedStacks.has(signature.stack)) continue;
        detectedStacks.add(signature.stack);
        detected.projectPath = projectRoot;
        detected.dependencies = await this.readDependencies(projectRoot, detected);
        result.detectedStacks.push(detected);
      }
    }

    result.isMonorepo = this.detectMonorepo(result.detectedStacks, dirs, files);

    if (result.isMonorepo) {
      result.workspaceConfigs = this.findWorkspaceConfigs(result.detectedStacks, dirs, files);
    }

    this.cachedResults.set(projectRoot, { result, timestamp: Date.now() });
    while (this.cachedResults.size > Math.max(1, this.maxCacheEntries)) {
      const oldest = this.cachedResults.keys().next().value;
      if (oldest === undefined) break;
      this.cachedResults.delete(oldest);
    }
    return result;
  }

  private async readDependencies(
    projectRoot: string,
    techStack: TechStackInfo,
  ): Promise<TechStackInfo['dependencies']> {
    if (techStack.stack !== 'nodejs' || techStack.manifestFile !== 'package.json') return [];
    try {
      return parseNodeDependencies(
        await readFile(join(projectRoot, techStack.manifestFile), 'utf-8'),
      );
    } catch {
      return [];
    }
  }

  private matchSignature(
    signature: StackSignature,
    files: string[],
    _dirs: string[],
  ): TechStackInfo | null {
    // Check manifest file exists (this is the primary signal)
    const manifestMatch = this.findMatchingManifest(signature.manifestFiles, files);
    if (!manifestMatch) return null;

    // For package managers that share a manifest file with other managers in the same stack
    // (pnpm/bun/yarn vs npm for package.json in nodejs; poetry vs pip for pyproject.toml in python),
    // require lock file presence as a positive signal before picking that package manager.
    if (
      signature.lockFiles.length > 0 &&
      (signature.stack === 'nodejs' || signature.packageManager === 'poetry')
    ) {
      const hasLockFile = signature.lockFiles.some((lock) => files.includes(lock));
      // npm is the fallback PM when no specific lock file is present
      if (!hasLockFile && signature.packageManager !== 'npm') {
        return null;
      }
    }

    return {
      stack: signature.stack,
      packageManager: signature.packageManager,
      manifestFile: manifestMatch,
      dependencies: [],
      projectPath: '',
    };
  }

  private findMatchingManifest(manifests: string[], files: string[]): string | null {
    for (const manifest of manifests) {
      if (manifest.includes('*')) {
        const escaped = manifest.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        const regex = new RegExp(`^${escaped}$`);
        const match = files.find((f) => regex.test(f));
        if (match) return match;
      } else if (files.includes(manifest)) {
        return manifest;
      }
    }
    return null;
  }

  private detectMonorepo(stacks: TechStackInfo[], dirs: string[], files: string[]): boolean {
    // Multiple different stacks = monorepo
    if (stacks.length > 1) return true;

    // pnpm always has workspace config if monorepo
    if (stacks.some((s) => s.packageManager === 'pnpm') && files.includes('pnpm-workspace.yaml')) {
      return true;
    }

    // Check workspace indicator files
    for (const stack of stacks) {
      const indicators = MONOREPO_INDICATORS[stack.packageManager];
      if (indicators?.some((ind) => files.includes(ind) || dirs.includes(ind))) {
        return true;
      }
    }

    return false;
  }

  private findWorkspaceConfigs(stacks: TechStackInfo[], dirs: string[], files: string[]): string[] {
    const configs: string[] = [];
    for (const stack of stacks) {
      const indicators = MONOREPO_INDICATORS[stack.packageManager];
      if (indicators) {
        configs.push(...indicators.filter((ind) => files.includes(ind) || dirs.includes(ind)));
      }
    }
    return [...new Set(configs)];
  }

  clearCache(): void {
    this.cachedResults.clear();
  }
}

export const defaultTechStackDetector = new TechStackDetector();
