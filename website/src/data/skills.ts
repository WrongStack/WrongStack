/** Bundled skills from packages/core/skills; counts derive from this catalog.
 * Sourced from each skill's SKILL.md frontmatter — no invented descriptions.
 * The `export const skills` … `] as const;` shape is a build-time contract:
 * website/vite.config.ts source-parses this block to guard skill-count claims. */
export const skills = [
  {
    name: 'skill-router',
    description:
      'Choose bundled specialists and order ambiguous or multi-domain workflows with a complete selection map and overlap rules.',
  },
  {
    name: 'accessibility',
    description: 'Semantic controls, keyboard/focus behavior and evidenced WCAG checks',
  },
  {
    name: 'algorithmic-art',
    description:
      'Code-driven visual art with p5.js, Canvas2D or WebGPU shaders — flow fields, particle systems and seeded generative patterns',
  },
  {
    name: 'angular-modern',
    description:
      'Build and upgrade Angular applications with typed components, reactive state, dependency injection and verified routing',
  },
  { name: 'api-design', description: 'REST API design, error codes, pagination, auth patterns' },
  {
    name: 'astro-modern',
    description:
      'Build and upgrade Astro content sites and applications with deliberate islands, content contracts and rendering modes',
  },
  {
    name: 'audio-studio',
    description: 'Current music/TTS models, soundtrack prompts and validated audio delivery',
  },
  {
    name: 'audit-log',
    description: 'Session log parsing, anomaly detection, cost and tool usage analysis',
  },
  {
    name: 'authentication-sessions',
    description:
      'Implement application sign-in, sessions and identity integration with explicit account/tenant authorization',
  },
  {
    name: 'auto-review',
    description: 'Configure and operate the built-in continuous code-review plugin',
  },
  {
    name: 'backup-recovery',
    description:
      'Design and verify backups and restoration for owned databases, files and application state',
  },
  {
    name: 'brand-guidelines',
    description:
      'Apply the WrongStack brand identity, typography tokens, color palette and design standards across UI, presentations and documentation',
  },
  { name: 'bug-hunter', description: 'Systematic bug and code smell detection, severity ranking' },
  { name: 'chimera', description: 'Post-session code quality review of changed files' },
  { name: 'ci-cd', description: 'Reproducible CI, exact-source artifacts and deployment evidence' },
  {
    name: 'cloud-architecture',
    description:
      'Choose and design cloud services from concrete application, data, availability and operational requirements',
  },
  {
    name: 'canvas-design',
    description:
      'Design high-craft posters, book covers, typographic prints and vector PDF/PNG collateral on strict layout grids',
  },
  {
    name: 'cloudflare-workers',
    description: 'Worker runtime, typed bindings, isolation and deployment verification',
  },
  {
    name: 'code-quality',
    description: 'Source-confirmed unused code, dependencies and bundle waste',
  },
  {
    name: 'code-review',
    description:
      'On-demand review of a PR, branch, or diff: blast radius and severity-ranked findings',
  },
  {
    name: 'codebase-navigation',
    description: 'Orient, locate, and trace code with the codebase index before reading files',
  },
  {
    name: 'codex-adversarial-review',
    description: 'Read-only adversarial review with an explicit fix-confirmation boundary',
  },
  {
    name: 'compose-operations',
    description:
      'Operate and evolve multi-service Docker Compose environments with explicit networks, volumes and environment boundaries',
  },
  {
    name: 'container-debugging',
    description:
      'Diagnose reported container build, startup, network, permission and resource failures',
  },
  {
    name: 'container-hardening',
    description:
      'Review and improve container image/runtime protection for an owned application with tested compatibility',
  },
  {
    name: 'data-governance',
    description:
      'Schema ownership, PII handling, retention, lineage, access policy, migration safety',
  },
  {
    name: 'database-development',
    description:
      'Implement database access, models and queries with explicit consistency, transactions and bounded results',
  },
  {
    name: 'database-migrations',
    description: 'Schema evolution, bounded backfills and tested recovery',
  },
  {
    name: 'debugging',
    description: 'Root-cause an observed failure: reproduce, localize, fix at the cause, prove it',
  },
  {
    name: 'design-assets',
    description:
      'Prepare icons, SVGs, images, fonts and illustrations for product use with correct rights, formats and rendering',
  },
  {
    name: 'design-craft',
    description: 'Product-specific composition, typography, content and rendered critique',
  },
  {
    name: 'design-critique',
    description:
      'Scored, evidenced audit of an existing UI across structure, type, color, surface, states, and copy',
  },
  {
    name: 'design-system',
    description: 'Build consistent interfaces from shared visual tokens and component rules',
  },
  {
    name: 'design-to-code',
    description:
      'Implement supplied Figma designs, screenshots or design specifications as working interfaces',
  },
  {
    name: 'discernment-nudge',
    description:
      'Append epistemic scrutiny, assumption checks and missing-context prompts before finalizing high-stakes plans, estimates or security claims',
  },
  {
    name: 'doc-coauthoring',
    description:
      'Co-author RFCs, PRDs, ADRs and decision documents through structured context gathering and blind reader testing',
  },
  {
    name: 'docker-deploy',
    description: 'Docker containerization, multi-stage builds, image scanning',
  },
  {
    name: 'docx',
    description:
      'Author, edit, inspect and style Word documents with structured XML formatting, headers/footers and custom styles',
  },
  {
    name: 'dotnet-backend',
    description:
      'Build and upgrade ASP.NET Core services with typed contracts, dependency lifetimes and verified persistence',
  },
  {
    name: 'evidence-audit',
    description:
      'Proof-driven audit rounds: reproduce, apply a scope-only fix, verify, and promote high-risk regressions',
  },
  {
    name: 'flutter-mobile',
    description:
      'Build and upgrade Flutter applications with typed state, navigation, platform plugins and device verification',
  },
  {
    name: 'git-flow',
    description: 'Commit message style, branch hygiene, safe history operations',
  },
  {
    name: 'go-services',
    description:
      'Build and upgrade Go services, workers and CLI applications with context propagation and explicit ownership',
  },
  {
    name: 'graphql-development',
    description:
      'Build and evolve GraphQL schemas/resolvers with typed contracts, authorization and bounded query work',
  },
  {
    name: 'i18n-localization',
    description:
      'Implement localization with translated messages, locale-aware formatting and adaptable layouts',
  },
  {
    name: 'incident-response',
    description:
      'Diagnose and recover an owned service incident with bounded changes, timeline evidence and verified health. Use during outages, bad deployments or data/service degradation; preserve evidence and separate mitigation from root-cause repair',
  },
  {
    name: 'infrastructure-as-code',
    description:
      'Build and maintain Terraform, OpenTofu, Pulumi or cloud-native IaC with reviewable plans and protected state',
  },
  {
    name: 'interaction-design',
    description:
      'Design and implement task-oriented interaction flows, forms, navigation and recovery states',
  },
  {
    name: 'internal-comms',
    description:
      'Write 3P status updates, blameless postmortems, architecture decision memos and leadership briefs',
  },
  {
    name: 'java-spring',
    description:
      'Build and upgrade Java/Spring services with explicit transaction, concurrency and deployment contracts',
  },
  {
    name: 'kotlin-android',
    description:
      'Build and upgrade native Android applications with Kotlin, Compose/View UI and lifecycle-aware work',
  },
  {
    name: 'kubernetes-operations',
    description:
      'Operate and deploy owned Kubernetes workloads with explicit cluster, namespace and rollout identity',
  },
  {
    name: 'linux-service-ops',
    description:
      'Configure and troubleshoot application services on an authorized Linux host with explicit service ownership',
  },
  {
    name: 'llm-runtime',
    description:
      'Integrate frontier LLM APIs with structured outputs, tool-call schemas, prompt caching, streaming SSE and resilient backoff',
  },
  {
    name: 'mailbox-bridge',
    description:
      "Loopback HTTP bridge that exposes the project's shared WrongStack mailbox so external agents (Claude Code, Aider, scripts) can read, send, and acknowledge messages",
  },
  {
    name: 'manim-video',
    description: 'Manim Community mathematical/scientific animation and rendered video',
  },
  {
    name: 'mcp-development',
    description: 'Versioned MCP contracts, schemas, transport and lifecycle',
  },
  {
    name: 'media-production',
    description: 'Renderer selection across Remotion, Motion Canvas, Manim, AI and FFmpeg',
  },
  {
    name: 'micro-animation-gif',
    description:
      'Compact optimized animated GIFs for chat, PRs and release notes under tight file-size constraints',
  },
  {
    name: 'mnemosyne',
    description: 'Deterministic and LLM-supported curation of SAGE memory entries',
  },
  {
    name: 'mobile-design',
    description:
      'Design and implement mobile interfaces for touch, keyboards, safe areas and native navigation',
  },
  {
    name: 'mobile-performance',
    description:
      'Measure and improve mobile startup, scrolling, animation and resource usage on representative devices',
  },
  {
    name: 'mobile-release',
    description:
      'Prepare and verify signed mobile releases, test-channel distribution and store submission artifacts',
  },
  {
    name: 'motion-canvas-video',
    description: 'TypeScript generator scenes, narration cues and Motion Canvas export',
  },
  {
    name: 'motion-design',
    description: 'Current Motion/GSAP/CSS animation with reduced motion and cleanup',
  },
  {
    name: 'multi-agent',
    description: 'Leader/worker roles, task delegation, result aggregation, fleet management',
  },
  {
    name: 'nextjs-modern',
    description: 'Latest stable Next.js 16 App Router, Server Actions and explicit cache policy',
  },
  {
    name: 'node-backend',
    description:
      'Build and upgrade Node.js HTTP services with typed validation, lifecycle ownership and production behavior',
  },
  {
    name: 'node-modern',
    description: 'Latest stable Node/Bun, module compatibility and resource ownership',
  },
  {
    name: 'observability',
    description: 'Structured logging, traces, metrics, redaction, instrumentation',
  },
  {
    name: 'pdf',
    description:
      'Generate, inspect, assemble and render vector-quality PDFs with precise page geometry and print typography',
  },
  {
    name: 'office-documents',
    description: 'Word/Excel/PowerPoint/PDF generation, recalculation and visual verification',
  },
  {
    name: 'offline-sync',
    description:
      'Implement offline-capable applications with local persistence, queued changes and explicit synchronization conflicts',
  },
  {
    name: 'output-standards',
    description: 'Output formatting standards, `<nextsteps>` conventions',
  },
  {
    name: 'payments-webhooks',
    description:
      'Implement payment-provider integration and reliable authenticated webhook processing for an owned application',
  },
  {
    name: 'php-laravel',
    description:
      'Build and upgrade PHP/Laravel applications with validated requests, policy authorization and reliable jobs/data access',
  },
  { name: 'plugin-author', description: 'Creating, reviewing, or refactoring a WrongStack plugin' },
  {
    name: 'prompt-engineering',
    description: 'System prompt design, tool descriptions, trigger sentences',
  },
  {
    name: 'pptx',
    description:
      'Author modern 16:9 decks with strong typographic hierarchy and visual cards instead of bullet walls',
  },
  {
    name: 'python-backend',
    description:
      'Build and upgrade Python services with explicit environments, validation, async boundaries and resource cleanup',
  },
  {
    name: 'queues-jobs',
    description:
      'Implement reliable asynchronous jobs and message consumers with explicit delivery, retry and shutdown semantics',
  },
  {
    name: 'react-modern',
    description: 'Current React component/action/effect semantics and framework boundaries',
  },
  {
    name: 'react-native-expo',
    description:
      'Build and upgrade React Native or Expo applications with navigation, native modules and verified platform integration',
  },
  {
    name: 'realtime-systems',
    description:
      'Implement WebSocket, SSE or established realtime transports with explicit authentication, ordering and reconnect behavior',
  },
  {
    name: 'refactor-planner',
    description: 'Dependency mapping, risk assessment, phased planning, migration strategy',
  },
  {
    name: 'release-rollback',
    description:
      'Plan and execute authorized release promotion or rollback with exact artifact and data compatibility',
  },
  {
    name: 'remote-debugging',
    description:
      'Diagnose a reported application failure on explicitly authorized remote hosts using bounded logs and runtime evidence',
  },
  {
    name: 'research-web',
    description:
      'Web research methodology — disciplined search + fetch workflow, source validation, cross-referencing, structured context-manager injection',
  },
  {
    name: 'reverse-proxy-tls',
    description:
      'Configure and troubleshoot reverse proxies, HTTPS, domains and upstream routing for an authorized application',
  },
  {
    name: 'rust-systems',
    description:
      'Build and upgrade Rust services, CLI and systems components with explicit error, async and resource contracts',
  },
  {
    name: 'sdd',
    description:
      'Spec parsing, task graph generation, dependency tracking, done-condition execution',
  },
  {
    name: 'security-scanner',
    description: 'Code and configuration security vulnerability scanning',
  },
  {
    name: 'skill-creator',
    description: 'Guide to creating new WrongStack skills with YAML frontmatter',
  },
  {
    name: 'ssh-operations',
    description:
      'Connect to and administer explicitly authorized hosts through OpenSSH with verified identity and bounded operations',
  },
  {
    name: 'storage-uploads',
    description:
      'Implement owned file/object storage and upload/download flows with validated metadata, access and lifecycle',
  },
  {
    name: 'sveltekit-modern',
    description:
      'Build and upgrade Svelte and SvelteKit applications with reactive state, server loads, actions and deployment adapters',
  },
  {
    name: 'swift-ios',
    description:
      'Build and upgrade native iOS applications with Swift, SwiftUI/UIKit and correct lifecycle/concurrency ownership',
  },
  {
    name: 'tech-stack',
    description: 'Latest stable registry verification, migration and compatibility evidence',
  },
  {
    name: 'testing',
    description: 'vitest patterns, mocking, coverage, unit/integration/e2e test strategy',
  },
  {
    name: 'theme-factory',
    description:
      'Curated font pairings, chromatic palettes and design themes for decks, web artifacts, landing pages and docs',
  },
  {
    name: 'threejs-3d',
    description: 'Current Three.js/R3F, renderer compatibility and GPU resource ownership',
  },
  {
    name: 'typescript-strict',
    description: 'Strict null checks, exhaustive switch, branded types, discriminated unions',
  },
  {
    name: 'verify-before-done',
    description: "Prove a change works with the project's own checks before reporting it done",
  },
  {
    name: 'visual-regression',
    description:
      'Detect unintended UI changes with reproducible rendered screenshots and reviewed baselines',
  },
  {
    name: 'vps-deploy',
    description:
      'Deploy an owned application to an explicitly authorized VPS with versioned artifacts, service identity and live health evidence',
  },
  {
    name: 'vue-nuxt',
    description:
      'Build and upgrade Vue or Nuxt applications with reactive state, server rendering and typed data boundaries',
  },
  {
    name: 'web-artifacts',
    description:
      'Self-contained single-file or micro-bundled web tools, calculators and dashboards that run without a backend',
  },
  {
    name: 'webapp-testing',
    description:
      'Playwright verification of UI journeys, DOM reconnaissance, screenshot diffs and responsive layouts',
  },
  {
    name: 'web-performance',
    description: 'LCP/INP/CLS and matched before/after browser profiling',
  },
  {
    name: 'web-platform-baseline',
    description:
      'Dated, refreshable modern CSS/HTML/a11y facts with a staleness rule — never assert browser support from memory',
  },
  {
    name: 'wrongstack-kanban',
    description: 'Deterministic Kanban task lifecycle, verification, and evidence enforcement',
  },
  {
    name: 'wrongstack-mailbox',
    description:
      "External-facing client for the project's shared WrongStack mailbox — register as an online agent, read messages, send replies, broadcast, and stay visible in the WebUI fleet",
  },
  {
    name: 'wrongstack-mailbox-mcp',
    description: 'Coordinate with agents through the project-scoped Mailbox MCP server',
  },
  {
    name: 'xlsx',
    description:
      'Engineer Excel workbooks with dynamic formulas, financial models, freeze panes and custom number formats',
  },
] as const;

export const SKILL_COUNT = skills.length;
