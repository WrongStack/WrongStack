#!/usr/bin/env bun
/**
 * WrongStack Skill & Registry Version Synchronizer
 *
 * Queries live upstream registries (npm, PyPI, Node.js, Go, Rust, .NET, Flutter,
 * Gradle, Maven Central, HashiCorp Checkpoint, Kubernetes, PHP, Python, Nginx,
 * and GitHub Releases), detects version drift against `stable-registry-check.json`
 * and `current-versions.md`, and optionally updates all bundled/workspace skills
 * and runs `check-bundle.ts`.
 *
 * Usage:
 *   bun run skill:check-versions
 *   bun run skill:sync-versions
 *   bun packages/core/skills/tech-stack/scripts/sync-versions.mjs --help
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPackage, stableVersionParts } from './check-versions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../../..');
const skillsRoot = path.join(repoRoot, 'packages/core/skills');
const registryCheckPath = path.join(skillsRoot, 'tech-stack/references/stable-registry-check.json');
const currentVersionsPath = path.join(skillsRoot, 'tech-stack/references/current-versions.md');

export const REGISTRY_SNAPSHOT_PACKAGES = [
  'next',
  'react',
  'motion',
  'three',
  'remotion',
  '@motion-canvas/core',
  '@motion-canvas/2d',
  '@motion-canvas/vite-plugin',
  '@motion-canvas/ffmpeg',
  'expo',
  'react-native',
  'vue',
  'nuxt',
  'svelte',
  '@sveltejs/kit',
  '@angular/core',
  'astro',
  'fastify',
  'express',
  '@modelcontextprotocol/sdk',
  'wrangler',
];

export const EXTENDED_NPM_PACKAGES = [
  'react-dom',
  'typescript',
  '@types/three',
  '@react-three/fiber',
  '@react-three/drei',
  'gsap',
  'tailwindcss',
  '@tailwindcss/browser',
  '@remotion/renderer',
  '@motion-canvas/player',
  '@elevenlabs/client',
  '@fal-ai/client',
  'docx',
  'exceljs',
  'pptxgenjs',
  'vite',
  'vitest',
  '@playwright/test',
  'puppeteer',
  '@angular/compiler-cli',
  '@angular/cli',
  '@tanstack/react-query',
  '@storybook/react',
  'web-features',
  'p5',
  'lucide-react',
  'expo-router',
  'react-native-reanimated',
  '@react-navigation/native',
  'sharp',
  'pdf-lib',
  'pnpm',
  '@biomejs/biome',
  'knip',
  'zod',
  'valibot',
  '@sinclair/typebox',
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  'ai',
  'hono',
  '@nestjs/core',
  'prisma',
  '@prisma/client',
  'drizzle-orm',
  'mongodb',
  'redis',
  'bullmq',
  'socket.io',
  'stripe',
  'better-auth',
  'jose',
  'graphql',
  '@aws-sdk/client-s3',
  '@cloudflare/workers-types',
  'aws-cdk-lib',
];

export const PYPI_PACKAGES = [
  'manim',
  'Pillow',
  'python-docx',
  'openpyxl',
  'python-pptx',
  'fastapi',
  'Django',
  'uv',
];

async function fetchJsonSafe(url, timeoutMs = 15_000) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'WrongStack-Skill-Version-Sync/1.0',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchTextSafe(url, timeoutMs = 15_000) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'WrongStack-Skill-Version-Sync/1.0' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchPyPIVersion(pkg) {
  const data = await fetchJsonSafe(`https://pypi.org/pypi/${pkg}/json`);
  return typeof data?.info?.version === 'string' ? data.info.version : null;
}

async function fetchGitHubReleaseTag(repo) {
  const data = await fetchJsonSafe(`https://api.github.com/repos/${repo}/releases/latest`);
  if (typeof data?.tag_name !== 'string') return null;
  return data.tag_name.replace(/^(?:bun-v|docker-v|swift-|v)/i, '').replace(/-RELEASE$/i, '');
}

/**
 * Newest stable and newest LTS release from nodejs.org/dist/index.json.
 * The index lists prerelease channels too — Node.js 27 opened an alpha line
 * (`v27.0.0-alpha.…`) ahead of its stable release — so the first entry is not
 * necessarily a stable release and must never be written as one.
 */
export function selectNodeReleases(list) {
  const stable = (Array.isArray(list) ? list : []).filter((item) =>
    /^v\d+\.\d+\.\d+$/.test(String(item?.version ?? '')),
  );
  const current = stable[0];
  const lts = stable.find((item) => item.lts);
  return {
    current: current ? String(current.version).slice(1) : undefined,
    lts: lts ? String(lts.version).slice(1) : undefined,
  };
}

