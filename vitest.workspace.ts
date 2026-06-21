import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'core',
      include: ['packages/core/test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'io',
      include: ['packages/io/test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'trading',
      include: ['packages/trading/test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'functions',
      include: ['supabase/functions/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'db',
      include: ['supabase/tests/**/*.test.ts'],
      // PGlite boots a WASM Postgres per suite; allow generous time on cold start.
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
  {
    test: {
      name: 'scripts',
      include: ['scripts/**/*.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
  {
    // The web components are server-rendered (no React import — they rely on the automatic JSX runtime),
    // so esbuild must transform .tsx with jsx:'automatic' for a .test.ts to import + renderToStaticMarkup
    // one. Only .tsx/.jsx files are affected; the existing pure-.ts loader tests are untouched.
    esbuild: { jsx: 'automatic' },
    test: {
      name: 'web',
      include: ['apps/web/test/**/*.test.ts'],
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  },
]);
