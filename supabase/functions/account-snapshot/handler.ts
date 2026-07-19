/**
 * account-snapshot handler (migration 0113) — the venue account read behind the /trading account overview.
 *
 * Two INDEPENDENT, individually fail-soft reads, upserted into the single-row account_snapshot table:
 *   cash  — CLOB collateral balance via the SAME credentialed client the buy-table tick builds
 *           (packages/trading/src/live.ts createClobClient — keys live only in the Edge env; this fn never
 *           logs or returns them; the client is console-redacted by construction). Missing env / an API
 *           error → cash_usd null + the reason in `note`, never a throw.
 *   marks — the PUBLIC data-api positions for POLY_FUNDER_ADDRESS (an address is not a credential):
 *           Σ currentValueUsd + count. Missing address / upstream error → nulls + note.
 *
 * BOUNDARY (CLAUDE.md §9R): read-only against the venue — this fn never places, cancels, or signs an order.
 */
import { fetchWalletPositions, type FetchJsonLike } from '../_shared/polymarket-wallet.ts';

interface DbLike {
  rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]>;
}

interface BalanceClientish {
  getBalanceAllowance?: (params: { asset_type: string }) => Promise<{ balance?: string | number } | null>;
}

export interface AccountSnapshotDeps {
  now: Date;
  fetchJson: FetchJsonLike;
  /** test seam — production passes the live createClobClient. */
  createClient?: () => Promise<BalanceClientish>;
  /** test seam — production reads Deno.env. */
  funderAddress?: string;
}

export async function accountSnapshot(
  ctx: { db: DbLike },
  deps: AccountSnapshotDeps,
): Promise<Record<string, unknown>> {
  const notes: string[] = [];

  // cash — credentialed CLOB read, entirely inside the fn (fail-soft on ANY miss)
  let cashUsd: number | null = null;
  try {
    const make =
      deps.createClient ??
      (async () => {
        const live = await import('../../../packages/trading/src/live.ts');
        return (await live.createClobClient()) as BalanceClientish;
      });
    const client = await make();
    if (typeof client.getBalanceAllowance !== 'function') {
      notes.push('cash: client has no getBalanceAllowance');
    } else {
      const ba = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      const raw = Number(ba?.balance);
      if (Number.isFinite(raw)) cashUsd = raw / 1e6; // collateral units are 1e6 (USDC/pUSD decimals)
      else notes.push('cash: balance endpoint returned no number');
    }
  } catch (e) {
    notes.push(`cash unavailable: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
  }

  // marks — public data-api positions for the funder address
  let positionsValueUsd: number | null = null;
  let nPositions: number | null = null;
  const addr =
    deps.funderAddress ??
    (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(
      'POLY_FUNDER_ADDRESS',
    ) ??
    '';
  if (!addr) {
    notes.push('positions: POLY_FUNDER_ADDRESS not set');
  } else {
    try {
      const positions = await fetchWalletPositions(deps.fetchJson, addr, { sizeThreshold: 0.1 });
      positionsValueUsd = positions.reduce((s, p) => s + (p.currentValueUsd ?? 0), 0);
      nPositions = positions.length;
    } catch (e) {
      notes.push(`positions unavailable: ${String((e as Error)?.message ?? e).slice(0, 140)}`);
    }
  }

  // DbPort is rpc-only — the write rides the service_role-only 0113 upsert RPC (throws on failure).
  await ctx.db.rpc('account_snapshot_upsert', {
    p_cash_usd: cashUsd,
    p_positions_value_usd: positionsValueUsd,
    p_n_positions: nPositions,
    p_note: notes.length > 0 ? notes.join('; ') : null,
  });

  return { cashUsd, positionsValueUsd, nPositions, notes };
}
