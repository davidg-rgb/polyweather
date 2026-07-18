/**
 * derive-deposit-wallet — print the PUBLIC trading identity implied by the local .env.local:
 *   · the owner EOA address (derived inside packages/trading — the key never reaches this script)
 *   · the currently-configured funder address + signature type
 * All outputs are PUBLIC-CLASS (an address rides on every order; the sig type is a 0-3 mode flag).
 * The private key is NEVER read here, printed, logged, or included in any output — the derivation lives in
 * packages/trading/src/live.ts `deriveOwnerIdentity` (§15: the key + the wallet stay inside that file; this
 * script receives only the public facts, the deriveClobApiKeyPreview idiom).
 *
 * Purpose (C46d): Polymarket now rejects non-deposit-wallet makers ("maker address not allowed"). The
 * deposit wallet is derived from / deployed for the OWNER — knowing the owner EOA lets us query the
 * deposit-wallet factory's WalletDeployed events (public Polygon RPC) for the REAL deployed wallet, and
 * check whether the configured funder is the EOA itself (the suspected misconfig).
 */
import { deriveOwnerIdentity } from '../packages/trading/src/index.ts';
import { loadEnv } from './lib/load-env.ts';

loadEnv();

try {
  const id = await deriveOwnerIdentity();
  console.log(`owner EOA (public):        ${id.ownerEoa}`);
  console.log(`funder address (env):      ${id.funder ?? '(unset)'}`);
  console.log(`signature type (env):      ${id.sigType}`);
  console.log(`funder == owner EOA?       ${id.funderIsOwner}`);
} catch (e) {
  if (e instanceof Error && /ERR_NO_KEY/.test(String((e as { code?: unknown }).code ?? e.message))) {
    console.log('wallet key not set in .env.local — nothing to derive.');
    process.exit(1);
  }
  throw e;
}
