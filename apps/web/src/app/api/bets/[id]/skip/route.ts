import { prodDeps } from '../../../../../lib/api/prod.ts';
import { skipBet } from '../../../../../lib/api/routes.ts';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return skipBet(req, prodDeps(req), id);
}
