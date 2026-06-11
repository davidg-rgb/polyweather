import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TS source (exports → ./src/index.ts) — Next
  // transpiles them in-place; nothing is pre-built.
  transpilePackages: ['@weather-edge/core', '@weather-edge/io', '@weather-edge/trading'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
