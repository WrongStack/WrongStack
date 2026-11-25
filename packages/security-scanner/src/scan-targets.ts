import type { TechStack, TechStackInfo } from './types.js';

/**
 * The files a scan reads for a stack. Only these extensions are gathered, so a
 * stack's own source forms must all be here: `.tsx`/`.jsx`/`.mjs`/`.cjs` were
 * missing (React components and ESM/CJS scripts went unscanned), `.kt` for the
 * Gradle-detected `java` stack, and C sources for the CMake `cpp` stack.
 */
export function getTargetFilesForStack(techStack: Pick<TechStackInfo, 'stack'>): string[] {
  const filesByStack: Record<TechStack, string[]> = {
    nodejs: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.mts',
      '**/*.cts',
      '**/*.js',
      '**/*.jsx',
      '**/*.mjs',
      '**/*.cjs',
      '**/*.json',
      '**/.env*',
      '**/.npmrc',
      '**/package.json',
      '**/tsconfig.json',
    ],
    python: ['**/*.py', '**/requirements*.txt', '**/setup.py', '**/pyproject.toml', '**/.env*'],
    rust: ['**/*.rs', '**/Cargo.toml', '**/Cargo.lock'],
    go: ['**/*.go', '**/go.mod', '**/go.sum'],
    java: ['**/*.java', '**/*.kt', '**/*.kts', '**/pom.xml', '**/build.gradle', '**/*.properties'],
    dotnet: ['**/*.cs', '**/*.csproj', '**/*.config', '**/appsettings.json'],
    php: ['**/*.php', '**/.env*', '**/composer.json'],
    ruby: ['**/*.rb', '**/Gemfile', '**/.env*'],
    cpp: [
      '**/*.cpp',
      '**/*.cc',
      '**/*.cxx',
      '**/*.hpp',
      '**/*.hh',
      '**/*.c',
      '**/*.h',
      '**/CMakeLists.txt',
    ],
    c: ['**/*.c', '**/*.h'],
    kotlin: ['**/*.kt', '**/*.kts', '**/build.gradle.kts'],
    swift: ['**/*.swift', '**/Package.swift'],
    unknown: ['**/*'],
  };

  return Object.hasOwn(filesByStack, techStack.stack)
    ? filesByStack[techStack.stack]
    : filesByStack.unknown;
}
