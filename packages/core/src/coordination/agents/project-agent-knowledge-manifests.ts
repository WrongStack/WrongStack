import type { RoleKnowledgeManifest } from './project-agent-identity-types.js';

export const BUILT_IN_KNOWLEDGE_MANIFESTS: Record<string, RoleKnowledgeManifest> = {
  android: {
    role: 'android',
    // Only machine-readable JSON registries belong in liveQueries. Android
    // release/API data has no JSON registry endpoint, so those checks stay as
    // checklist prose below.
    liveQueries: {
      kotlin: {
        registry: 'https://registry.npmjs.org/kotlin/latest',
        key: 'version',
        description: 'Kotlin latest stable',
      },
    },
    checklist: [
      'Current Android Gradle Plugin version (8.x+)',
      'Current Kotlin version (2.x+)',
      'Current compileSdk / targetSdk (≥ 34, check Play Store policy)',
      'Current Jetpack Compose stable version',
      'All third-party dependencies are at latest compatible minor',
    ],
    verifyThreshold: 0.5,
  },
  frontend: {
    role: 'frontend',
    liveQueries: {
      react: {
        registry: 'https://registry.npmjs.org/react/latest',
        key: 'version',
        description: 'React latest stable',
      },
      nextjs: {
        registry: 'https://registry.npmjs.org/next/latest',
        key: 'version',
        description: 'Next.js latest stable',
      },
    },
    checklist: [
      'Current React version (pinned in package.json)',
      'Current Next.js / Vite / framework version',
      'Node.js runtime version (project .nvmrc or engines)',
      'All devDependencies are at latest compatible versions',
      'Browser compatibility targets from browserslist',
    ],
    verifyThreshold: 0.5,
  },
  executor: {
    role: 'executor',
    liveQueries: {
      node: {
        registry: 'https://registry.npmjs.org/node/latest',
        key: 'version',
        description: 'Node.js latest release',
      },
    },
    checklist: [
      'Node.js version from .nvmrc or package.engines',
      'TypeScript version from package.json',
      'Package manager (pnpm ≥ 9) from packageManager',
      'Current toolchain: esbuild, vitest, etc.',
    ],
    verifyThreshold: 0.6,
  },
};
