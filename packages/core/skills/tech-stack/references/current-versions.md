# Current stable technology targets

Checked live on 2026-10-23. These values are a dated snapshot: query the
same authoritative endpoints before each new install or upgrade.
The [latest npm verification record](stable-registry-check.json) records 21
web, mobile, video and backend package lookups, including timestamps, stable
selection, engine constraints and peer ranges; regenerate it before relying on it. Recommend
latest stable; record compatibility blockers instead of silently downgrading.

| Package | Latest stable | Registry |
|---|---|---|
| next | 16.4.3 | [npm](https://registry.npmjs.org/next/latest) |
| react | 19.3.1 | [npm](https://registry.npmjs.org/react/latest) |
| react-dom | 19.3.1 | [npm](https://registry.npmjs.org/react-dom/latest) |
| typescript | 7.0.2 | [npm](https://registry.npmjs.org/typescript/latest) |
| three | 0.186.1 | [npm](https://registry.npmjs.org/three/latest) |
| @types/three | 0.186.0 | [npm](https://registry.npmjs.org/@types/three/latest) |
| @react-three/fiber | 9.8.2 | [npm](https://registry.npmjs.org/@react-three/fiber/latest) |
| @react-three/drei | 10.7.9 | [npm](https://registry.npmjs.org/@react-three/drei/latest) |
| motion | 14.6.0 | [npm](https://registry.npmjs.org/motion/latest) |
| gsap | 3.15.0 | [npm](https://registry.npmjs.org/gsap/latest) |
| tailwindcss | 4.3.3 | [npm](https://registry.npmjs.org/tailwindcss/latest) |
| vite | 8.3.5 | [npm](https://registry.npmjs.org/vite/latest) |
| vitest | 5.0.5 | [npm](https://registry.npmjs.org/vitest/latest) |
| @playwright/test | 1.64.1 | [npm](https://registry.npmjs.org/@playwright/test/latest) |
| remotion | 4.0.538 | [npm](https://registry.npmjs.org/remotion/latest) |
| @remotion/renderer | 4.0.538 | [npm](https://registry.npmjs.org/@remotion/renderer/latest) |
| docx | 9.14.0 | [npm](https://registry.npmjs.org/docx/latest) |
| exceljs | 4.4.0 | [npm](https://registry.npmjs.org/exceljs/latest) |
| pptxgenjs | 4.0.1 | [npm](https://registry.npmjs.org/pptxgenjs/latest) |
| pdf-lib | 1.17.1 | [npm](https://registry.npmjs.org/pdf-lib/latest) |
| wrangler | 4.152.0 | [npm](https://registry.npmjs.org/wrangler/latest) |
| @cloudflare/workers-types | 5.20261023.1 | [npm](https://registry.npmjs.org/@cloudflare/workers-types/latest) |
| @modelcontextprotocol/sdk | 1.32.2 | [npm](https://registry.npmjs.org/@modelcontextprotocol/sdk/latest) |
| zod | 4.6.7 | [npm](https://registry.npmjs.org/zod/latest) |
| @biomejs/biome | 2.6.2 | [npm](https://registry.npmjs.org/@biomejs/biome/latest) |
| knip | 6.42.1 | [npm](https://registry.npmjs.org/knip/latest) |
| pnpm | 12.15.0 | [npm](https://registry.npmjs.org/pnpm/latest) |
| @elevenlabs/client | 1.30.0 | [npm](https://registry.npmjs.org/@elevenlabs/client/latest) |
| @fal-ai/client | 1.10.1 | [npm](https://registry.npmjs.org/@fal-ai/client/latest) |
| @motion-canvas/core, @motion-canvas/2d, @motion-canvas/vite-plugin, @motion-canvas/ffmpeg | 3.17.2 | [npm plugin](https://registry.npmjs.org/@motion-canvas/vite-plugin/latest) |
| Manim Community | 0.22.0 | [PyPI](https://pypi.org/pypi/manim/json) |
| Node.js | Node.js 26.13.0 newest stable / LTS 26.13.0 (Node 24 in maintenance) | [official releases](https://nodejs.org/dist/index.json) |
| Bun | 1.4.4 | [official releases](https://github.com/oven-sh/bun/releases/latest) |
| FFmpeg | 9.0.2 | [official releases](https://ffmpeg.org/download.html) |
| Suno | v6 / v6-mini | [official model guide](https://help.suno.com/en/articles/13924737) |
| OpenAPI specification | 3.2.1 | [official specification](https://spec.openapis.org/oas/latest.html) |
| MCP specification | 2026-07-28 | [versioned specification](https://modelcontextprotocol.io/specification/2026-07-28) |

## Additional web, mobile, backend and operations targets

Checked 2026-11-02. Runtime/server versions and SDK/client versions are distinct.

| Technology | Checked release/channel | Source |
|---|---|---|
| expo | 58.0.17 | [npm](https://registry.npmjs.org/expo/latest) |
| react-native | 0.88.0 | [npm](https://registry.npmjs.org/react-native/latest) |
| expo-router | 58.0.25 | [npm](https://registry.npmjs.org/expo-router/latest) |
| react | 19.3.1 | [npm](https://registry.npmjs.org/react/latest) |
| next | 16.4.3 | [npm](https://registry.npmjs.org/next/latest) |
| typescript | 7.0.2 | [npm](https://registry.npmjs.org/typescript/latest) |
| vue | 3.5.44 | [npm](https://registry.npmjs.org/vue/latest) |
| nuxt | 4.6.2 | [npm](https://registry.npmjs.org/nuxt/latest) |
| svelte | 5.57.2 | [npm](https://registry.npmjs.org/svelte/latest) |
| @sveltejs/kit | 3.1.0 | [npm](https://registry.npmjs.org/@sveltejs/kit/latest) |
| @angular/core | 22.2.3 | [npm](https://registry.npmjs.org/@angular/core/latest) |
| @angular/cli | 22.2.4 | [npm](https://registry.npmjs.org/@angular/cli/latest) |
| astro | 7.4.2 | [npm](https://registry.npmjs.org/astro/latest) |
| @nestjs/core | 12.2.0 | [npm](https://registry.npmjs.org/@nestjs/core/latest) |
| hono | 4.13.13 | [npm](https://registry.npmjs.org/hono/latest) |
| fastify | 5.12.7 | [npm](https://registry.npmjs.org/fastify/latest) |
| @tanstack/react-query | 5.104.5 | [npm](https://registry.npmjs.org/@tanstack/react-query/latest) |
| @react-navigation/native | 7.5.1 | [npm](https://registry.npmjs.org/@react-navigation/native/latest) |
| react-native-reanimated | 4.7.1 | [npm](https://registry.npmjs.org/react-native-reanimated/latest) |
| @playwright/test | 1.64.1 | [npm](https://registry.npmjs.org/@playwright/test/latest) |
| @storybook/react | 10.6.3 | [npm](https://registry.npmjs.org/@storybook/react/latest) |
| tailwindcss | 4.3.3 | [npm](https://registry.npmjs.org/tailwindcss/latest) |
| motion | 14.6.0 | [npm](https://registry.npmjs.org/motion/latest) |
| vite | 8.3.5 | [npm](https://registry.npmjs.org/vite/latest) |
| vitest | 5.0.5 | [npm](https://registry.npmjs.org/vitest/latest) |
| prisma | 7.10.1 stable (latest tag 8.0.0-rc.27) | [npm](https://registry.npmjs.org/prisma/latest) |
| @prisma/client | 7.10.1 | [npm](https://registry.npmjs.org/@prisma/client/latest) |
| drizzle-orm | 0.45.4 | [npm](https://registry.npmjs.org/drizzle-orm/latest) |
| mongodb | 7.7.0 | [npm](https://registry.npmjs.org/mongodb/latest) |
| redis | 6.3.0 | [npm](https://registry.npmjs.org/redis/latest) |
| bullmq | 6.4.1 | [npm](https://registry.npmjs.org/bullmq/latest) |
| socket.io | 4.8.4 | [npm](https://registry.npmjs.org/socket.io/latest) |
| stripe | 23.0.1 | [npm](https://registry.npmjs.org/stripe/latest) |
| better-auth | 1.7.12 | [npm](https://registry.npmjs.org/better-auth/latest) |
| jose | 6.2.13 | [npm](https://registry.npmjs.org/jose/latest) |
| aws-cdk-lib | 2.274.0 | [npm](https://registry.npmjs.org/aws-cdk-lib/latest) |
| @pulumi/pulumi | 3.272.0 | [npm](https://registry.npmjs.org/@pulumi/pulumi/latest) |
| openai | 7.43.0 | [npm](https://registry.npmjs.org/openai/latest) |
| @anthropic-ai/sdk | 1.2.0 | [npm](https://registry.npmjs.org/@anthropic-ai/sdk/latest) |
| @google/genai | 2.31.0 | [npm](https://registry.npmjs.org/@google/genai/latest) |
| ai (Vercel AI SDK) | 7.0.152 | [npm](https://registry.npmjs.org/ai/latest) |
| Flutter | 3.47.8 stable (bundled Dart 3.13.7) | [official source](https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json) |
| Go | 1.27.3 stable | [official source](https://go.dev/dl/?mode=json) |
| Rust | 1.99.1 stable | [official source](https://static.rust-lang.org/dist/channel-rust-stable.toml) |
| Python | 3.15.1 stable | [official source](https://www.python.org/downloads/) |
| FastAPI | 0.162.0 | [official source](https://pypi.org/pypi/fastapi/json) |
| Django | 6.1.2 | [official source](https://pypi.org/pypi/django/json) |
| uv | 0.13.5 | [official source](https://pypi.org/pypi/uv/json) |
| .NET | SDK 10.0.403 / runtime 10.0.14 stable; 11 RC excluded | [official source](https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/10.0/releases.json) |
| JDK | 27 GA; 28 early access excluded | [official source](https://jdk.java.net/) |
| Spring Boot | 4.1.2 stable; 4.2.0-RC1 excluded | [official source](https://repo1.maven.org/maven2/org/springframework/boot/spring-boot/maven-metadata.xml) |
| PHP | 8.5.12 | [official source](https://www.php.net/downloads.php) |
| Laravel | 13.38.0 | [official source](https://github.com/laravel/framework/releases) |
| Swift | 6.4.1 stable | [official source](https://www.swift.org/api/v1/install/releases.json) |
| Kotlin | 2.4.21 | [official source](https://github.com/JetBrains/kotlin/releases) |
| Gradle | 9.8.2 | [official source](https://services.gradle.org/versions/current) |
| OpenSSH portable | 10.6p1 | [official source](https://www.openssh.com/releasenotes.html) |
| systemd upstream | 262.1 (use supported distro package) | [official source](https://github.com/systemd/systemd/releases) |
| Docker Engine | 29.9.2 | [official source](https://github.com/moby/moby/releases/latest) |
| Docker Compose | 5.6.1 | [official source](https://github.com/docker/compose/releases) |
| Caddy | 2.11.7 | [official source](https://github.com/caddyserver/caddy/releases) |
| Nginx | stable 1.30.6 / mainline 1.31.8 | [official source](https://nginx.org/en/download.html) |
| Traefik | 3.7.16 | [official source](https://github.com/traefik/traefik/releases) |
| Kubernetes | 1.37.1 | [official source](https://dl.k8s.io/release/stable.txt) |
| Terraform | 1.17.0 | [official source](https://developer.hashicorp.com/terraform/install) |
| OpenTofu | 1.13.2 | [official source](https://github.com/opentofu/opentofu/releases) |
| PostgreSQL | 18.6 stable (19 is beta) | [official source](https://www.postgresql.org/support/versioning/) |
| MongoDB server | 9.0 stable series; resolve patch from provider before deployment | [official source](https://www.mongodb.com/docs/manual/release-notes/) |
| Redis server | 8.10.2 | [official source](https://github.com/redis/redis/releases) |
| GraphQL.js | 17.0.2 | [official source](https://registry.npmjs.org/graphql/latest) |
| AWS S3 SDK | 3.1156.0 | [official source](https://registry.npmjs.org/@aws-sdk/client-s3/latest) |

## Compatibility blockers found in this expansion

- Expo SDK 58 (58.0.17) bundles React Native 0.88.1, Reanimated 4.7.1 and Expo Router 58.0.29; Expo Router's RSC peer range declares `react-server-dom-webpack` `~19.3.0` while independent `react` / `react-dom` are at `19.3.1`. Choose the verified `npx expo install --check` matrix or a bare RN path; do not silently mix versions or suppress validation.
- Angular compiler-cli 22.2.3 declares TypeScript >=6.0 <6.1; TypeScript 7.0.2 is outside the supported peer range.
- SvelteKit 3.1.1 declares `typescript: ^6.0.0` and `@pulumi/pulumi` 3.272.0 declares `typescript: >= 3.8.3 < 7`; TypeScript 7.0.2 is outside those peer ranges.
- Prisma latest tag is 8.0.0-rc.27; highest published non-deprecated stable is 7.10.1, matching `@prisma/client` 7.10.1. Spring Boot (4.2.0-RC1) and .NET (11 RC) indexes contain milestone/RC targets that must also be excluded from stable selection.
- Nginx stable (1.30.6) and mainline (1.31.8) are separate published channels.
- MongoDB stable series (9.0) was confirmed; exact server patch and managed provider eligibility remain deployment-time checks.

## Compatibility observations

- Motion Canvas vite-plugin 3.17.2 declares Vite 4.x or 5.x. Latest Vite 8.3.5 is outside that peer range. Keep this blocker visible; do not bypass it with force.
- React DOM 19.3.1 requires React ^19.3.1; upgrade the pair.
- R3F 9.8.2 declares React >=19 <19.4, compatible with the checked 19.3.1.
- Vitest 5.1.0 requires supported Node ranges (`^22.12.0 || ^24.0.0 || >=26.0.0`) and matching 5.0.5 coverage/browser plugins.
- Wrangler 4.156.2 requires Node >=22.0.0 and `@cloudflare/workers-types` ^5.20261019.1.
- Node.js 26.13.0 is the newest stable release and, since 2026-10-28, also the active LTS line (LTS 26.13.0); Node 24 is in maintenance. index.json also lists Node 27 alpha builds: never report an alpha as latest stable. Choose latest stable for the requested target and state a deployment runtime restriction when it prevents adoption.

The entrypoint describes cross-ecosystem lookup; this snapshot does not claim
every package or hosted model has been checked. Unavailable sources stay unknown.