export async function collectEcosystemVersions() {
  const ecosystem = {};

  await Promise.all([
    (async () => {
      const { current, lts } = selectNodeReleases(
        await fetchJsonSafe('https://nodejs.org/dist/index.json'),
      );
      if (current) ecosystem.nodeCurrent = current;
      if (lts) ecosystem.nodeLts = lts;
    })(),
    (async () => {
      const list = await fetchJsonSafe('https://go.dev/dl/?mode=json');
      if (Array.isArray(list) && list[0]?.version) {
        ecosystem.go = String(list[0].version).replace(/^go/, '');
      }
    })(),
    (async () => {
      const toml = await fetchTextSafe(
        'https://static.rust-lang.org/dist/channel-rust-stable.toml',
      );
      const m = toml?.match(/\[pkg\.rust\]\s+version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)/);
      if (m) ecosystem.rust = m[1];
    })(),
    (async () => {
      const data = await fetchJsonSafe(
        'https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json',
      );
      if (data?.['latest-sdk']) ecosystem.dotnetSdk = data['latest-sdk'];
      if (data?.['latest-runtime']) ecosystem.dotnetRuntime = data['latest-runtime'];
    })(),
    (async () => {
      const data = await fetchJsonSafe(
        'https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json',
      );
      const stableHash = data?.current_release?.stable;
      const release = data?.releases?.find((r) => r.hash === stableHash);
      if (release?.version) ecosystem.flutter = release.version;
      if (release?.dart_sdk_version) ecosystem.dart = release.dart_sdk_version;
    })(),
    (async () => {
      const data = await fetchJsonSafe('https://services.gradle.org/versions/current');
      if (data?.version) ecosystem.gradle = data.version;
    })(),
    (async () => {
      const xml = await fetchTextSafe(
        'https://repo1.maven.org/maven2/org/springframework/boot/spring-boot/maven-metadata.xml',
      );
      if (xml) {
        const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
        const stables = versions.filter((v) => stableVersionParts(v));
        if (stables.length > 0) ecosystem.springBoot = stables.at(-1);
      }
    })(),
    (async () => {
      const data = await fetchJsonSafe('https://www.php.net/releases/index.php?json&version=8.5');
      if (data?.version) ecosystem.php = data.version;
    })(),
    (async () => {
      const html = await fetchTextSafe('https://www.python.org/downloads/');
      const m = html?.match(/Download Python ([0-9]+\.[0-9]+\.[0-9]+)/);
      if (m) ecosystem.python = m[1];
    })(),
    (async () => {
      const txt = await fetchTextSafe('https://dl.k8s.io/release/stable.txt');
      if (txt) ecosystem.kubernetes = txt.trim().replace(/^v/, '');
    })(),
    (async () => {
      const data = await fetchJsonSafe('https://checkpoint-api.hashicorp.com/v1/check/terraform');
      if (data?.current_version) ecosystem.terraform = data.current_version;
    })(),
    (async () => {
      const html = await fetchTextSafe('https://nginx.org/en/download.html');
      if (html) {
        const mainline = html.match(/Mainline version[\s\S]*?nginx-([0-9]+\.[0-9]+\.[0-9]+)/i)?.[1];
        const stable = html.match(/Stable version[\s\S]*?nginx-([0-9]+\.[0-9]+\.[0-9]+)/i)?.[1];
        if (mainline) ecosystem.nginxMainline = mainline;
        if (stable) ecosystem.nginxStable = stable;
      }
    })(),
    (async () => {
      const [
        bun,
        laravel,
        kotlin,
        systemd,
        docker,
        compose,
        caddy,
        traefik,
        opentofu,
        pulumi,
        redisServer,
        swift,
      ] = await Promise.all([
        fetchGitHubReleaseTag('oven-sh/bun'),
        fetchGitHubReleaseTag('laravel/framework'),
        fetchGitHubReleaseTag('JetBrains/kotlin'),
        fetchGitHubReleaseTag('systemd/systemd'),
        fetchGitHubReleaseTag('moby/moby'),
        fetchGitHubReleaseTag('docker/compose'),
        fetchGitHubReleaseTag('caddyserver/caddy'),
        fetchGitHubReleaseTag('traefik/traefik'),
        fetchGitHubReleaseTag('opentofu/opentofu'),
        fetchGitHubReleaseTag('pulumi/pulumi'),
        fetchGitHubReleaseTag('redis/redis'),
        fetchGitHubReleaseTag('swiftlang/swift'),
      ]);
      if (bun) ecosystem.bun = bun;
      if (laravel) ecosystem.laravel = laravel;
      if (kotlin) ecosystem.kotlin = kotlin;
      if (systemd) ecosystem.systemd = systemd;
      if (docker) ecosystem.docker = docker;
      if (compose) ecosystem.compose = compose;
      if (caddy) ecosystem.caddy = caddy;
      if (traefik) ecosystem.traefik = traefik;
      if (opentofu) ecosystem.opentofu = opentofu;
      if (pulumi) ecosystem.pulumi = pulumi;
      if (redisServer) ecosystem.redisServer = redisServer;
      if (swift) ecosystem.swift = swift;
    })(),
  ]);

  return ecosystem;
}

export function bumpPatchVersion(versionStr) {
  const parts = versionStr.trim().split('.').map(Number);
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    parts[2] += 1;
    return parts.join('.');
  }
  return versionStr;
}

function writeLf(filePath, content) {
  fs.writeFileSync(filePath, content.replace(/\r\n/g, '\n'), 'utf8');
}

