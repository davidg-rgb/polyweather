import { prodDeps } from '../../../../../lib/api/prod.ts';
import { approveBet } from '../../../../../lib/api/routes.ts';

// Outlive execute-bet's worst-case retries (§6.21).
export const maxDuration = 90;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return approveBet(req, prodDeps(req), id);
}
