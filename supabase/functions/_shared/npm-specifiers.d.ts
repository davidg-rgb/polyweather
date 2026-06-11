/**
 * Ambient declarations for the Deno `npm:` specifiers that MUST appear as
 * string literals in source (the deploy-time eszip bundler builds its npm
 * snapshot from statically-visible specifiers only — a non-literal
 * `import(spec)` ships a bundle that throws "Could not find constraint …
 * in the list of packages" at runtime; hosted incident 2026-06-11).
 *
 * tsc (Node-side, root tsconfig) cannot resolve `npm:` URLs, so each literal
 * needs a shorthand declaration here (module type = any; call sites cast).
 * Keep the strings in lockstep with their import sites:
 *   - _shared/db.ts (supabase-js)
 *   - execute-bet/index.ts eszip hints ↔ packages/trading/src/live.ts (F-032)
 */
declare module 'npm:@supabase/supabase-js@2';
declare module 'npm:ethers@5';
declare module 'npm:@polymarket/clob-client@4';