export function buildReplacementPairs(npmMap = {}, pypiMap = {}, eco = {}, todayIso) {
  const pairs = [];
  const addRegex = (pattern, replacement) => {
    if (replacement) pairs.push([pattern, replacement]);
  };

  if (todayIso) {
    addRegex(/\bchecked 2026-\d{2}-\d{2}\b/g, `checked ${todayIso}`);
    addRegex(/\bChecked 2026-\d{2}-\d{2}\b/g, `Checked ${todayIso}`);
    addRegex(/\bverified 2026-\d{2}-\d{2}\b/g, `verified ${todayIso}`);
    addRegex(/\bverified from npm on 2026-\d{2}-\d{2}\b/g, `verified from npm on ${todayIso}`);
    addRegex(/\bchecked from npm on 2026-\d{2}-\d{2}\b/g, `checked from npm on ${todayIso}`);
    addRegex(/\breviewed 2026-\d{2}-\d{2}\b/g, `reviewed ${todayIso}`);
    addRegex(/\bReviewed 2026-\d{2}-\d{2}\b/g, `Reviewed ${todayIso}`);
    addRegex(/\bchecked targets on 2026-\d{2}-\d{2}\b/g, `checked targets on ${todayIso}`);
    addRegex(/\bChecked targets 2026-\d{2}-\d{2}\b/g, `Checked targets ${todayIso}`);
    addRegex(
      /\bChecked upstream target 2026-\d{2}-\d{2}\b/g,
      `Checked upstream target ${todayIso}`,
    );
    addRegex(/\blive-checked 2026-\d{2}-\d{2}\b/g, `live-checked ${todayIso}`);
    addRegex(/<!-- verified: 2026-\d{2}-\d{2} \|/g, `<!-- verified: ${todayIso} |`);
  }

  // Frontend & Design
  if (npmMap.next?.version) {
    addRegex(/\bNext\.js 16\.\d+\.\d+\b/g, `Next.js ${npmMap.next.version}`);
  }
  if (npmMap.react?.version) {
    addRegex(/\bReact\/react-dom 19\.\d+\.\d+\b/g, `React/react-dom ${npmMap.react.version}`);
    addRegex(/\bReact 19\.\d+\.\d+\b/g, `React ${npmMap.react.version}`);
  }
  if (npmMap.typescript?.version) {
    addRegex(/\bTypeScript 7\.\d+\.\d+\b/g, `TypeScript ${npmMap.typescript.version}`);
  }
  if (npmMap.three?.version) {
    addRegex(/\bThree\.js 0\.\d+\.\d+\b/g, `Three.js ${npmMap.three.version}`);
    // three 0.N.x is release rN; keep the "(rN)" label beside it in step.
    const release = /^0\.(\d+)\./.exec(npmMap.three.version)?.[1];
    if (release) {
      addRegex(
        new RegExp(`(Three\\.js ${npmMap.three.version.replace(/\./g, '\\.')}) \\(r\\d+\\)`, 'g'),
        `$1 (r${release})`,
      );
    }
  }
  if (npmMap['@types/three']?.version) {
    addRegex(/@types\/three 0\.\d+\.\d+\b/g, `@types/three ${npmMap['@types/three'].version}`);
  }
  if (npmMap['@react-three/fiber']?.version) {
    addRegex(
      /\bReact Three Fiber 9\.\d+\.\d+\b/g,
      `React Three Fiber ${npmMap['@react-three/fiber'].version}`,
    );
  }
  if (npmMap['@react-three/drei']?.version) {
    addRegex(/\bDrei 10\.\d+\.\d+\b/g, `Drei ${npmMap['@react-three/drei'].version}`);
  }
  if (npmMap.motion?.version) {
    addRegex(/\bMotion 14\.\d+\.\d+\b/g, `Motion ${npmMap.motion.version}`);
  }
  if (npmMap.gsap?.version) {
    addRegex(/\bGSAP 3\.\d+\.\d+\b/g, `GSAP ${npmMap.gsap.version}`);
  }
  if (npmMap.tailwindcss?.version) {
    addRegex(/\bTailwind CSS 4\.\d+\.\d+\b/g, `Tailwind CSS ${npmMap.tailwindcss.version}`);
    addRegex(
      /@tailwindcss\/browser@4\.\d+\.\d+\b/g,
      `@tailwindcss/browser@${npmMap.tailwindcss.version}`,
    );
  }
  if (npmMap.vite?.version) {
    addRegex(/\bVite 8\.\d+\.\d+\b/g, `Vite ${npmMap.vite.version}`);
    addRegex(/\blatest Vite is 8\.\d+\.\d+\b/g, `latest Vite is ${npmMap.vite.version}`);
  }
  if (npmMap.vitest?.version) {
    addRegex(/\bVitest 5\.\d+\.\d+\b/g, `Vitest ${npmMap.vitest.version}`);
  }
  if (npmMap['@playwright/test']?.version) {
    addRegex(/\bPlaywright 1\.\d+\.\d+\b/g, `Playwright ${npmMap['@playwright/test'].version}`);
    addRegex(
      /`@playwright\/test` 1\.\d+\.\d+\b/g,
      `\`@playwright/test\` ${npmMap['@playwright/test'].version}`,
    );
  }
  if (npmMap.puppeteer?.version) {
    addRegex(/\bPuppeteer 25\.\d+\.\d+\b/g, `Puppeteer ${npmMap.puppeteer.version}`);
  }
  if (npmMap.vue?.version) {
    addRegex(/\bVue 3\.\d+\.\d+\b/g, `Vue ${npmMap.vue.version}`);
  }
  if (npmMap.nuxt?.version) {
    addRegex(/\bNuxt 4\.\d+\.\d+\b/g, `Nuxt ${npmMap.nuxt.version}`);
  }
  if (npmMap.svelte?.version) {
    addRegex(/\bSvelte 5\.\d+\.\d+\b/g, `Svelte ${npmMap.svelte.version}`);
  }
  if (npmMap['@sveltejs/kit']?.version) {
    addRegex(/\bSvelteKit 3\.\d+\.\d+\b/g, `SvelteKit ${npmMap['@sveltejs/kit'].version}`);
  }
  if (npmMap['@angular/core']?.version) {
    addRegex(
      /\bAngular core\/compiler-cli 22\.\d+\.\d+\b/g,
      `Angular core/compiler-cli ${npmMap['@angular/core'].version}`,
    );
    addRegex(/\bCompiler-cli 22\.\d+\.\d+\b/g, `Compiler-cli ${npmMap['@angular/core'].version}`);
  }
  if (npmMap['@angular/cli']?.version) {
    addRegex(/\bAngular CLI 22\.\d+\.\d+\b/g, `Angular CLI ${npmMap['@angular/cli'].version}`);
  }
  if (npmMap.astro?.version) {
    addRegex(/\bAstro 7\.\d+\.\d+\b/g, `Astro ${npmMap.astro.version}`);
  }
  if (npmMap['@tanstack/react-query']?.version) {
    addRegex(
      /\bTanStack Query 5\.\d+\.\d+\b/g,
      `TanStack Query ${npmMap['@tanstack/react-query'].version}`,
    );
  }
  if (npmMap['@storybook/react']?.version) {
    addRegex(
      /\bStorybook React 10\.\d+\.\d+\b/g,
      `Storybook React ${npmMap['@storybook/react'].version}`,
    );
  }
  if (npmMap['web-features']?.version) {
    addRegex(/\bweb-features 3\.\d+\.\d+\b/g, `web-features ${npmMap['web-features'].version}`);
  }
  if (npmMap.p5?.version) {
    addRegex(/\bp5 2\.\d+\.\d+\b/g, `p5 ${npmMap.p5.version}`);
    addRegex(/\bp5@2\.\d+\.\d+\b/g, `p5@${npmMap.p5.version}`);
  }
  if (npmMap['lucide-react']?.version) {
    addRegex(/\blucide-react 1\.\d+\.\d+\b/g, `lucide-react ${npmMap['lucide-react'].version}`);
  }

  // Mobile
  if (npmMap['react-native']?.version) {
    addRegex(/\bReact Native 0\.\d+\.\d+\b/g, `React Native ${npmMap['react-native'].version}`);
  }
  if (npmMap.expo?.version) {
    addRegex(/\bExpo 58\.\d+\.\d+\b/g, `Expo ${npmMap.expo.version}`);
  }
  if (npmMap['expo-router']?.version) {
    addRegex(/\bExpo Router 58\.\d+\.\d+\b/g, `Expo Router ${npmMap['expo-router'].version}`);
  }
  if (npmMap['react-native-reanimated']?.version) {
    addRegex(
      /\bReanimated 4\.\d+\.\d+\b/g,
      `Reanimated ${npmMap['react-native-reanimated'].version}`,
    );
  }
  if (npmMap['@react-navigation/native']?.version) {
    addRegex(
      /\bReact Navigation 7\.\d+\.\d+\b/g,
      `React Navigation ${npmMap['@react-navigation/native'].version}`,
    );
  }
  if (eco.flutter) {
    addRegex(/\bFlutter 3\.\d+\.\d+\b/g, `Flutter ${eco.flutter}`);
    addRegex(/refs\/tags\/3\.\d+\.\d+/g, `refs/tags/${eco.flutter}`);
  }
  if (eco.dart) {
    addRegex(/\bDart SDK 3\.\d+\.\d+\b/g, `Dart SDK ${eco.dart}`);
  }
  if (eco.swift) {
    addRegex(/\bSwift target: 6\.\d+(?:\.\d+)?\b/g, `Swift target: ${eco.swift}`);
  }
  if (eco.kotlin) {
    addRegex(/\bKotlin 2\.\d+\.\d+\b/g, `Kotlin ${eco.kotlin}`);
  }
  if (eco.gradle) {
    addRegex(/\bGradle 9\.\d+\.\d+\b/g, `Gradle ${eco.gradle}`);
    addRegex(
      /\bGradle current release is 9\.\d+\.\d+\b/g,
      `Gradle current release is ${eco.gradle}`,
    );
  }

  // Media & Documents
  if (npmMap.remotion?.version) {
    addRegex(/\bRemotion 4\.0\.\d+\b/g, `Remotion ${npmMap.remotion.version}`);
    addRegex(
      /\bRemotion and @remotion\/renderer 4\.0\.\d+\b/g,
      `Remotion and @remotion/renderer ${npmMap.remotion.version}`,
    );
  }
  if (npmMap['@motion-canvas/core']?.version) {
    addRegex(
      /\bMotion Canvas 3\.\d+\.\d+\b/g,
      `Motion Canvas ${npmMap['@motion-canvas/core'].version}`,
    );
  }
  if (pypiMap.manim) {
    addRegex(/\bManim Community 0\.\d+\.\d+\b/g, `Manim Community ${pypiMap.manim}`);
  }
  if (pypiMap.Pillow) {
    addRegex(/\bPillow 13\.\d+\.\d+\b/g, `Pillow ${pypiMap.Pillow}`);
  }
  if (npmMap.sharp?.version) {
    addRegex(/\bsharp 0\.\d+\.\d+\b/g, `sharp ${npmMap.sharp.version}`);
  }
  if (npmMap['@elevenlabs/client']?.version) {
    addRegex(
      /\bElevenLabs client 1\.\d+\.\d+\b/g,
      `ElevenLabs client ${npmMap['@elevenlabs/client'].version}`,
    );
  }
  if (npmMap['@fal-ai/client']?.version) {
    addRegex(/\bfal client 1\.\d+\.\d+\b/g, `fal client ${npmMap['@fal-ai/client'].version}`);
  }
  if (npmMap.docx?.version) {
    addRegex(/\bdocx 9\.\d+\.\d+\b/g, `docx ${npmMap.docx.version}`);
  }
  if (pypiMap['python-docx']) {
    addRegex(/\bpython-docx 1\.\d+\.\d+\b/g, `python-docx ${pypiMap['python-docx']}`);
  }
  if (npmMap.exceljs?.version) {
    addRegex(/\bExcelJS 4\.\d+\.\d+\b/g, `ExcelJS ${npmMap.exceljs.version}`);
    addRegex(/\bexceljs 4\.\d+\.\d+\b/g, `exceljs ${npmMap.exceljs.version}`);
  }
  if (pypiMap.openpyxl) {
    addRegex(/\bopenpyxl 3\.\d+\.\d+\b/g, `openpyxl ${pypiMap.openpyxl}`);
  }
  if (npmMap.pptxgenjs?.version) {
    addRegex(/\bPptxGenJS 4\.\d+\.\d+\b/g, `PptxGenJS ${npmMap.pptxgenjs.version}`);
    addRegex(/\bpptxgenjs 4\.\d+\.\d+\b/g, `pptxgenjs ${npmMap.pptxgenjs.version}`);
  }
  if (pypiMap['python-pptx']) {
    addRegex(/\bpython-pptx 1\.\d+\.\d+\b/g, `python-pptx ${pypiMap['python-pptx']}`);
  }
  if (npmMap['pdf-lib']?.version) {
    addRegex(/\bpdf-lib 1\.\d+\.\d+\b/g, `pdf-lib ${npmMap['pdf-lib'].version}`);
  }

  // Backend, Data, Tooling, AI & Operations
  if (eco.nodeCurrent) {
    addRegex(/`node:26\.\d+\.\d+-bookworm-slim`/g, `\`node:${eco.nodeCurrent}-bookworm-slim\``);
    addRegex(/FROM node:26\.\d+\.\d+-bookworm-slim/g, `FROM node:${eco.nodeCurrent}-bookworm-slim`);
    addRegex(/\bNode\.js 26\.\d+\.\d+\b/g, `Node.js ${eco.nodeCurrent}`);
    addRegex(/\bv26\.\d+\.\d+ Current\b/g, `v${eco.nodeCurrent} Current`);
    addRegex(/\bcurrent stable is 26\.\d+\.\d+\b/g, `current stable is ${eco.nodeCurrent}`);
    addRegex(/\bNode target is 26\.\d+\.\d+\b/g, `Node target is ${eco.nodeCurrent}`);
  }
  if (eco.nodeLts) {
    // Any major: the LTS line moves forward every October (24 → 26 in 2026).
    addRegex(/\bLTS 2\d\.\d+\.\d+\b/g, `LTS ${eco.nodeLts}`);
    addRegex(/\bv2\d\.\d+\.\d+ LTS\b/g, `v${eco.nodeLts} LTS`);
  }
  if (eco.bun) {
    addRegex(/\bBun 1\.\d+\.\d+\b/g, `Bun ${eco.bun}`);
  }
  if (npmMap.pnpm?.version) {
    addRegex(/\bpnpm 12\.\d+\.\d+\b/g, `pnpm ${npmMap.pnpm.version}`);
    addRegex(/\bpnpm@12\.\d+\.\d+\b/g, `pnpm@${npmMap.pnpm.version}`);
  }
  if (npmMap.knip?.version) {
    addRegex(/\bKnip 6\.\d+\.\d+\b/g, `Knip ${npmMap.knip.version}`);
  }
  if (npmMap['@biomejs/biome']?.version) {
    addRegex(/\bBiome 2\.\d+\.\d+\b/g, `Biome ${npmMap['@biomejs/biome'].version}`);
  }
  if (npmMap.zod?.version) {
    addRegex(/\bZod 4\.\d+\.\d+\b/g, `Zod ${npmMap.zod.version}`);
    addRegex(/\bzod 4\.\d+\.\d+\b/g, `zod ${npmMap.zod.version}`);
  }
  if (npmMap['@modelcontextprotocol/sdk']?.version) {
    addRegex(
      /@modelcontextprotocol\/sdk 1\.\d+\.\d+\b/g,
      `@modelcontextprotocol/sdk ${npmMap['@modelcontextprotocol/sdk'].version}`,
    );
  }
  if (npmMap.openai?.version) {
    addRegex(/\bopenai 7\.\d+\.\d+\b/g, `openai ${npmMap.openai.version}`);
  }
  if (npmMap['@anthropic-ai/sdk']?.version) {
    addRegex(
      /@anthropic-ai\/sdk 1\.\d+\.\d+\b/g,
      `@anthropic-ai/sdk ${npmMap['@anthropic-ai/sdk'].version}`,
    );
  }
  if (npmMap['@google/genai']?.version) {
    addRegex(/@google\/genai 2\.\d+\.\d+\b/g, `@google/genai ${npmMap['@google/genai'].version}`);
  }
  if (npmMap.ai?.version) {
    addRegex(/\(ai\) 7\.0\.\d+\b/g, `(ai) ${npmMap.ai.version}`);
  }
  if (npmMap.hono?.version) {
    addRegex(/\bHono 4\.\d+\.\d+\b/g, `Hono ${npmMap.hono.version}`);
  }
  if (npmMap.fastify?.version) {
    addRegex(/\bFastify 5\.\d+\.\d+\b/g, `Fastify ${npmMap.fastify.version}`);
  }
  if (npmMap['@nestjs/core']?.version) {
    addRegex(/\bNestJS 12\.\d+\.\d+\b/g, `NestJS ${npmMap['@nestjs/core'].version}`);
  }
  if (npmMap.prisma?.version) {
    addRegex(/\bPrisma\/client 7\.\d+\.\d+\b/g, `Prisma/client ${npmMap.prisma.version}`);
    addRegex(/\bPrisma 7\.\d+\.\d+\b/g, `Prisma ${npmMap.prisma.version}`);
  }
  if (npmMap.prisma?.latestTag && npmMap.prisma.latestTag !== npmMap.prisma.version) {
    addRegex(/\bpoints at 8\.0\.0-rc\.\d+\b/g, `points at ${npmMap.prisma.latestTag}`);
  }
  if (npmMap['drizzle-orm']?.version) {
    addRegex(/\bDrizzle 0\.\d+\.\d+\b/g, `Drizzle ${npmMap['drizzle-orm'].version}`);
  }
  if (npmMap.mongodb?.version) {
    addRegex(
      /\bMongoDB Node driver 7\.\d+\.\d+\b/g,
      `MongoDB Node driver ${npmMap.mongodb.version}`,
    );
  }
  if (npmMap.redis?.version) {
    addRegex(/\bRedis Node client 6\.\d+\.\d+\b/g, `Redis Node client ${npmMap.redis.version}`);
  }
  if (eco.redisServer) {
    addRegex(/\bRedis server 8\.\d+\.\d+\b/g, `Redis server ${eco.redisServer}`);
  }
  if (npmMap.bullmq?.version) {
    addRegex(
      /\bBullMQ stable target: 6\.\d+\.\d+\b/g,
      `BullMQ stable target: ${npmMap.bullmq.version}`,
    );
  }
  if (npmMap['socket.io']?.version) {
    addRegex(
      /\bSocket\.IO target: 4\.\d+\.\d+\b/g,
      `Socket.IO target: ${npmMap['socket.io'].version}`,
    );
  }
  if (npmMap.stripe?.version) {
    addRegex(
      /\bStripe Node SDK target: 23\.\d+\.\d+\b/g,
      `Stripe Node SDK target: ${npmMap.stripe.version}`,
    );
  }
  if (npmMap['better-auth']?.version) {
    addRegex(/\bBetter Auth 1\.\d+\.\d+\b/g, `Better Auth ${npmMap['better-auth'].version}`);
  }
  if (npmMap.jose?.version) {
    addRegex(/\bjose 6\.\d+\.\d+\b/g, `jose ${npmMap.jose.version}`);
  }
  if (npmMap.graphql?.version) {
    addRegex(
      /\bGraphQL\.js stable target: 17\.\d+\.\d+\b/g,
      `GraphQL.js stable target: ${npmMap.graphql.version}`,
    );
  }
  if (npmMap['@aws-sdk/client-s3']?.version) {
    addRegex(
      /\bAWS S3 JavaScript SDK target: 3\.\d+\.\d+\b/g,
      `AWS S3 JavaScript SDK target: ${npmMap['@aws-sdk/client-s3'].version}`,
    );
  }
  if (eco.python) {
    addRegex(/\bPython 3\.\d+\.\d+\b/g, `Python ${eco.python}`);
  }
  if (pypiMap.fastapi) {
    addRegex(/\bFastAPI 0\.\d+\.\d+\b/g, `FastAPI ${pypiMap.fastapi}`);
  }
  if (pypiMap.Django) {
    addRegex(/\bDjango 6\.\d+\.\d+\b/g, `Django ${pypiMap.Django}`);
  }
  if (pypiMap.uv) {
    addRegex(/\buv 0\.\d+\.\d+\b/g, `uv ${pypiMap.uv}`);
  }
  if (eco.go) {
    addRegex(/\bGo target: 1\.\d+\.\d+\b/g, `Go target: ${eco.go}`);
  }
  if (eco.rust) {
    addRegex(/\bRust target: 1\.\d+\.\d+\b/g, `Rust target: ${eco.rust}`);
  }
  if (eco.dotnetSdk) {
    addRegex(/\bSDK 10\.0\.\d+\b/g, `SDK ${eco.dotnetSdk}`);
  }
  if (eco.dotnetRuntime) {
    addRegex(/\bruntime 10\.0\.\d+\b/g, `runtime ${eco.dotnetRuntime}`);
  }
  if (eco.springBoot) {
    addRegex(/\bSpring Boot 4\.\d+\.\d+ stable\b/g, `Spring Boot ${eco.springBoot} stable`);
  }
  if (eco.php) {
    addRegex(/\bPHP 8\.5\.\d+\b/g, `PHP ${eco.php}`);
  }
  if (eco.laravel) {
    addRegex(/\bLaravel 13\.\d+\.\d+\b/g, `Laravel ${eco.laravel}`);
  }
  if (npmMap.wrangler?.version) {
    addRegex(/\bWrangler 4\.\d+\.\d+\b/g, `Wrangler ${npmMap.wrangler.version}`);
  }
  if (npmMap['@cloudflare/workers-types']?.version) {
    addRegex(
      /\bworkers-types 5\.\d+\.\d+\b/g,
      `workers-types ${npmMap['@cloudflare/workers-types'].version}`,
    );
  }
  if (eco.docker) {
    addRegex(/\bDocker Engine 29\.\d+\.\d+\b/g, `Docker Engine ${eco.docker}`);
    addRegex(/\bDocker 29\.\d+\.\d+\b/g, `Docker ${eco.docker}`);
    addRegex(/\bDocker target: 29\.\d+\.\d+\b/g, `Docker target: ${eco.docker}`);
  }
  if (eco.compose) {
    addRegex(/\bCompose 5\.\d+\.\d+\b/g, `Compose ${eco.compose}`);
  }
  if (eco.kubernetes) {
    addRegex(/\bKubernetes target: 1\.\d+\.\d+\b/g, `Kubernetes target: ${eco.kubernetes}`);
  }
  if (eco.terraform) {
    addRegex(/\bTerraform 1\.\d+\.\d+\b/g, `Terraform ${eco.terraform}`);
  }
  if (eco.opentofu) {
    addRegex(/\bOpenTofu 1\.\d+\.\d+\b/g, `OpenTofu ${eco.opentofu}`);
  }
  if (eco.pulumi) {
    addRegex(/\bPulumi 3\.\d+\.\d+\b/g, `Pulumi ${eco.pulumi}`);
  }
  if (npmMap['aws-cdk-lib']?.version) {
    addRegex(
      /\bAWS CDK library 2\.\d+\.\d+\b/g,
      `AWS CDK library ${npmMap['aws-cdk-lib'].version}`,
    );
  }
  if (eco.caddy) {
    addRegex(/\bCaddy 2\.\d+\.\d+\b/g, `Caddy ${eco.caddy}`);
  }
  if (eco.nginxStable && eco.nginxMainline) {
    addRegex(
      /\bNginx stable 1\.\d+\.\d+\/mainline 1\.\d+\.\d+\b/g,
      `Nginx stable ${eco.nginxStable}/mainline ${eco.nginxMainline}`,
    );
  }
  if (eco.traefik) {
    addRegex(/\bTraefik 3\.\d+\.\d+\b/g, `Traefik ${eco.traefik}`);
  }
  if (eco.systemd) {
    addRegex(/\bsystemd release: 26\d(?:\.\d+)?\b/g, `systemd release: ${eco.systemd}`);
  }

  return pairs;
}

function walkMarkdownFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdownFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(`Usage: bun packages/core/skills/tech-stack/scripts/sync-versions.mjs [--check | --write]

Options:
  --check   Query live registries and report version drift without modifying files (default).
  --write   Update stable-registry-check.json, current-versions.md, AGENTS.md, and skill files,
            then verify bundle integrity with check-bundle.ts.
  --help    Show this help message.`);
    return;
  }

  const writeMode = args.has('--write');
  const todayIso = new Date().toISOString().slice(0, 10);

  console.log(`🔍 Querying live registries (${todayIso})...`);

  const allNpmNames = [...new Set([...REGISTRY_SNAPSHOT_PACKAGES, ...EXTENDED_NPM_PACKAGES])];
  const npmResults = [];
  for (let i = 0; i < allNpmNames.length; i += 6) {
    const batch = allNpmNames.slice(i, i + 6);
    npmResults.push(...(await Promise.all(batch.map(inspectPackage))));
  }

  const npmMap = Object.fromEntries(npmResults.map((r) => [r.package, r]));
  const pypiEntries = await Promise.all(
    PYPI_PACKAGES.map(async (pkg) => [pkg, await fetchPyPIVersion(pkg)]),
  );
  const pypiMap = Object.fromEntries(pypiEntries.filter(([, v]) => v));
  const eco = await collectEcosystemVersions();

  // 1. Compare against existing stable-registry-check.json
  const existingSnapshot = fs.existsSync(registryCheckPath)
    ? JSON.parse(fs.readFileSync(registryCheckPath, 'utf8'))
    : [];
  const existingByPkg = Object.fromEntries(existingSnapshot.map((item) => [item.package, item]));

  const snapshotUpdates = [];
  const newRegistrySnapshot = REGISTRY_SNAPSHOT_PACKAGES.map((pkgName) => {
    const live = npmMap[pkgName];
    const prev = existingByPkg[pkgName];
    if (!live || live.error) {
      return prev ?? live;
    }
    if (prev && prev.version !== live.version) {
      snapshotUpdates.push({ package: pkgName, from: prev.version, to: live.version });
    }
    return live;
  });

  // 2. Check if any markdown skill files have version drift (ignoring date-only differences in --check)
  const versionOnlyPairs = buildReplacementPairs(npmMap, pypiMap, eco, undefined);
  const currentVersionsRaw = fs.existsSync(currentVersionsPath)
    ? fs.readFileSync(currentVersionsPath, 'utf8').replace(/\r\n/g, '\n')
    : '';
  let currentVersionsNext = currentVersionsRaw;
  for (const [pattern, replacement] of versionOnlyPairs) {
    currentVersionsNext = currentVersionsNext.replace(pattern, replacement);
  }
  const hasExtendedDrift = currentVersionsNext !== currentVersionsRaw;

  if (snapshotUpdates.length === 0 && !hasExtendedDrift) {
    console.log(
      `✅ All ${allNpmNames.length} npm packages, ${PYPI_PACKAGES.length} PyPI packages, and ecosystem runtimes match latest stable versions.`,
    );
  } else {
    if (snapshotUpdates.length > 0) {
      console.log(`📦 Detected ${snapshotUpdates.length} core registry package update(s):`);
      for (const u of snapshotUpdates) {
        console.log(`   - ${u.package}: ${u.from} -> ${u.to}`);
      }
    }
    if (hasExtendedDrift) {
      console.log(`📦 Detected ecosystem version updates in current-versions.md.`);
    }
  }

  if (!writeMode) {
    console.log(
      `\nℹ️  Run with --write ("bun run skill:sync-versions") to write registry snapshots and propagate across skills.`,
    );
    return;
  }

  // Write updated stable-registry-check.json
  writeLf(registryCheckPath, `${JSON.stringify(newRegistrySnapshot, null, 2)}\n`);
  console.log(`✍️  Updated ${path.relative(repoRoot, registryCheckPath)}`);

  const pairs = buildReplacementPairs(npmMap, pypiMap, eco, todayIso);
  const mdFiles = walkMarkdownFiles(skillsRoot);

  const modifiedSkills = new Set();
  let updatedFilesCount = 0;

  for (const filePath of mdFiles) {
    const original = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    let next = original;
    for (const [pattern, replacement] of pairs) {
      next = next.replace(pattern, replacement);
    }
    if (next !== original) {
      writeLf(filePath, next);
      updatedFilesCount++;
      const rel = path.relative(skillsRoot, filePath);
      if (!rel.startsWith('..')) {
        const skillDir = rel.split(path.sep)[0];
        if (skillDir) modifiedSkills.add(skillDir);
      }
    }
  }

  // Bump patch version on modified SKILL.md and keep SKILL.save.md source-version aligned
  for (const skillDir of modifiedSkills) {
    const skillMd = path.join(skillsRoot, skillDir, 'SKILL.md');
    const saveMd = path.join(skillsRoot, skillDir, 'SKILL.save.md');
    if (!fs.existsSync(skillMd)) continue;
    let skillText = fs.readFileSync(skillMd, 'utf8').replace(/\r\n/g, '\n');
    let bumpedVersion = null;
    skillText = skillText.replace(
      /^(version:\s*)([0-9]+\.[0-9]+\.[0-9]+)\s*$/m,
      (_, prefix, ver) => {
        bumpedVersion = bumpPatchVersion(ver);
        return `${prefix}${bumpedVersion}`;
      },
    );
    writeLf(skillMd, skillText);
    if (bumpedVersion && fs.existsSync(saveMd)) {
      const saveText = fs
        .readFileSync(saveMd, 'utf8')
        .replace(/\r\n/g, '\n')
        .replace(
          /<!--\s*source-version:\s*[^\s]+\s*-->/,
          `<!-- source-version: ${bumpedVersion} -->`,
        );
      writeLf(saveMd, saveText);
    }
  }

  console.log(
    `✍️  Propagated version updates across ${updatedFilesCount} bundled skill markdown file(s) (${modifiedSkills.size} skill(s) bumped).`,
  );

  // The repository's AGENTS.md carries the same dated "Latest Tech Specs" list
  // the usage text promises to refresh; it has no skill version to bump.
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    const original = fs.readFileSync(agentsPath, 'utf8').replace(/\r\n/g, '\n');
    let next = original;
    for (const [pattern, replacement] of pairs) {
      next = next.replace(pattern, replacement);
    }
    if (next !== original) {
      writeLf(agentsPath, next);
      console.log(`✍️  Updated ${path.relative(repoRoot, agentsPath)}`);
    }
  }

  // Run check-bundle.ts gate
  const checkBundleScript = path.join(skillsRoot, 'skill-creator/scripts/check-bundle.ts');
  const checkResult = spawnSync(process.execPath, ['run', checkBundleScript], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (checkResult.stdout) process.stdout.write(checkResult.stdout);
  if (checkResult.stderr) process.stderr.write(checkResult.stderr);
  if (checkResult.status !== 0) {
    process.exitCode = checkResult.status ?? 1;
  }
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const current = fileURLToPath(import.meta.url);
if (
  process.platform === 'win32' ? entry.toLowerCase() === current.toLowerCase() : entry === current
) {
  await main();
}
