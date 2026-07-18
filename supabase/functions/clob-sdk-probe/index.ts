/**
 * clob-sdk-probe — THROWAWAY-WALLET diagnostic for the C46 live-post failure (EDGE-WATCH-LOOP.md).
 *
 * clob-egress-probe proved the raw ORDER endpoint is reachable from the eu-west-1-pinned runtime, yet the
 * REAL executor's postOrder still throws. The remaining suspects live inside the SDK call path itself
 * (npm:ethers@5 signing / npm:@polymarket/clob-client-v2 HTTP stack under Deno). This probe walks the
 * EXACT live.ts sequence — import → Wallet → ClobClient → createOrDeriveApiKey → createOrder (EIP-712
 * sign) → postOrder — with a WALLET GENERATED IN-FUNCTION (Wallet.createRandom(): worthless, holds no
 * funds, no allowance, tied to nothing). Every step is try/caught and reported verbatim.
 *
 * Interpretation: a THROW at any step = the Deno-runtime mechanism, caught red-handed. A clean JSON venue
 * REJECTION at postOrder (e.g. "not enough balance / allowance") = SDK + signing + transport all work,
 * and the live failure is credential/config-shaped instead.
 *
 * SAFETY: no real credential is read or used (POLY_* env untouched); the random wallet cannot fill an
 * order (no USDC, no allowance) and bids 1¢ on a weather bucket regardless. The private key of the
 * throwaway wallet is never returned or logged.
 */

const HOST = 'https://clob.polymarket.com';
const CAP = 500;

interface StepResult {
  step: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

const errStr = (e: unknown): string => {
  const base = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const stack = e instanceof Error && e.stack ? ` | ${e.stack.split('\n').slice(1, 3).join(' / ')}` : '';
  return (base + stack).slice(0, CAP);
};

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const steps: StepResult[] = [];
  const body = (await req.json().catch(() => ({}))) as { tokenID?: string };
  const tokenID = typeof body.tokenID === 'string' && body.tokenID.length > 10 ? body.tokenID : null;

  interface ProbeClient {
    createOrDeriveApiKey(): Promise<unknown>;
    createOrder(a: Record<string, unknown>, o?: Record<string, unknown>): Promise<unknown>;
    postOrder(o: unknown, t?: string): Promise<unknown>;
  }
  type EthersMod = { Wallet: { createRandom(): { address: string } } };
  type ClobMod = { ClobClient: new (opts: Record<string, unknown>) => ProbeClient };
  let ethers: EthersMod | null = null;
  let clob: ClobMod | null = null;

  try {
    ethers = (await import('npm:ethers@5')) as unknown as EthersMod;
    steps.push({ step: 'import ethers@5', ok: true });
  } catch (e) {
    steps.push({ step: 'import ethers@5', ok: false, error: errStr(e) });
  }
  try {
    clob = (await import('npm:@polymarket/clob-client-v2@1')) as unknown as ClobMod;
    steps.push({ step: 'import clob-client-v2', ok: true });
  } catch (e) {
    steps.push({ step: 'import clob-client-v2', ok: false, error: errStr(e) });
  }

  let signer: { address: string } | null = null;
  if (ethers) {
    try {
      signer = ethers.Wallet.createRandom();
      steps.push({ step: 'Wallet.createRandom', ok: true, detail: { address: signer.address } });
    } catch (e) {
      steps.push({ step: 'Wallet.createRandom', ok: false, error: errStr(e) });
    }
  }

  let client: ProbeClient | null = null;
  let creds: unknown = null;
  if (clob && signer) {
    try {
      const bootstrap = new clob.ClobClient({ host: HOST, chain: 137, signer });
      creds = await bootstrap.createOrDeriveApiKey();
      const c = (creds ?? {}) as { key?: unknown; apiKey?: unknown };
      steps.push({
        step: 'createOrDeriveApiKey (L1 auth round-trip)',
        ok: true,
        detail: { apiKeyPreview: String(c.key ?? c.apiKey ?? '').slice(0, 8) + '…' },
      });
    } catch (e) {
      steps.push({ step: 'createOrDeriveApiKey (L1 auth round-trip)', ok: false, error: errStr(e) });
    }
    try {
      // signatureType 0 (EOA): the order signature is VALID for the throwaway signer itself, so a healthy
      // path must reach the venue and come back with a clean JSON rejection (no balance/allowance).
      client = new clob.ClobClient({ host: HOST, chain: 137, signer, creds, signatureType: 0 });
      steps.push({ step: 'ClobClient (L2, sigType 0)', ok: true });
    } catch (e) {
      steps.push({ step: 'ClobClient (L2, sigType 0)', ok: false, error: errStr(e) });
    }
  }

  if (client && tokenID) {
    let order: unknown = null;
    try {
      order = await client.createOrder(
        { tokenID, price: 0.01, side: 'BUY', size: 5, feeRateBps: 0 },
        { tickSize: '0.01', negRisk: true },
      );
      steps.push({ step: 'createOrder (EIP-712 sign in Deno)', ok: true });
    } catch (e) {
      steps.push({ step: 'createOrder (EIP-712 sign in Deno)', ok: false, error: errStr(e) });
    }
    if (order != null) {
      try {
        const resp = await client.postOrder(order, 'FAK');
        steps.push({
          step: 'postOrder (the failing leg)',
          ok: true,
          detail: JSON.stringify(resp ?? null).slice(0, CAP),
        });
      } catch (e) {
        steps.push({ step: 'postOrder (the failing leg)', ok: false, error: errStr(e) });
      }
    }
  } else if (!tokenID) {
    steps.push({ step: 'createOrder/postOrder', ok: false, error: 'no tokenID supplied in request body' });
  }

  return new Response(JSON.stringify({ generatedAt: new Date().toISOString(), steps }, null, 2), {
    headers: { 'content-type': 'application/json' },
  });
});

export {}; // module scope — keeps the top-level `deno` binding from colliding with sibling probe scripts
