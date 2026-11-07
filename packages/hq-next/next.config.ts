import type { NextConfig } from 'next';

// HQ ships inside the CLI binary and must work offline, so the app is a pure
// static export: no Next server, no Server Actions, no route handlers. Data
// arrives over the HQ server's `/ws/browser` socket and `/api/*` endpoints.
//
// `trailingSlash` makes every route its own `<route>/index.html`, which the
// HQ static server resolves without a rewrite table.
const nextConfig: NextConfig = {
  output: 'export',
  trailingSlash: true,
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ['@wrongstack/webui-protocol'],
  // Existing views are compiled straight from `packages/webui-hq/src` while each
  // surface is redesigned; that source lives outside this package root.
  experimental: {
    externalDir: true,
    // Bun's Windows child processes reserve enough memory that the default
    // per-CPU page workers can exhaust commit before static export starts.
    ...(process.platform === 'win32' ? { cpus: 2 } : {}),
  },
  // That source uses NodeNext-style specifiers (`./store/index.js` naming a
  // `.ts` file), which webpack only follows with an explicit extension alias.
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
