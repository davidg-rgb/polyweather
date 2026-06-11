import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TS source (exports → ./src/index.ts) — Next
  // transpiles them in-place; nothing is pre-built.
  transpilePackages: ['@weather-edge/core', '@weather-edge/io', '@weather-edge/trading'],
  // Trace serverless-function files from the WORKSPACE root, not apps/web —
  // without this, `vercel build` emits pnpm-store paths that 404 at deploy
  // ("ENOENT node_modules/.pnpm/next…/next-server.js", CLI prebuilt upload).
  outputFileTracingRoot: join(__dirname, '..', '..'),
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
