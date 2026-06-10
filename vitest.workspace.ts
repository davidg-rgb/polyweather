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
]);
