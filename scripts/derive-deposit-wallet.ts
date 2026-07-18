/**
 * derive-deposit-wallet — print the PUBLIC trading identity implied by the local .env.local:
 *   · the owner EOA address (new Wallet(POLY_PRIVATE_KEY).address — the key itself never leaves memory)
 *   · the currently-configured POLY_FUNDER_ADDRESS + POLY_SIGNATURE_TYPE
 * All three outputs are PUBLIC-CLASS (an address rides on every order; the sig type is a 0-3 mode flag).
 * The private key is NEVER printed, logged, or included in any output — the deriveClobApiKeyPreview idiom
 * (packages/trading/src/live.ts §15).
 *
 * Purpose (C46d): Polymarket now rejects non-deposit-wallet makers ("maker address not allowed"). The
 * deposit wallet is derived from / deployed for the OWNER — knowing the owner EOA lets us query the
 * deposit-wallet factory's WalletDeployed events (public Polygon RPC) for the REAL deployed wallet, and
 * check whether the configured funder is the EOA itself (the suspected misconfig).
 */
import { createRequire } from 'node:module';
import { loadEnv } from './lib/load-env.ts';

// ethers@5 is CJS and pnpm-scoped to packages/trading — createRequire from there resolves it cleanly.
const require = createRequire(new URL('../packages/trading/package.json', import.meta.url));
const { Wallet } = require('ethers') as { Wallet: new (k: string) => { address: string } };

loadEnv();

const key = process.env.POLY_PRIVATE_KEY;
if (!key) {
  console.log('POLY_PRIVATE_KEY not set in .env.local — nothing to derive.');
  process.exit(1);
}
const eoa = new Wallet(key).address;
console.log(`owner EOA (public):        ${eoa}`);
console.log(`POLY_FUNDER_ADDRESS (env): ${process.env.POLY_FUNDER_ADDRESS ?? '(unset)'}`);
console.log(`POLY_SIGNATURE_TYPE (env): ${process.env.POLY_SIGNATURE_TYPE ?? '(unset)'}`);
console.log(`funder == owner EOA?       ${(process.env.POLY_FUNDER_ADDRESS ?? '').toLowerCase() === eoa.toLowerCase()}`);
